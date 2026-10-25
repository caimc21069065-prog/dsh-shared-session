// dsh-shared-session — human-readable rendering of room events.
// Shared by MCP tool output (ss_read / ss_room), scripts/watch.mjs and tests.

const MAX_LINE = 240;

function clip(s, max = MAX_LINE) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function clipLines(s, maxLines) {
  const lines = String(s ?? '').split('\n');
  const head = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? head + `\n… (${lines.length - maxLines} more lines)` : head;
}

export function truncateResult(text, maxLines) {
  return clipLines(text, maxLines);
}

export function formatEvent(ev, { maxLines = 40 } = {}) {
  const who = ev.from ? `${ev.from.displayName}` : 'system';
  const p = ev.payload || {};
  switch (ev.type) {
    case 'room/meta':
      return `[room] host=${p.hostName} created=${ev.at}`;
    case 'room/closed':
      return `[room] closed by host`;
    case 'room/mode':
      return `[room] approval mode -> ${p.mode}`;
    case 'member/join':
      return `[room] ${p.displayName} joined (${p.role})`;
    case 'member/leave':
      return `[room] ${p.displayName || p.memberId} left`;
    case 'member/kicked':
      return `[room] ${p.memberId} was kicked by host`;
    case 'member/update':
      return `[room] ${p.memberId} policy updated${p.viewer !== undefined ? ` viewer=${p.viewer}` : ''}`;
    case 'chat/user':
      return `[${who}] ${clipLines(p.text, 12)}`;
    case 'chat/side':
      return `[side:${who}] ${clipLines(p.text, 12)}`;
    case 'chat/rejected':
      return `[room] message rejected: ${clip(p.reason)}`;
    case 'assistant/delta': {
      const parts = [];
      if (p.text) parts.push(clipLines(p.text, maxLines));
      if (p.reasoning) parts.push(`(thinking) ${clipLines(p.reasoning, 6)}`);
      return parts.length ? `[assistant] ${parts.join('\n')}` : null;
    }
    case 'assistant/done':
      return `[assistant] — turn complete —`;
    case 'tool/call':
      return `[tool] ${p.name}(${clip(p.argsPreview, 160)})`;
    case 'tool/result':
      return `[tool:${p.name}] ${p.ok ? 'ok' : 'FAILED'} ${clipLines(p.preview, maxLines)}`;
    case 'control/approval':
      return `[approval] request ${p.requestId?.slice(0, 8)} (${p.mode}) from ${p.displayName || p.memberId}: ${clipLines(p.summary, 12)}`;
    case 'control/approval-result':
      return `[approval] ${p.requestId?.slice(0, 8)} -> ${p.decision}`;
    default:
      return `[${ev.type}] ${clip(JSON.stringify(p), 120)}`;
  }
}

export function renderEvents(events, opts = {}) {
  const out = [];
  for (const ev of events) {
    const line = formatEvent(ev, opts);
    if (line) out.push(`#${ev.seq} ${line}`);
  }
  return out.join('\n');
}

export function renderRoom(room, extra = {}) {
  const lines = [];
  lines.push(`Room ${room.roomId}`);
  lines.push(`  host: ${room.hostName}${room.closed ? '  (CLOSED)' : room.hostOnline ? '  (host online)' : '  (host offline)'}`);
  lines.push(`  mode: ${room.mode}  protocol: v${room.protocolVersion ?? '?'}`);
  const members = room.members || [];
  lines.push(`  members (${members.length}):`);
  for (const m of members) {
    lines.push(`    - ${m.displayName} [${m.role}]${m.viewer ? ' (viewer)' : ''}${m.online ? ' online' : ''}`);
  }
  for (const [k, v] of Object.entries(extra)) lines.push(`  ${k}: ${v}`);
  return lines.join('\n');
}
