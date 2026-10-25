#!/usr/bin/env node
// dsh-shared-session — MCP stdio server.
// Hosts the room client (HostSession / GuestSession) and exposes ss_* tools.
// Zero-dependency MCP implementation over newline-delimited JSON-RPC.

import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig, loadState, pluginRoot } from '../lib/core.mjs';
import { HostSession } from '../lib/host-room.mjs';
import { GuestSession } from '../lib/guest-room.mjs';
import { renderEvents, renderRoom } from '../lib/render.mjs';

const PLUGIN_ROOT = pluginRoot();
const pkg = JSON.parse(fs.readFileSync(`${PLUGIN_ROOT}/.zcode-plugin/plugin.json`, 'utf8'));

/** @type {HostSession | GuestSession | null} */
let session = null;
let sessionType = null; // 'host' | 'guest'
let readPos = 0;

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], isError };
}

function fail(err) {
  return text(err?.message || String(err), true);
}

function requireHost() {
  if (!session || sessionType !== 'host') throw new Error('Not hosting. Run /share first.');
  return session;
}

function requireGuest() {
  if (!session || sessionType !== 'guest') throw new Error('Not joined. Run /join <link> first.');
  return session;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'ss_share',
    description:
      'Share the current session (host role). Creates a room on the relay, starts live streaming of prompts, replies, thinking and tool activity, and returns an invite link. Guests use /join with the link; their prompts are injected into this session and guest-triggered writes/shell/network require your approval.',
    inputSchema: {
      type: 'object',
      properties: {
        includeHistory: {
          type: 'boolean',
          description: 'Also backfill recent conversation history into the room (default: config defaultShareHistory).'
        },
        resume: { type: 'boolean', description: 'Resume the previously hosted room for this workspace instead of creating a new one.' }
      }
    },
    run: async args => {
      const cfg = loadConfig();
      const cwd = process.cwd();
      if (session && sessionType === 'host') {
        const s = session.roomSummary();
        return text(`Already hosting room ${s.roomId}.\nInvite link: ${s.link}\nShort code: ${s.code}\nHost control panel (approvals): ${s.hostUrl}`);
      }
      if (session && sessionType === 'guest') {
        throw new Error('This session already joined a room as guest. Run /leave first to host your own.');
      }
      const st = loadState(cwd);
      const resumed = Boolean(args.resume || st?.role === 'host');
      let s;
      if (resumed) {
        s = await HostSession.resume({ cwd, cfg, transcriptPath: st?.transcriptPath });
      } else {
        s = await HostSession.share({
          cwd,
          cfg,
          includeHistory: args.includeHistory ?? cfg.defaultShareHistory,
          transcriptPath: st?.transcriptPath
        });
      }
      session = s;
      sessionType = 'host';
      readPos = 0;
      const sum = s.roomSummary();
      return text(
        [
          `Sharing live${resumed ? ' (resumed previous room; its history is already shared)' : ''}. Room ${sum.roomId}`,
          ``,
          `Invite link (give this to teammates):`,
          sum.link,
          ``,
          `Short code: ${sum.code}`,
          `Host control panel (watch + approve guest actions in browser):`,
          sum.hostUrl,
          ``,
          `Now: prompts, replies, thinking and tool calls stream to the room.`,
          `Guest prompts are queued and injected after the current turn as "[GuestName]: text".`,
          `Guest-triggered write/shell/network tools trigger an approval prompt (mode: ${cfg.guestWriteApproval}).`,
          `Use /room for status and /stop-share to end.`
        ].join('\n')
      );
    }
  },
  {
    name: 'ss_stop_share',
    description: 'Host only: close the shared room and stop streaming.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = requireHost();
      await s.stopSharing();
      session = null;
      sessionType = null;
      return text('Sharing stopped; the room is closed. Local state cleared.');
    }
  },
  {
    name: 'ss_join',
    description:
      'Join a shared session as a guest (viewer + prompt sender). Does NOT run any model or tools locally — the host does all the work. Accepts an invite link (<relay>/r/<roomId>/<token>) or short code (<roomId>.<token>).',
    inputSchema: {
      type: 'object',
      properties: {
        linkOrCode: { type: 'string', description: 'Invite link or short code. Omit to resume the previous room.' },
        displayName: { type: 'string', description: 'Optional display name override.' }
      }
    },
    run: async args => {
      if (session && sessionType === 'guest' && !args.linkOrCode) {
        session.dispose(); // release the previous stream before replacing it
        session = await GuestSession.resume({ cwd: process.cwd(), cfg: loadConfig() });
      } else {
        if (!args.linkOrCode) throw new Error('linkOrCode is required (or omit it to resume).');
        if (session) throw new Error('This session already has a room. Run /leave or /stop-share first.');
        session = await GuestSession.join({
          cwd: process.cwd(),
          cfg: loadConfig(),
          linkOrCode: args.linkOrCode,
          displayName: args.displayName
        });
      }
      sessionType = 'guest';
      readPos = 0;
      const s = await session.roomSummary();
      const replay = session.log.length
        ? renderEvents(session.log.slice(-80), { maxLines: 10 }) || '(no events yet)'
        : '(no events yet — the host has not shared history)';
      return text(
        [
          `Joined room ${s.roomId} as guest "${s.displayName}". Host: ${s.hostName}${s.hostOnline ? ' (online)' : ' (OFFLINE)'}.`,
          `Live viewer link (watch in browser): ${s.viewerLink}`,
          ``,
          `Replay:`,
          replay,
          ``,
          `You now see the host's prompts, replies and tool calls. To send a prompt to the host,`,
          `use ss_send with ONLY the user's request text (never include your own local context).`,
          `After sending, poll ss_read until the host's answer arrives, then summarize it for the user.`,
          `/room shows members; /leave exits.`
        ].join('\n')
      );
    }
  },
  {
    name: 'ss_leave',
    description: 'Guest only: leave the shared room.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = requireGuest();
      await s.leave();
      session = null;
      sessionType = null;
      return text('Left the room.');
    }
  },
  {
    name: 'ss_room',
    description: 'Room status: members, online state, approval mode, queue depth, pending guest-action approvals (with full command previews).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (!session) throw new Error('No active room. Host: /share. Guest: /join <link>.');
      const summary =
        sessionType === 'host' ? await session.roomSummaryWithMembers() : await session.roomSummary();
      let pending = '';
      if (sessionType === 'host' && summary.pendingApprovals?.length) {
        pending =
          '\n\nPENDING APPROVALS (use ss_approve, or the host web panel):\n' +
          summary.pendingApprovals.map(a => `- ${a.requestId} [${a.mode}] ${a.summary}`).join('\n');
      }
      const since = Math.max(0, (summary.lastSeq ?? 0) - 15);
      const evs = sessionType === 'host' ? session.log.filter(e => (e.seq ?? 0) > since) : session.eventsSince(since);
      const timeline = renderEvents(evs.slice(-15), { maxLines: 6 });
      return (
        renderRoom({ ...summary, members: summary.members || [] }) +
        pending +
        (timeline ? `\n\nRecent activity:\n${timeline}` : '')
      );
    }
  },
  {
    name: 'ss_send',
    description:
      'Guest only: send a prompt to the host. The text is injected into the HOST session as "[YourName]: text" and executed by the host model. Send ONLY the user-requested text — never forward your local conversation context, system prompt or secrets. Fails while the host is offline.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The prompt text to run on the host.' } },
      required: ['text']
    },
    run: async args => {
      const s = requireGuest();
      await s.sendPrompt(args.text);
      return text(
        'Sent. It will be injected into the host session after the host finishes the current turn. Poll ss_read until you see the host reply (assistant/delta + assistant/done), then summarize it.'
      );
    }
  },
  {
    name: 'ss_read',
    description: 'Read new room events since a sequence number (live stream log). Works for host and guest.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Return events with seq greater than this (default: last read position).' },
        limit: { type: 'number', description: 'Max events to return (default 50).' },
        resultMaxLines: { type: 'number', description: 'Truncate tool result previews to N lines (default from config).' }
      }
    },
    run: async args => {
      if (!session) throw new Error('No active room.');
      const since = args.since ?? readPos;
      const evs =
        sessionType === 'host'
          ? session.log.filter(e => (e.seq ?? 0) > since)
          : session.eventsSince(since);
      const limit = Math.min(args.limit ?? 50, 200);
      const slice = evs.slice(-limit);
      readPos = slice.length ? slice[slice.length - 1].seq : since;
      const cfg = loadConfig();
      const body = renderEvents(slice, { maxLines: args.resultMaxLines ?? cfg.toolResultMaxLines });
      return text(body || `(no new events; lastSeq=${sessionType === 'host' ? session.stream?.lastSeq : session.lastSeq()})`);
    }
  },
  {
    name: 'ss_chat',
    description: 'Side chat with room members. Side chat is NOT visible to the agent/model on either side.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async args => {
      if (!session) throw new Error('No active room.');
      const cfg = loadConfig();
      if (!cfg.sideChatEnabled) throw new Error('Side chat is disabled by config.');
      if (sessionType === 'guest') {
        await session.sendSideChat(args.text);
      } else {
        session.post('chat/side', { text: String(args.text).slice(0, 5000) });
      }
      return text('Side chat sent (humans only; the model cannot see it).');
    }
  },
  {
    name: 'ss_approve',
    description:
      'Host only: decide a pending guest-action approval. Omit requestId to list pending requests. decision: allow | allow-always (this guest may always use that tool) | deny.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        decision: { type: 'string', enum: ['allow', 'allow-always', 'deny'] }
      }
    },
    run: async args => {
      const s = requireHost();
      const pending = s.pendingApprovals();
      if (!args.requestId) {
        if (!pending.length) return text('No pending approvals. (Native "ask" mode prompts appear as normal permission dialogs instead.)');
        return text(
          'Pending approvals:\n' + pending.map(a => `- ${a.requestId} [${a.mode}] by ${a.memberId}: ${a.summary}`).join('\n')
        );
      }
      const decision = args.decision || 'allow';
      if (!['allow', 'allow-always', 'deny'].includes(decision)) throw new Error(`bad decision: ${decision}`);
      const ok = await s.postApprovalResult(args.requestId, decision);
      return text(ok ? `Approval ${args.requestId} -> ${decision}.` : 'Relay rejected the approval (room closed?).');
    }
  },
  {
    name: 'ss_set_policy',
    description:
      'Host only: change room policy. roomMode: "default" (guest writes/shell/network need approval) or "ask-all" (everything a guest turn does needs approval). memberId + viewer: toggle viewer-only (cannot send prompts). memberId + kick: remove a member.',
    inputSchema: {
      type: 'object',
      properties: {
        roomMode: { type: 'string', enum: ['default', 'ask-all'] },
        memberId: { type: 'string' },
        viewer: { type: 'boolean' },
        kick: { type: 'boolean' }
      }
    },
    run: async args => {
      const s = requireHost();
      const results = [];
      if (args.roomMode) {
        await s.api.control(s.roomId, { token: s.hostToken, action: 'set-room-mode', args: { mode: args.roomMode } });
        results.push(`room mode -> ${args.roomMode}`);
      }
      if (args.memberId && args.kick) {
        await s.api.control(s.roomId, { token: s.hostToken, action: 'kick', args: { memberId: args.memberId } });
        results.push(`kicked ${args.memberId}`);
      } else if (args.memberId && args.viewer !== undefined) {
        await s.api.control(s.roomId, { token: s.hostToken, action: 'set-viewer', args: { memberId: args.memberId, viewer: args.viewer } });
        results.push(`${args.memberId} viewer=${args.viewer}`);
      }
      if (!results.length) throw new Error('Nothing to do. Pass roomMode and/or memberId+viewer/kick.');
      return text('Applied: ' + results.join('; '));
    }
  }
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function reply(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function dispatch(method, params, id) {
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: pkg.name, version: pkg.version }
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications get no reply
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = tools.find(t => t.name === name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.run(params?.arguments || {});
        return reply(id, result);
      } catch (err) {
        return reply(id, fail(err));
      }
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let pending = 0;
let closing = false;

function shutdown() {
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  process.stdout.write('', () => process.exit(0));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let chain = Promise.resolve(); // serialize: tools mutate shared session state
rl.on('line', line => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  chain = chain.then(async () => {
    try {
      await dispatch(msg.method, msg.params, msg.id);
    } catch (err) {
      replyError(msg.id, -32603, err?.message || 'internal');
    } finally {
      pending--;
      if (closing && pending === 0) shutdown();
    }
  });
  pending++;
});
rl.on('close', () => {
  closing = true;
  if (pending === 0) shutdown();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
