// dsh-shared-session — Host session: event tap, guest queue, approval gate.
// The host process is authoritative: all tool execution and permission
// enforcement happen here (requirements §3.1–3.2, §7.2).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  INJECT_MARKER_PREFIX,
  PROTOCOL_VERSION,
  RelayStream,
  buildInviteLink,
  isDangerousTool,
  newId,
  pluginRoot,
  relayApi,
  resolveDisplayName,
  saveState,
  clearState,
  loadState,
  sleep
} from './core.mjs';

function clip(s, max) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function clipLines(s, maxLines, maxChars = 32000) {
  const lines = String(s ?? '').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (lines.length > maxLines) out += `\n… (${lines.length - maxLines} more lines)`;
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}

function isLoopback(relayUrl) {
  try {
    const h = new URL(relayUrl).hostname;
    return ['127.0.0.1', 'localhost', '::1'].includes(h);
  } catch {
    return false;
  }
}

async function ensureLocalRelay(cfg) {
  const api = relayApi(cfg.relayUrl);
  const h = await api.health().catch(() => null);
  if (h?.ok) return;
  let port = cfg.relayPort;
  try {
    const u = new URL(cfg.relayUrl);
    if (u.port) port = Number(u.port);
  } catch {
    /* keep default */
  }
  const script = path.join(pluginRoot(), 'relay', 'server.mjs');
  const child = spawn(process.execPath, [script, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 24; i++) {
    await sleep(300);
    const ok = (await api.health().catch(() => null))?.ok;
    if (ok) return;
  }
  throw new Error(`Could not start a local relay on port ${port}. Start one manually: node "${script}" --port ${port}`);
}

export class HostSession {
  /**
   * @param {object} o
   * @param {object} o.cfg      resolved config
   * @param {string} o.cwd      workspace directory (state key)
   * @param {string} o.relayUrl
   * @param {string} o.roomId
   * @param {string} o.hostToken
   * @param {string} o.inviteToken
   * @param {string} o.memberId ('host')
   * @param {string} o.displayName
   * @param {number} [o.since]  resume from seq
   * @param {string} [o.transcriptPath]
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.cwd = o.cwd;
    this.relayUrl = o.relayUrl;
    this.roomId = o.roomId;
    this.hostToken = o.hostToken;
    this.inviteToken = o.inviteToken;
    this.memberId = o.memberId || 'host';
    this.displayName = o.displayName;
    this.transcriptPath = o.transcriptPath || null;
    this.since = o.since ?? 0;

    this.api = relayApi(o.relayUrl);
    this.stream = null;
    this.controlSrv = null;
    this.controlPort = 0;
    this.secret = newId();
    this.disposed = false;

    this.queue = []; // queued guest chat/user events (FR-3.2)
    this.activeGuestTurn = false;
    this.currentGuestMemberId = null;
    this.currentGuestName = null;
    this.approvals = new Map(); // requestId -> {resolve, timer, summary, memberId, displayName, mode, at}
    this.alwaysAllowed = new Set(); // `${memberId}|${toolName}` (FR-4.2)
    this.viewerIds = new Set();
    this.callQueues = new Map(); // toolName -> [callId] FIFO (result correlation)
    this.postChain = Promise.resolve(); // serialize event POSTs: relay assigns seq by arrival
    this.log = []; // recent room events (received + sent)
    this.logSeqs = new Set();
    this.sideLog = [];
    this.roomClosed = false;
    this.roomMode = 'default';
    this.members = [];
    this.hostOnline = true;
    this.tailTimer = null;
    this.tailPath = null;
    this.tailOffset = undefined;
    this.tailPartial = '';
  }

  // -- lifecycle ------------------------------------------------------------

  static async share({ cwd, cfg, includeHistory, transcriptPath }) {
    const api = relayApi(cfg.relayUrl);
    let health = await api.health().catch(() => null);
    if (!health?.ok && cfg.autoStartRelay && isLoopback(cfg.relayUrl)) {
      await ensureLocalRelay(cfg);
      health = await api.health().catch(() => null);
    }
    if (!health?.ok) {
      throw new Error(
        `Relay unreachable at ${cfg.relayUrl}. Start the bundled relay: node "<plugin>/relay/server.mjs" --port 8787, ` +
          `or set relayUrl in ~/.dsh-shared-session/config.json.`
      );
    }
    const ver = Number(health.data?.protocolVersion ?? 0);
    if (ver !== PROTOCOL_VERSION) {
      throw new Error(`Relay protocol v${ver} incompatible with client v${PROTOCOL_VERSION}. Update relay/client.`);
    }
    const displayName = resolveDisplayName(cfg);
    const created = await api.createRoom(
      {
        hostName: displayName,
        ttlHours: cfg.roomTtlHours,
        protocolVersion: PROTOCOL_VERSION,
        maxMembers: cfg.maxMembers
      },
      cfg.relayCreateToken ? { 'x-create-token': cfg.relayCreateToken } : {}
    );
    if (!created.ok) {
      const detail = created.data?.error ? ` (${created.data.error})` : '';
      throw new Error(`Relay refused to create room: HTTP ${created.status}${detail}`);
    }
    const { roomId, hostToken, inviteToken, memberId } = created.data;
    const session = new HostSession({
      cwd,
      cfg,
      relayUrl: cfg.relayUrl,
      roomId,
      hostToken,
      inviteToken,
      memberId: memberId || 'host',
      displayName,
      transcriptPath
    });
    await session.start();
    if (includeHistory) await session.shareHistory().catch(() => {});
    session.persistState();
    return session;
  }

  static async resume({ cwd, cfg, transcriptPath }) {
    const st = loadState(cwd);
    if (!st || st.role !== 'host') throw new Error('No hosted room found for this workspace. Use /share first.');
    const api = relayApi(st.relayUrl);
    const r = await api.rejoinRoom(st.roomId, { token: st.roomToken }).catch(() => null);
    if (!r?.ok) {
      clearState(cwd);
      throw new Error('Previous room is gone (expired or relay restarted). Start a new one with /share.');
    }
    const session = new HostSession({
      cwd,
      cfg,
      relayUrl: st.relayUrl,
      roomId: st.roomId,
      hostToken: st.roomToken,
      inviteToken: st.inviteToken,
      memberId: st.memberId || 'host',
      displayName: st.displayName,
      since: st.lastSeq ?? 0,
      transcriptPath: transcriptPath || st.transcriptPath
    });
    if (Array.isArray(r.data?.replay?.events)) {
      for (const ev of r.data.replay.events) session._logEvent(ev);
    }
    await session.start();
    session.persistState();
    return session;
  }

  async start() {
    await this._startControl();
    this.stream = new RelayStream({
      relayUrl: this.relayUrl,
      roomId: this.roomId,
      token: this.hostToken,
      since: this.since,
      onEvent: ev => this._onRoomEvent(ev),
      onStatus: s => {
        this.hostOnline = s === 'connected';
      }
    });
    this.stream.start();
    if (this.transcriptPath) this._ensureTail();
  }

  persistState() {
    saveState(this.cwd, {
      role: 'host',
      protocolVersion: PROTOCOL_VERSION,
      relayUrl: this.relayUrl,
      roomId: this.roomId,
      roomToken: this.hostToken,
      inviteToken: this.inviteToken,
      memberId: this.memberId,
      displayName: this.displayName,
      lastSeq: this.stream ? this.stream.lastSeq : this.since,
      transcriptPath: this.transcriptPath,
      controlPort: this.controlPort,
      controlSecret: this.secret,
      createdAt: new Date().toISOString()
    });
  }

  get link() {
    return buildInviteLink(this.relayUrl, this.roomId, this.inviteToken);
  }

  get code() {
    return `${this.roomId}.${this.inviteToken}`;
  }

  get hostUrl() {
    return `${this.link}?host=${encodeURIComponent(this.hostToken)}`;
  }

  // -- control HTTP server (hook bridge) ------------------------------------

  async _startControl() {
    this.controlSrv = http.createServer((req, res) => {
      this._onControl(req, res).catch(() => {
        try {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.controlSrv.once('error', reject);
      this.controlSrv.listen(0, '127.0.0.1', resolve);
    });
    this.controlPort = this.controlSrv.address().port;
  }

  async _onControl(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'host', roomId: this.roomId }));
      return;
    }
    const m = req.url.match(/^\/hook\/(\w+)$/);
    if (!m || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512 * 1024) break;
    }
    let payload = {};
    let secret = '';
    try {
      const parsed = JSON.parse(body || '{}');
      payload = parsed.payload || {};
      secret = parsed.secret || '';
    } catch {
      /* ignore */
    }
    if (secret !== this.secret) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad secret' }));
      return;
    }
    const handler = {
      userPromptSubmit: () => this.handleUserPromptSubmit(payload),
      preToolUse: () => this.handlePreToolUse(payload),
      postToolUse: () => this.handlePostToolUse(payload),
      stop: () => this.handleStop(payload),
      sessionEnd: () => this.handleSessionEnd(payload)
    }[m[1]];
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    const result = (await handler()) || {};
    if (!this.disposed) this.persistState();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // -- hook handlers (called from hooks/hook.mjs via control server) --------

  handleUserPromptSubmit(payload) {
    if (payload?.transcript_path) {
      this.transcriptPath = payload.transcript_path;
      this._ensureTail();
    }
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
    if (prompt.includes(INJECT_MARKER_PREFIX)) {
      // echo of our own guest-message injection — keep guest-turn attribution
      this.activeGuestTurn = true;
      return {};
    }
    this.activeGuestTurn = false;
    this.currentGuestMemberId = null;
    if (prompt) this.post('chat/user', { text: clip(prompt, 20000) });
    return {};
  }

  async handlePreToolUse(payload) {
    const name = payload?.tool_name || 'unknown';
    let argsPreview;
    try {
      argsPreview = clip(JSON.stringify(payload?.tool_input ?? {}), 2000);
    } catch {
      argsPreview = clip(String(payload?.tool_input), 2000);
    }
    const callId = payload?.tool_use_id || payload?.tool_call_id || newId();
    let q = this.callQueues.get(name);
    if (!q) {
      q = [];
      this.callQueues.set(name, q);
    }
    q.push(callId);
    this.post('tool/call', { name, argsPreview, callId });

    if (!this.activeGuestTurn || this.roomClosed) return { decision: 'allow' };
    if (this.cfg.guestWriteApproval === 'allow-all') return { decision: 'allow' };

    const guestId = this.currentGuestMemberId || 'guest';
    const guestName = this.currentGuestName || guestId;
    const dangerous = isDangerousTool(name);
    if (!dangerous && this.roomMode !== 'ask-all') return { decision: 'allow' }; // FR-4.3
    if (this.alwaysAllowed.has(`${guestId}|${name}`)) return { decision: 'allow' };

    const summary = `${name} ${argsPreview}`;
    if (this.cfg.guestWriteApproval === 'ask') {
      // Native host permission dialog shows the full command/path preview.
      this.post('control/approval', {
        requestId: callId,
        summary,
        memberId: guestId,
        displayName: guestName,
        mode: 'native',
        timeoutMs: 0
      });
      return { decision: 'ask' };
    }

    // 'relay' mode: freeze this tool call until the host decides
    // (web host panel or ss_approve). Timeout -> deny (FR-4.5).
    const requestId = newId();
    this.post('control/approval', {
      requestId,
      summary,
      memberId: guestId,
      displayName: guestName,
      mode: 'relay',
      timeoutMs: this.cfg.approvalTimeoutMs
    });
    const decision = await this._waitApproval(requestId, this.cfg.approvalTimeoutMs, {
      summary,
      memberId: guestId,
      displayName: guestName,
      mode: 'relay'
    });
    if (decision === 'allow' || decision === 'allow-always') {
      if (decision === 'allow-always') this.alwaysAllowed.add(`${guestId}|${name}`);
      return { decision: 'allow' };
    }
    const idx = q.indexOf(callId);
    if (idx >= 0) q.splice(idx, 1); // denied calls never reach PostToolUse
    const reason = `Denied by host: ${name} was blocked (explicit deny or approval timeout) — shared-session`;
    this.post('tool/result', { name, callId, ok: false, preview: reason });
    return { decision: 'deny', reason };
  }

  handlePostToolUse(payload) {
    const name = payload?.tool_name || 'unknown';
    const resp = payload?.tool_response;
    let text;
    if (typeof resp === 'string') text = resp;
    else {
      try {
        text = JSON.stringify(resp);
      } catch {
        text = String(resp);
      }
    }
    const q = this.callQueues.get(name) || [];
    let callId;
    const hinted = payload?.tool_use_id || payload?.tool_call_id;
    if (hinted && q.includes(hinted)) {
      callId = hinted;
      q.splice(q.indexOf(hinted), 1);
    } else {
      callId = q.shift(); // FIFO fallback for clients without tool_use_id
    }
    this.post('tool/result', {
      name,
      callId,
      ok: true,
      preview: clipLines(text, this.cfg.toolResultMaxLines)
    });
    return {};
  }

  handleStop() {
    this.post('assistant/done', {});
    const msgs = this.queue.splice(0, this.queue.length);
    if (msgs.length) {
      this.activeGuestTurn = true;
      const last = msgs[msgs.length - 1];
      this.currentGuestMemberId = last.from?.memberId || null;
      this.currentGuestName = last.from?.displayName || null;
      const header =
        `[shared-session] Guest message(s) arrived in room ${this.roomId}. ` +
        `Treat each line below as a user message from that guest and act on it; ` +
        `their requested actions still go through normal permission rules:`;
      const body = msgs.map(m => `[${m.from?.displayName || 'Guest'}]: ${m.payload?.text ?? ''}`).join('\n');
      const marker = `${INJECT_MARKER_PREFIX}${msgs.map(m => m.cid || '').join(',')}-->`;
      return { inject: true, reason: `${header}\n\n${body}\n\n${marker}` };
    }
    this.activeGuestTurn = false;
    this.currentGuestMemberId = null;
    return { inject: false };
  }

  handleSessionEnd() {
    this.dispose();
    return {};
  }

  // -- relay interactions ----------------------------------------------------

  post(type, payload, cid) {
    // Broadcasts are serialized: the relay assigns seq by arrival order, so
    // concurrent fetches would scramble event order (history backfill, batched
    // assistant deltas). Fire-and-forget for callers; failures are dropped.
    const c = cid || newId();
    const p = this.postChain.then(() =>
      this.api.postEvent(this.roomId, { token: this.hostToken, type, payload, cid: c })
    );
    this.postChain = p.then(
      r => {
        if (r.ok && r.data?.seq != null) {
          this._logEvent({
            seq: r.data.seq,
            type,
            payload,
            from: { memberId: this.memberId, displayName: this.displayName, role: 'host' },
            at: new Date().toISOString(),
            cid: c
          });
        }
      },
      () => {}
    );
    return c;
  }

  async postApprovalResult(requestId, decision) {
    // Routed through postChain to preserve ordering with the matching
    // control/approval event.
    const p = this.postChain.then(() =>
      this.api.postEvent(this.roomId, {
        token: this.hostToken,
        type: 'control/approval-result',
        payload: { requestId, decision }
      })
    );
    this.postChain = p.then(() => {}, () => {});
    const r = await p.catch(() => null);
    return Boolean(r?.ok);
  }

  _waitApproval(requestId, timeoutMs, meta = {}) {
    return new Promise(resolve => {
      const entry = { resolve, timer: null, ...meta, at: new Date().toISOString() };
      entry.timer = setTimeout(() => {
        this.approvals.delete(requestId);
        resolve('deny');
      }, Math.max(timeoutMs, 1000));
      this.approvals.set(requestId, entry);
    });
  }

  async stopSharing() {
    await this.api
      .control(this.roomId, { token: this.hostToken, action: 'close-room' })
      .catch(() => {});
    this.dispose();
    clearState(this.cwd);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.stop();
    if (this.tailTimer) clearInterval(this.tailTimer);
    try {
      this.controlSrv?.close();
    } catch {
      /* ignore */
    }
    for (const [, w] of this.approvals) {
      clearTimeout(w.timer);
      w.resolve('deny');
    }
    this.approvals.clear();
    if (this.stream) this.persistState();
  }

  // -- room event intake ------------------------------------------------------

  _logEvent(ev) {
    if (ev.seq != null) {
      if (this.logSeqs.has(ev.seq)) return;
      this.logSeqs.add(ev.seq);
    }
    this.log.push(ev);
    if (this.log.length > 2000) {
      const drop = this.log.splice(0, this.log.length - 2000);
      for (const d of drop) this.logSeqs.delete(d.seq);
    }
  }

  _onRoomEvent(ev) {
    this._logEvent(ev);
    const p = ev.payload || {};
    switch (ev.type) {
      case 'chat/user':
        if (ev.from?.role === 'guest') {
          if (ev.from.memberId && this.viewerIds.has(ev.from.memberId)) {
            this.post('chat/rejected', { reason: `${ev.from.displayName} is viewer-only` });
          } else if (this.queue.length >= this.cfg.queueCap) {
            this.post('chat/rejected', { reason: 'guest queue full' });
          } else {
            this.queue.push(ev);
          }
        }
        break;
      case 'chat/side':
        this.sideLog.push(ev);
        if (this.sideLog.length > 500) this.sideLog.splice(0, this.sideLog.length - 500);
        break;
      case 'control/approval-result': {
        const w = this.approvals.get(p.requestId);
        if (w) {
          clearTimeout(w.timer);
          this.approvals.delete(p.requestId);
          w.resolve(p.decision);
        }
        break;
      }
      case 'room/mode':
        this.roomMode = p.mode || 'default';
        break;
      case 'room/closed':
        this.roomClosed = true;
        break;
      case 'member/update':
        if (p.viewer !== undefined && p.memberId) {
          if (p.viewer) this.viewerIds.add(p.memberId);
          else this.viewerIds.delete(p.memberId);
        }
        break;
      case 'member/kicked':
        if (p.memberId === this.memberId) this.dispose();
        break;
      case 'member/join':
      case 'member/leave':
      default:
        break;
    }
  }

  // -- transcript tail (FR-2.1 assistant text + reasoning streaming) ----------

  _ensureTail() {
    if (!this.transcriptPath || this.disposed) return;
    if (this.tailPath !== this.transcriptPath) {
      // new/rotated transcript file: restart from its current end
      this.tailPath = this.transcriptPath;
      this.tailOffset = undefined;
      this.tailPartial = '';
    }
    if (this.tailTimer) return;
    this._tailOnce().catch(() => {}); // sample immediately; no 700ms blind spot
    this.tailTimer = setInterval(() => {
      this._tailOnce().catch(() => {});
    }, 700);
    this.tailTimer.unref?.();
  }

  async _tailOnce() {
    if (!this.transcriptPath || this.disposed) return;
    const st = await fs.promises.stat(this.transcriptPath).catch(() => null);
    if (!st) return;
    if (this.tailOffset === undefined) {
      this.tailOffset = st.size; // stream only new content from now on
      return;
    }
    if (st.size < this.tailOffset) {
      this.tailOffset = 0; // file truncated/rotated
    }
    if (st.size === this.tailOffset) return;
    const len = Math.min(st.size - this.tailOffset, 2 * 1024 * 1024);
    const fh = await fs.promises.open(this.transcriptPath, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, this.tailOffset);
    await fh.close();
    // advance only by bytes actually read: with the 2MB read cap, jumping to
    // st.size would silently skip everything beyond the cap
    const readEnd = this.tailOffset + len;
    let text = this.tailPartial + buf.toString('utf8');
    let complete = '';
    if (text.endsWith('\n')) {
      complete = text;
      this.tailPartial = '';
      this.tailOffset = readEnd;
    } else {
      const nl = text.lastIndexOf('\n');
      if (nl < 0 && (readEnd < st.size || text.length > 1024 * 1024)) {
        // read cap hit (or absurd single line): process as-is and advance
        complete = text;
        this.tailPartial = '';
        this.tailOffset = readEnd;
      } else if (nl >= 0) {
        complete = text.slice(0, nl + 1);
        this.tailPartial = text.slice(nl + 1);
        this.tailOffset = readEnd - Buffer.byteLength(this.tailPartial);
      }
      // else: incomplete trailing line at EOF — keep as partial, re-read next tick
    }
    for (const line of complete.split('\n')) {
      if (line.trim()) this._onTranscriptLine(line);
    }
  }

  _onTranscriptLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj?.type !== 'assistant') return;
    const blocks = obj.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b?.type === 'text' && b.text?.trim()) {
        this.post('assistant/delta', { text: clip(b.text, 30000) });
      } else if (b?.type === 'thinking' && b.thinking?.trim() && this.cfg.shareThinking) {
        this.post('assistant/delta', { reasoning: clip(b.thinking, 12000) });
      }
      // tool_use blocks are broadcast via the PreToolUse hook
    }
  }

  // -- history backfill (FR-1.2 "含历史全部") ---------------------------------

  async shareHistory() {
    if (!this.transcriptPath || !fs.existsSync(this.transcriptPath)) return;
    const lines = fs
      .readFileSync(this.transcriptPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .slice(-this.cfg.shareHistoryMaxLines);
    const callIds = new Map(); // tool_use_id -> callId
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const content = obj?.message?.content;
      if (obj?.type === 'user' && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text' && b.text?.trim()) {
            this.post('chat/user', { text: clip(b.text, 20000), history: true });
          } else if (b?.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
            this.post('tool/result', {
              name: '?',
              callId: callIds.get(b.tool_use_id),
              ok: true,
              preview: clipLines(text, this.cfg.toolResultMaxLines),
              history: true
            });
          }
        }
      } else if (obj?.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text' && b.text?.trim()) {
            this.post('assistant/delta', { text: clip(b.text, 30000), history: true });
          } else if (b?.type === 'thinking' && b.thinking?.trim() && this.cfg.shareThinking) {
            this.post('assistant/delta', { reasoning: clip(b.thinking, 12000), history: true });
          } else if (b?.type === 'tool_use') {
            const cid = newId();
            callIds.set(b.id, cid);
            this.post('tool/call', { name: b.name, argsPreview: clip(JSON.stringify(b.input ?? {}), 2000), callId: cid, history: true });
          }
        }
      }
    }
  }

  // -- info for ss_room / ss_approve -------------------------------------------

  pendingApprovals() {
    return [...this.approvals.entries()].map(([requestId, w]) => ({
      requestId,
      summary: w.summary,
      memberId: w.memberId,
      displayName: w.displayName,
      mode: w.mode,
      at: w.at
    }));
  }

  roomSummary() {
    return {
      roomId: this.roomId,
      role: 'host',
      hostName: this.displayName,
      hostOnline: this.hostOnline,
      closed: this.roomClosed,
      mode: this.roomMode,
      link: this.link,
      code: this.code,
      hostUrl: this.hostUrl,
      lastSeq: this.stream?.lastSeq ?? this.since,
      queueDepth: this.queue.length,
      pendingApprovals: this.pendingApprovals(),
      activeGuestTurn: this.activeGuestTurn
    };
  }

  // canonical members list comes from the relay (async)
  async roomSummaryWithMembers() {
    const base = this.roomSummary();
    const info = await this.api.roomInfo(this.roomId, this.hostToken).catch(() => null);
    base.members = info?.ok ? info.data?.members || [] : [];
    base.relayRoom = info?.ok ? info.data : null;
    return base;
  }
}
