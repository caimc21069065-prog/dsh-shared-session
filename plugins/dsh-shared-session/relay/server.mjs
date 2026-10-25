#!/usr/bin/env node
// dsh-shared-session — minimal self-hostable relay (FR-8.2).
// Zero-dependency Node HTTP server: REST for room state + SSE for live events.
// In-memory storage; rooms expire after `ttlHours` (default 24) of inactivity.
//
//   node relay/server.mjs [--port 8787] [--max-members 10]
//
// Security notes (FR-4.6 / §11):
//   - Content is NOT end-to-end encrypted; the relay can read everything.
//   - Tokens are stored/compared as SHA-256 hashes and never logged.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 8787;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_EVENTS = 5000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const RATE_LIMIT_PER_MIN = 60; // events per member token
const CLOSED_GRACE_MS = 60 * 60 * 1000; // keep closed rooms 1h for finals

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(argValue('--port', DEFAULT_PORT)) || DEFAULT_PORT;
const MAX_MEMBERS = Number(argValue('--max-members', 10)) || 10;
const DEFAULT_TTL_MS = Number(argValue('--ttl-hours', 24)) || 24;
// Optional creation auth for self-hosted instances exposed to a network:
//   --create-token <secret>  or  env RELAY_CREATE_TOKEN
const CREATE_TOKEN = argValue('--create-token', process.env.RELAY_CREATE_TOKEN || '');

const EVENT_TYPES = new Set([
  'room/meta',
  'room/mode',
  'room/closed',
  'member/join',
  'member/leave',
  'member/update',
  'member/kicked',
  'chat/user',
  'chat/side',
  'chat/rejected',
  'assistant/delta',
  'assistant/done',
  'tool/call',
  'tool/result',
  'control/approval',
  'control/approval-result'
]);
const HOST_ONLY_TYPES = new Set([
  'room/meta',
  'room/mode',
  'room/closed',
  'member/join',
  'member/leave',
  'member/update',
  'member/kicked'
]);

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const shortToken = () => crypto.randomBytes(18).toString('base64url');
// Display names travel into host-side injection as "[Name]: text" — strip
// control characters so a name cannot forge line breaks or extra prefixes.
const cleanName = s =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 80) || 'guest';

/** @type {Map<string, any>} */
const rooms = new Map();

function getRoom(id) {
  return rooms.get(id) || null;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
}

function stamps(room) {
  return { seq: room.seq, at: new Date().toISOString() };
}

