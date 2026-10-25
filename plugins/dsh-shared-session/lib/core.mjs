// dsh-shared-session — shared library: protocol, config, state, transport.
// Zero-dependency (Node >= 18). Used by the MCP server, hooks and scripts.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = 1;

export const INJECT_MARKER_PREFIX = '<!--ss-inject:';

// ---------------------------------------------------------------------------
// Config (requirement §8)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  // Relay base URL. `http://127.0.0.1:8787` matches the bundled relay default.
  relayUrl: 'http://127.0.0.1:8787',
  // Host only: start the bundled relay automatically when unreachable.
  autoStartRelay: true,
  relayPort: 8787,
  defaultShareHistory: false,
  // ask (native host permission prompt) | relay (approve via web panel / ss_approve) | allow-all
  guestWriteApproval: 'ask',
  toolResultMaxLines: 40,
  roomTtlHours: 24,
  maxFileBytes: 8388608,
  displayName: null, // null = auto (git config user.name -> OS user)
  sideChatEnabled: true,
  allowLocalhostPreview: false,
  // FR-4.5: approval timeout. Kept below the hook timeout budget (590s) so the
  // gate always resolves with an explicit decision instead of being killed.
  approvalTimeoutMs: 540000,
  // Optional shared secret when the relay was started with --create-token.
  relayCreateToken: null,
  shareThinking: true,
  maxMembers: 10,
  shareHistoryMaxLines: 300,
  queueCap: 20 // FR-3.2 queue bound before injection
};

