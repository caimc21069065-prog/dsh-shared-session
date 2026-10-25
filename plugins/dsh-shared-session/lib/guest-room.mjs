// dsh-shared-session — Guest session: watch the host stream, queue prompts.
// Guests never run the model or tools (NFR-1); they only render events and
// send prompt text (FR-3).

import {
  PROTOCOL_VERSION,
  RelayStream,
  buildInviteLink,
  parseJoinTarget,
  relayApi,
  resolveDisplayName,
  saveState,
  clearState,
  loadState,
  newId
} from './core.mjs';

export class GuestSession {
  /**
   * @param {object} o
   * @param {object} o.cfg
   * @param {string} o.cwd
   * @param {string} o.relayUrl
   * @param {string} o.roomId
   * @param {string} o.memberToken
   * @param {string} o.memberId
   * @param {string} o.inviteToken (for the viewer link)
   * @param {string} o.displayName
   * @param {number} [o.since]
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.cwd = o.cwd;
    this.relayUrl = o.relayUrl;
    this.roomId = o.roomId;
    this.memberToken = o.memberToken;
    this.memberId = o.memberId;
    this.inviteToken = o.inviteToken;
    this.displayName = o.displayName;
    this.since = o.since ?? 0;

    this.api = relayApi(o.relayUrl);
    this.stream = null;
    this.disposed = false;
    this.log = [];
    this.logSeqs = new Set();
    this.roomClosed = false;
    this.kicked = false;
  }

  static async join({ cwd, cfg, linkOrCode, displayName }) {
    const target = parseJoinTarget(linkOrCode);
    if (!target || !target.inviteToken) {
      throw new Error(
        'Could not parse the invite. Expected a link like <relay>/r/<roomId>/<token> or a code <roomId>.<token>.'
      );
    }
    const relayUrl = target.relayUrl || cfg.relayUrl;
    const api = relayApi(relayUrl);
    const name = displayName || resolveDisplayName(cfg);
    const r = await api.joinRoom(target.roomId, {
      inviteToken: target.inviteToken,
      displayName: name,
      protocolVersion: PROTOCOL_VERSION
    });
    if (!r.ok) {
      if (r.status === 404) throw new Error('Room not found — it may have expired or been closed by the host.');
      if (r.status === 403) throw new Error('Invite rejected (bad or expired invite token).');
      if (r.status === 409) throw new Error('Room is full (max members).');
      if (r.status === 410) throw new Error('The room was closed by the host. Ask for a fresh link.');
      throw new Error(`Join failed: HTTP ${r.status}`);
    }
    const { memberId, token, replay } = r.data;
    const session = new GuestSession({
      cwd,
      cfg,
      relayUrl,
      roomId: target.roomId,
      memberToken: token,
      memberId,
      inviteToken: target.inviteToken,
      displayName: name,
      since: replay?.lastSeq ?? 0
    });
    if (Array.isArray(replay?.events)) {
      for (const ev of replay.events) session._logEvent(ev);
    }
    await session.start();
    session.persistState();
    return session;
  }

  static async resume({ cwd, cfg }) {
    const st = loadState(cwd);
    if (!st || st.role !== 'guest') throw new Error('No joined room found for this workspace. Use /join <link> first.');
    const api = relayApi(st.relayUrl);
    const r = await api.rejoinRoom(st.roomId, { token: st.memberToken }).catch(() => null);
    if (!r?.ok) {
      clearState(cwd);
      throw new Error('The room is gone (closed or expired). Ask the host for a fresh link.');
    }
    const session = new GuestSession({
      cwd,
      cfg,
      relayUrl: st.relayUrl,
      roomId: st.roomId,
      memberToken: st.memberToken,
      memberId: st.memberId,
      inviteToken: st.inviteToken,
      displayName: st.displayName,
      since: st.lastSeq ?? 0
    });
    if (Array.isArray(r.data?.replay?.events)) {
      for (const ev of r.data.replay.events) session._logEvent(ev);
    }
    await session.start();
    session.persistState();
    return session;
  }

  async start() {
    this.stream = new RelayStream({
      relayUrl: this.relayUrl,
      roomId: this.roomId,
      token: this.memberToken,
      since: this.since,
      onEvent: ev => this._onRoomEvent(ev)
    });
    this.stream.start();
  }

  persistState() {
    saveState(this.cwd, {
      role: 'guest',
      protocolVersion: PROTOCOL_VERSION,
      relayUrl: this.relayUrl,
      roomId: this.roomId,
      memberToken: this.memberToken,
      inviteToken: this.inviteToken,
      memberId: this.memberId,
      displayName: this.displayName,
      lastSeq: this.stream ? this.stream.lastSeq : this.since,
      createdAt: new Date().toISOString()
    });
  }

  get viewerLink() {
    return buildInviteLink(this.relayUrl, this.roomId, this.inviteToken);
  }

  _logEvent(ev) {
    if (ev.seq != null) {
      if (this.logSeqs.has(ev.seq)) return;
      this.logSeqs.add(ev.seq);
    }
    this.log.push(ev);
    if (this.log.length > 3000) {
      const drop = this.log.splice(0, this.log.length - 3000);
      for (const d of drop) this.logSeqs.delete(d.seq);
    }
  }

  _onRoomEvent(ev) {
    this._logEvent(ev);
    const p = ev.payload || {};
    if (ev.type === 'room/closed') {
      this.roomClosed = true;
      this.stream?.stop(); // relay terminates streams on close; don't reconnect
    }
    if (ev.type === 'member/kicked' && p.memberId === this.memberId) {
      this.kicked = true;
      this.dispose();
    }
  }

  /** Send a prompt to the host (FR-3.1). Rejects when the host is offline (FR-7.3). */
  async sendPrompt(text) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('Empty message.');
    const r = await this.api.postEvent(this.roomId, {
      token: this.memberToken,
      type: 'chat/user',
      payload: { text: body.slice(0, 20000) },
      cid: newId()
    });
    if (r.status === 409) {
      throw new Error('Host is currently offline (room kept for a while). The message was NOT delivered — try again later.');
    }
    if (r.status === 410) {
      throw new Error('The room was closed by the host.');
    }
    if (r.status === 429) {
      throw new Error('Sending too fast — rate limited by the relay. Wait a moment and try again.');
    }
    if (r.status === 403) {
      throw new Error('You are set to viewer-only by the host; prompts are disabled.');
    }
    if (!r.ok) throw new Error(`Send failed: HTTP ${r.status}`);
    return r.data;
  }

  async sendSideChat(text) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('Empty message.');
    const r = await this.api.postEvent(this.roomId, {
      token: this.memberToken,
      type: 'chat/side',
      payload: { text: body.slice(0, 5000) }
    });
    if (!r.ok) throw new Error(`Side chat failed: HTTP ${r.status}`);
    return r.data;
  }

  eventsSince(since) {
    return this.log.filter(e => e.seq != null && e.seq > since);
  }

  lastSeq() {
    return this.stream?.lastSeq ?? this.since;
  }

  async roomSummary() {
    const info = await this.api.roomInfo(this.roomId, this.memberToken).catch(() => null);
    const data = info?.ok ? info.data : null;
    return {
      roomId: this.roomId,
      role: 'guest',
      displayName: this.displayName,
      closed: this.roomClosed || Boolean(data?.closed),
      hostOnline: Boolean(data?.hostOnline),
      hostName: data?.hostName || '?',
      mode: data?.mode || 'default',
      lastSeq: this.lastSeq(),
      viewerLink: this.viewerLink,
      members: data?.members || []
    };
  }

  async leave() {
    await this.api.leaveRoom(this.roomId, { token: this.memberToken }).catch(() => {});
    this.dispose();
    clearState(this.cwd);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.stop();
    if (this.stream) this.persistState();
  }
}