function broadcast(room, type, payload, from, cid) {
  const { seq, at } = { seq: ++room.seq, at: new Date().toISOString() };
  const ev = { seq, type, payload, from, at, cid: cid || null };
  room.events.push(ev);
  room.bytes += JSON.stringify(ev).length;
  while (room.events.length > MAX_EVENTS || room.bytes > MAX_TOTAL_BYTES) {
    const dropped = room.events.shift();
    if (!dropped) break;
    room.bytes -= JSON.stringify(dropped).length;
  }
  const frame = `id: ${seq}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const member of room.members.values()) {
    for (const res of member.streams) {
      try {
        res.write(frame);
      } catch {
        member.streams.delete(res);
      }
    }
  }
  touchRoom(room);
  return ev;
}

function endStreams(room) {
  for (const member of room.members.values()) {
    for (const res of member.streams) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    member.streams.clear();
  }
}

function hostOnline(room) {
  const h = room.members.get('host');
  return Boolean(h && h.streams.size > 0);
}

function memberList(room) {
  return [...room.members.values()].map(m => ({
    memberId: m.id,
    displayName: m.name,
    role: m.role,
    viewer: Boolean(m.viewer),
    online: m.streams.size > 0,
    joinedAt: m.joinedAt
  }));
}

function roomInfo(room) {
  return {
    roomId: room.id,
    protocolVersion: PROTOCOL_VERSION,
    hostName: room.hostName,
    hostOnline: hostOnline(room),
    closed: room.closed,
    mode: room.mode,
    createdAt: new Date(room.createdAt).toISOString(),
    lastSeq: room.seq,
    members: memberList(room)
  };
}

// resolve a presented token to {kind, room, member}
function resolveToken(room, token) {
  if (!token) return null;
  const h = sha256(token);
  if (h === room.hostTokenHash) return { kind: 'host', member: room.members.get('host') };
  if (h === room.inviteTokenHash) return { kind: 'invite', member: null };
  for (const m of room.members.values()) {
    if (m.tokenHash === h) return { kind: 'member', member: m };
  }
  return null;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (!raw) return {};
  return JSON.parse(raw);
}

function rateOk(room, tokenHash) {
  const now = Date.now();
  let r = room.rate.get(tokenHash);
  if (!r || now - r.windowStart > 60000) {
    r = { windowStart: now, count: 0 };
    room.rate.set(tokenHash, r);
  }
  r.count += 1;
  return r.count <= RATE_LIMIT_PER_MIN;
}

function replayFor(room, since) {
  const events = room.events.filter(e => e.seq > since).slice(-1000);
  return { events, lastSeq: room.seq };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && u.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      name: 'dsh-shared-session-relay',
      protocolVersion: PROTOCOL_VERSION,
      rooms: rooms.size
    });
  }

  // viewer page: /r/<roomId>/<inviteToken>
  if (req.method === 'GET' && parts[0] === 'r' && parts.length >= 3) {
    const room = getRoom(parts[1]);
    if (!room || sha256(parts[2]) !== room.inviteTokenHash) return json(res, 404, { error: 'room not found' });
    const html = viewerHtml()
      .replaceAll('__ROOM_ID__', parts[1])
      .replaceAll('__INVITE_TOKEN__', parts[2]);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  // create room
  if (req.method === 'POST' && u.pathname === '/api/rooms') {
    if (CREATE_TOKEN && req.headers['x-create-token'] !== CREATE_TOKEN) {
      return json(res, 401, { error: 'create token required' });
    }
    const body = parseJsonBody(await readBody(req));
    const ver = Number(body.protocolVersion ?? PROTOCOL_VERSION);
    if (ver !== PROTOCOL_VERSION) return json(res, 400, { error: `protocol version mismatch (server v${PROTOCOL_VERSION})` });
    const roomId = 'r' + crypto.randomBytes(8).toString('base64url');
    const hostToken = shortToken();
    const inviteToken = shortToken();
    const ttlHours = Math.min(Math.max(Number(body.ttlHours) || DEFAULT_TTL_MS, 1), 24 * 7);
    const room = {
      id: roomId,
      hostName: cleanName(body.hostName),
      hostTokenHash: sha256(hostToken),
      inviteTokenHash: sha256(inviteToken),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ttlMs: ttlHours * 3600 * 1000,
      seq: 0,
      events: [],
      bytes: 0,
      members: new Map(),
      maxMembers: Math.min(Math.max(Number(body.maxMembers) || MAX_MEMBERS, 2), MAX_MEMBERS),
      closed: false,
      closedAt: null,
      mode: 'default',
      rate: new Map()
    };
    room.members.set('host', {
      id: 'host',
      name: room.hostName,
      role: 'host',
      tokenHash: room.hostTokenHash,
      viewer: false,
      streams: new Set(),
      joinedAt: Date.now()
    });
    rooms.set(roomId, room);
    broadcast(room, 'room/meta', { roomId, hostName: room.hostName, createdAt: new Date().toISOString() }, { memberId: 'host', displayName: room.hostName, role: 'host' });
    return json(res, 200, {
      roomId,
      hostToken,
      inviteToken,
      memberId: 'host',
      protocolVersion: PROTOCOL_VERSION
    });
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
    const room = getRoom(parts[2]);
    if (!room) return json(res, 404, { error: 'room not found' });
    const rest = parts.slice(3);

    // join
    if (req.method === 'POST' && rest[0] === 'join' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      if (sha256(String(body.inviteToken || '')) !== room.inviteTokenHash) {
        return json(res, 403, { error: 'invalid invite token' });
      }
      if (room.closed) return json(res, 410, { error: 'room closed' });
      if (room.members.size >= room.maxMembers) return json(res, 409, { error: 'room full' });
      const memberId = 'g-' + crypto.randomBytes(5).toString('hex');
      const memberToken = shortToken();
      const name = cleanName(body.displayName);
      room.members.set(memberId, {
        id: memberId,
        name,
        role: 'guest',
        tokenHash: sha256(memberToken),
        viewer: false,
        streams: new Set(),
        joinedAt: Date.now()
      });
      const replay = replayFor(room, 0);
      broadcast(
        room,
        'member/join',
        { memberId, displayName: name, role: 'guest' },
        { memberId: 'host', displayName: room.hostName, role: 'host' }
      );
      return json(res, 200, { memberId, token: memberToken, role: 'guest', replay, room: roomInfo(room) });
    }

    // rejoin (resume with existing token)
    if (req.method === 'POST' && rest[0] === 'rejoin' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      const t = resolveToken(room, String(body.token || ''));
      if (!t || t.kind === 'invite') return json(res, 403, { error: 'unknown token' });
      if (room.closed) return json(res, 410, { error: 'room closed' });
      const replay = replayFor(room, 0);
      return json(res, 200, { memberId: t.member?.id || 'host', role: t.member?.role || 'host', replay, room: roomInfo(room) });
    }

    // explicit leave
    if (req.method === 'POST' && rest[0] === 'leave' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      const t = resolveToken(room, String(body.token || ''));
      if (!t || t.kind !== 'member') return json(res, 403, { error: 'unknown token' });
      for (const s of t.member.streams) {
        try {
          s.end();
        } catch {
          /* ignore */
        }
      }
      room.members.delete(t.member.id);
      broadcast(
        room,
        'member/leave',
        { memberId: t.member.id, displayName: t.member.name },
        { memberId: 'host', displayName: room.hostName, role: 'host' }
      );
      return json(res, 200, { ok: true });
    }

    // room info
    if (req.method === 'GET' && rest.length === 0) {
      const t = resolveToken(room, u.searchParams.get('token') || '');
      if (!t) return json(res, 403, { error: 'invalid token' });
      return json(res, 200, roomInfo(room));
    }

    // poll events
    if (req.method === 'GET' && rest[0] === 'events' && rest.length === 1) {
      const t = resolveToken(room, u.searchParams.get('token') || '');
      if (!t) return json(res, 403, { error: 'invalid token' });
      const since = Number(u.searchParams.get('since') || 0) || 0;
      const limit = Math.min(Number(u.searchParams.get('limit') || 200) || 200, 1000);
      const events = room.events.filter(e => e.seq > since).slice(0, limit);
      return json(res, 200, { events, lastSeq: room.seq, closed: room.closed });
    }

    // SSE stream
    if (req.method === 'GET' && rest[0] === 'stream' && rest.length === 1) {
      const t = resolveToken(room, u.searchParams.get('token') || '');
      if (!t) {
        return json(res, 403, { error: 'invalid token' });
      }
      if (room.closed) {
        return json(res, 410, { error: 'room closed' });
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering': 'no'
      });
      const since = Number(u.searchParams.get('since') || 0) || 0;
      for (const ev of room.events.filter(e => e.seq > since).slice(-1000)) {
        res.write(`id: ${ev.seq}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      if (t.member) {
        t.member.streams.add(res);
        t.member.lastSeen = Date.now();
      }
      touchRoom(room);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        if (t.member) t.member.streams.delete(res);
      });
      return;
    }

    // append event
    if (req.method === 'POST' && rest[0] === 'events' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      const t = resolveToken(room, String(body.token || ''));
      if (!t) return json(res, 403, { error: 'invalid token' });
      if (t.kind === 'invite') return json(res, 403, { error: 'read-only token' });
      const type = String(body.type || '');
      if (!EVENT_TYPES.has(type)) return json(res, 400, { error: `unknown event type: ${type}` });
      if (HOST_ONLY_TYPES.has(type) && t.kind !== 'host') return json(res, 403, { error: 'host-only event' });
      const payloadStr = JSON.stringify(body.payload ?? {});
      if (payloadStr.length > MAX_EVENT_BYTES) return json(res, 413, { error: 'payload too large' });
      // Rate-limit guest chat only (§11): hosts legitimately stream bursts of
      // assistant deltas and must never be throttled.
      if (
        t.member.role === 'guest' &&
        (type === 'chat/user' || type === 'chat/side') &&
        !rateOk(room, t.member.tokenHash)
      ) {
        return json(res, 429, { error: 'rate limited' });
      }
      if (room.closed && type !== 'control/approval-result') return json(res, 410, { error: 'room closed' });

      if (type === 'chat/user' && t.member.role === 'guest') {
        if (t.member.viewer) return json(res, 403, { error: 'viewer-only member' });
        if (!hostOnline(room)) {
          return json(res, 409, { error: 'host-offline', message: 'Host is offline; message rejected (FR-7.3 default).' });
        }
      }
      const from = { memberId: t.member.id, displayName: t.member.name, role: t.member.role };
      const ev = broadcast(room, type, body.payload ?? {}, from, body.cid);
      return json(res, 200, { seq: ev.seq });
    }

    // host control
    if (req.method === 'POST' && rest[0] === 'control' && rest.length === 1) {
      const body = parseJsonBody(await readBody(req));
      const t = resolveToken(room, String(body.token || ''));
      if (!t || t.kind !== 'host') return json(res, 403, { error: 'host-only' });
      const action = String(body.action || '');
      const hostFrom = { memberId: 'host', displayName: room.hostName, role: 'host' };
      switch (action) {
        case 'close-room': {
          room.closed = true;
          room.closedAt = Date.now();
          broadcast(room, 'room/closed', {}, hostFrom);
          endStreams(room); // guests receive the close event, then reconnect attempts get 410
          return json(res, 200, { ok: true });
        }
        case 'set-room-mode': {
          const mode = body.args?.mode === 'ask-all' ? 'ask-all' : 'default';
          room.mode = mode;
          broadcast(room, 'room/mode', { mode }, hostFrom);
          return json(res, 200, { ok: true, mode });
        }
        case 'set-viewer': {
          const memberId = String(body.args?.memberId || '');
          const m = room.members.get(memberId);
          if (!m || m.role === 'host') return json(res, 404, { error: 'member not found' });
          m.viewer = Boolean(body.args?.viewer);
          broadcast(room, 'member/update', { memberId, viewer: m.viewer }, hostFrom);
          return json(res, 200, { ok: true, viewer: m.viewer });
        }
        case 'kick': {
          const memberId = String(body.args?.memberId || '');
          const m = room.members.get(memberId);
          if (!m || m.role === 'host') return json(res, 404, { error: 'member not found' });
          for (const s of m.streams) {
            try {
              s.end();
            } catch {
              /* ignore */
            }
          }
          room.members.delete(memberId);
          broadcast(room, 'member/kicked', { memberId, displayName: m.name }, hostFrom);
          return json(res, 200, { ok: true });
        }
        default:
          return json(res, 400, { error: `unknown action: ${action}` });
      }
    }

    // delete room (host)
    if (req.method === 'DELETE' && rest.length === 0) {
      const t = resolveToken(room, u.searchParams.get('token') || '');
      if (!t || t.kind !== 'host') return json(res, 403, { error: 'host-only' });
      endStreams(room);
      rooms.delete(room.id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'not found' });
}

function viewerHtml() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.html');
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// Sweeper + server bootstrap
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const expired =
      (room.closed && room.closedAt && now - room.closedAt > CLOSED_GRACE_MS) ||
      now - room.lastActivity > room.ttlMs;
    if (expired) {
      endStreams(room); // else heartbeats/sockets leak on deleted rooms
      rooms.delete(id);
    }
  }
}, 30000).unref();

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err?.code === 413 ? 413 : err instanceof SyntaxError ? 400 : 500;
    try {
      json(res, status, { error: err?.message || 'internal error' });
    } catch {
      /* ignore */
    }
  });
});

server.on('error', err => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[relay] port ${PORT} already in use — is another relay running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] dsh-shared-session relay v${PROTOCOL_VERSION} listening on http://127.0.0.1:${PORT}`);
  console.log('[relay] WARNING: content is not end-to-end encrypted; the relay can read room traffic.');
});