const ENV_MAP = {
  SHARED_SESSION_RELAY_URL: ['relayUrl', String],
  SHARED_SESSION_RELAY_PORT: ['relayPort', Number],
  SHARED_SESSION_DISPLAY_NAME: ['displayName', String],
  SHARED_SESSION_GUEST_WRITE_APPROVAL: ['guestWriteApproval', String],
  SHARED_SESSION_TOOL_RESULT_MAX_LINES: ['toolResultMaxLines', Number],
  SHARED_SESSION_ROOM_TTL_HOURS: ['roomTtlHours', Number],
  SHARED_SESSION_APPROVAL_TIMEOUT_MS: ['approvalTimeoutMs', Number],
  SHARED_SESSION_AUTO_START_RELAY: ['autoStartRelay', v => v === '1' || v === 'true'],
  SHARED_SESSION_RELAY_CREATE_TOKEN: ['relayCreateToken', String]
};

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const file = path.join(stateHome(), 'config.json');
    Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    /* no config file — defaults are fine */
  }
  for (const [envKey, [cfgKey, coerce]] of Object.entries(ENV_MAP)) {
    const v = process.env[envKey];
    if (v !== undefined && v !== '') {
      try {
        cfg[cfgKey] = coerce(v);
      } catch {
        /* keep default */
      }
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// State (~/.dsh-shared-session/rooms/<cwdHash>.json) — 0600 best effort
// ---------------------------------------------------------------------------

export function stateHome() {
  return process.env.SHARED_SESSION_HOME || path.join(os.homedir(), '.dsh-shared-session');
}

export function normCwd(cwd) {
  let p = path.resolve(cwd || process.cwd());
  if (process.platform === 'win32') p = p.toLowerCase();
  return p;
}

export function cwdHash(cwd) {
  return createHash('sha256').update(normCwd(cwd)).digest('hex').slice(0, 16);
}

export function statePathFor(cwd) {
  return path.join(stateHome(), 'rooms', `${cwdHash(cwd)}.json`);
}

export function loadState(cwd) {
  try {
    return JSON.parse(fs.readFileSync(statePathFor(cwd), 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(cwd, state) {
  const file = statePathFor(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: ACL hardening is out of scope; home dir is user-private by default */
  }
}

export function clearState(cwd) {
  try {
    fs.rmSync(statePathFor(cwd), { force: true });
  } catch {
    /* ignore */
  }
}

export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// ---------------------------------------------------------------------------
// Display name (FR-5.5)
// ---------------------------------------------------------------------------

export function resolveDisplayName(cfg) {
  if (cfg && cfg.displayName) return String(cfg.displayName);
  if (process.env.SHARED_SESSION_DISPLAY_NAME) return process.env.SHARED_SESSION_DISPLAY_NAME;
  try {
    const name = execFileSync('git', ['config', 'user.name'], { timeout: 2000, encoding: 'utf8' }).trim();
    if (name) return name;
  } catch {
    /* fall through */
  }
  try {
    return os.userInfo().username || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

// ---------------------------------------------------------------------------
// HTTP + SSE helpers
// ---------------------------------------------------------------------------

export async function httpJson(url, { method = 'GET', body, timeoutMs = 8000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

export function newId() {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Link / code parsing
//   URL:  <relay>/r/<roomId>/<inviteToken>[?host=<hostToken>]
//   Code: <roomId>.<inviteToken>
// ---------------------------------------------------------------------------

export function parseJoinTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/r\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/);
    if (m) return { relayUrl: u.origin, roomId: m[1], inviteToken: m[2] };
  } catch {
    /* not a URL */
  }
  const m = s.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (m) return { relayUrl: null, roomId: m[1], inviteToken: m[2] };
  return null;
}

export function buildInviteLink(relayUrl, roomId, inviteToken) {
  return `${String(relayUrl).replace(/\/+$/, '')}/r/${roomId}/${inviteToken}`;
}

// ---------------------------------------------------------------------------
// RelayStream — SSE downstream with reconnect + gap fill (FR-2.5)
// ---------------------------------------------------------------------------

export class RelayStream {
  /**
   * @param {object} o
   * @param {string} o.relayUrl
   * @param {string} o.roomId
   * @param {string} o.token   member token or invite token (read-only)
   * @param {number} [o.since] last known seq
   * @param {(ev: object) => void} o.onEvent
   * @param {(status: string, err?: Error) => void} [o.onStatus]
   */
  constructor({ relayUrl, roomId, token, since = 0, onEvent, onStatus }) {
    this.relayUrl = String(relayUrl).replace(/\/+$/, '');
    this.roomId = roomId;
    this.token = token;
    this.lastSeq = since;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.closed = false;
    this._ac = null;
    this._loopPromise = null;
  }

  start() {
    this._loopPromise = this._loop();
    return this._loopPromise;
  }

  async _loop() {
    let backoff = 1000;
    while (!this.closed) {
      let connected = false;
      try {
        const url = `${this.relayUrl}/api/rooms/${encodeURIComponent(this.roomId)}/stream?since=${this.lastSeq}&token=${encodeURIComponent(this.token)}`;
        this._ac = new AbortController();
        const res = await fetch(url, {
          headers: { accept: 'text/event-stream' },
          signal: this._ac.signal
        });
        if (!res.ok || !res.body) {
          if (res.status === 410) {
            // room closed on the relay — stop instead of retrying forever
            this.closed = true;
            this.onStatus?.('closed');
            return;
          }
          throw new Error(`relay stream HTTP ${res.status}`);
        }
        connected = true;
        backoff = 1000;
        this.onStatus?.('connected');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this._handleFrame(frame);
          }
        }
      } catch (err) {
        if (this.closed) return;
        if (!connected) this.onStatus?.('reconnecting', err);
      }
      if (this.closed) return;
      this.onStatus?.('reconnecting');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  }

  _handleFrame(frame) {
    let id = null;
    let data = '';
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // heartbeat / comment
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      else if (line.startsWith('data:')) {
        let v = line.slice(5);
        if (v.startsWith(' ')) v = v.slice(1); // SSE spec: strip one leading space
        data += (data ? '\n' : '') + v;
      }
    }
    if (id != null && Number.isFinite(id)) this.lastSeq = Math.max(this.lastSeq, id);
    if (data) {
      try {
        this.onEvent(JSON.parse(data));
      } catch {
        /* malformed frame — skip */
      }
    }
  }

  stop() {
    this.closed = true;
    try {
      this._ac?.abort();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Relay REST API wrapper
// ---------------------------------------------------------------------------

export function relayApi(relayUrl) {
  const base = String(relayUrl).replace(/\/+$/, '');
  return {
    base,
    health: () => httpJson(`${base}/api/health`, { timeoutMs: 2500 }),
    createRoom: (body, headers = {}) => httpJson(`${base}/api/rooms`, { method: 'POST', body, headers }),
    joinRoom: (roomId, body) => httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body }),
    rejoinRoom: (roomId, body) => httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}/rejoin`, { method: 'POST', body }),
    leaveRoom: (roomId, body) => httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST', body }),
    roomInfo: (roomId, token) =>
      httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`),
    pollEvents: (roomId, token, since, limit = 200) =>
      httpJson(
        `${base}/api/rooms/${encodeURIComponent(roomId)}/events?since=${since}&limit=${limit}&token=${encodeURIComponent(token)}`
      ),
    postEvent: (roomId, body) =>
      httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}/events`, { method: 'POST', body, timeoutMs: 10000 }),
    control: (roomId, body) =>
      httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}/control`, { method: 'POST', body }),
    deleteRoom: (roomId, token) =>
      httpJson(`${base}/api/rooms/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
  };
}

// ---------------------------------------------------------------------------
// Tool classification (FR-4.2 / FR-4.3)
// ---------------------------------------------------------------------------

export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoRead',
  'TodoWrite',
  'NotebookRead',
  'TaskOutput',
  'get_view',
  'open_document',
  'read_document',
  'search_document'
]);

export function isDangerousTool(toolName) {
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (/^mcp__/.test(toolName)) return true; // unknown MCP tools fail closed
  return true; // Write/Edit/Bash/Web*/Agent/... default to approval
}
