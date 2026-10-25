# Relay protocol v1

Minimal contract for a shared-session relay. The bundled implementation is `relay/server.mjs` (pure Node ≥ 18, in-memory). Any service speaking this protocol works (Cloudflare Worker, nginx+app, …). All bodies are JSON; tokens travel in the body or query string and must never be logged. Responses carry `protocolVersion: 1`; clients refuse mismatched major versions.

## Concepts

- **Room** — `roomId`, host name, TTL, monotonic event `seq`, member list, approval `mode` (`default` | `ask-all`), `closed` flag.
- **Tokens** — opaque strings, stored as SHA-256 hashes by the relay:
  - `hostToken` — created with the room; full control.
  - `inviteToken` — carried by invite links; join + read-only streaming.
  - `memberToken` — issued per member on join; post events + stream.
- **Event** — `{ seq, type, payload, from: {memberId, displayName, role}, at, cid }`. `seq` is assigned by the relay. `cid` is a client-generated dedup id.

## Event types

| type | payload (abridged) | posted by |
|------|--------------------|-----------|
| `room/meta` | `{roomId, hostName, createdAt}` | relay on create |
| `room/mode` | `{mode}` | host control |
| `room/closed` | `{}` | host control |
| `member/join` | `{memberId, displayName, role}` | relay on join |
| `member/leave` / `member/kicked` | `{memberId, displayName}` | relay |
| `member/update` | `{memberId, viewer}` | host control |
| `chat/user` | `{text}` — goes into the agent | any member (guests blocked while host offline → `409`, viewers → `403`) |
| `chat/side` | `{text}` — humans only | any member |
| `chat/rejected` | `{reason}` | host client |
| `assistant/delta` | `{text?, reasoning?}` | host client |
| `assistant/done` | `{}` | host client |
| `tool/call` | `{name, argsPreview, callId}` | host client |
| `tool/result` | `{name, callId?, ok, preview}` | host client |
| `control/approval` | `{requestId, summary, memberId, mode, timeoutMs}` | host client |
| `control/approval-result` | `{requestId, decision: allow\|allow-always\|deny}` | host (or host web panel) |

## Endpoints

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | – | `{ok, protocolVersion}` |
| `POST /api/rooms` | – (optional `x-create-token`) | body `{hostName, ttlHours?, maxMembers?, protocolVersion}` → `{roomId, hostToken, inviteToken, memberId}`; if the relay runs with `--create-token`, the header must match |
| `POST /api/rooms/:id/join` | inviteToken | body `{inviteToken, displayName}` → `{memberId, token, replay:{events,lastSeq}}`; 403/404/409(full)/410(closed) |
| `POST /api/rooms/:id/rejoin` | member/host token | resume → `{memberId, role, replay}`; 410 once closed (host included — a closed room is dead) |
| `POST /api/rooms/:id/leave` | memberToken | remove member, broadcast `member/leave` |
| `GET /api/rooms/:id` | any token | room info: members, online, mode, `lastSeq` |
| `GET /api/rooms/:id/events?since=&limit=&token=` | any token | poll fallback → `{events, lastSeq, closed}` |
| `GET /api/rooms/:id/stream?since=&token=` | any token | **SSE**: backlog `seq > since` (≤1000), then live frames `id: <seq>\nevent: message\ndata: <json>\n\n`, `: ping` heartbeat ≤ 15 s; `410` once the room is closed (server terminates all streams on close/delete) |
| `POST /api/rooms/:id/events` | memberToken | body `{token, type, payload, cid?}` → `{seq}`; host-only types enforced; payload ≤ 128 KB; ~60 events/min/member |
| `POST /api/rooms/:id/control` | hostToken | `{token, action, args}`; actions `close-room`, `set-room-mode`, `set-viewer`, `kick` |
| `DELETE /api/rooms/:id?token=` | hostToken | purge immediately |
| `GET /r/:roomId/:inviteToken` | – | viewer HTML (bundled relay only) |

## Retention & limits (bundled defaults)

Rooms expire after `ttlHours` (default 24) of inactivity; closed rooms linger 1 h. Per room: ≤ 5000 events, ≤ 16 MB (oldest dropped first), ≤ `maxMembers` members (default 10, capped by the server's `--max-members`).

## Client rules

1. Store `lastSeq`; on reconnect open the stream with `since=lastSeq` to fill gaps (FR-2.5).
2. Treat unknown event types as no-ops for forward compatibility.
3. Never send a guest's local context — `chat/user` text only.
4. Host offline semantics: relay tracks the host member's SSE connections; `chat/user` from guests is rejected `409 {error:"host-offline"}` while none are connected.
