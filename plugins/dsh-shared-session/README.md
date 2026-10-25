# dsh-shared-session

Share a live ZCode session with teammates — pair-program, review and drive one agent together. The **host's machine does all the work**; guests watch in real time and send prompts that are injected into the host session. Inspired by [Paradigm-Study/claude-share](https://github.com/Paradigm-Study/claude-share) (Claude Code shared-session); see [docs/REQUIREMENTS.md](../../docs/REQUIREMENTS.md) for the full spec this implements.

## How it works

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Host ZCode process         │         │  Guest ZCode process        │
│  ┌───────────────────────┐  │         │  ┌───────────────────────┐  │
│  │ shared-session plugin │  │         │  │ shared-session plugin │  │
│  │ - hooks: event tap    │  │  SSE +  │  │ - room client (MCP)   │  │
│  │ - guest msg injection │◄─┼── REST ─┼─►│ - render + ss_send    │  │
│  │ - approval gate       │  │  Relay  │  │ - replay / ss_read    │  │
│  └───────────────────────┘  │         │  └───────────────────────┘  │
│  Session log (append-only)  │         │  View-only, no model calls  │
│  Real tools / workspace     │         │  No real tool execution     │
└─────────────────────────────┘         └─────────────────────────────┘
                 \                      /
                  \── relay (bundled,  │
                       zero-dependency Node, self-hostable)
```

- **Host**: hooks tap `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`; a transcript tailer streams assistant text and thinking. The session log stays append-only — guest input is injected as a new user message, history is never rewritten.
- **Guest**: joins via MCP tools only. Nothing runs locally (no model calls, no tools). Events are rendered by the agent (`ss_read`) or in the browser viewer.
- **Relay**: bundled `relay/server.mjs` (pure Node ≥ 18, no npm deps) or any implementation of [docs/relay-protocol.md](relay-protocol.md).

## Install (local dev marketplace)

Requirements: ZCode with plugin support, Node ≥ 18 on PATH (`node -v`).

1. Plugin Marketplace → **Add → Add Plugin Marketplace** → paste the directory `D:\Project\dsh-shared-session\plugins`.
2. In the marketplace pick **Shared Session / 共享会话** → **Install**.
3. Keep the plugin enabled for your workspace.

## Quick start

Host:

```
/share              # copy the invite link ( /share history  = include recent history )
... work normally; guest prompts arrive as [GuestName]: text ...
/room               # members, timeline, pending approvals
/stop-share         # close the room
```

Guest (in their own ZCode, same plugin installed):

```
/join <link>        # or paste the link into a fresh session; also <roomId>.<token> codes
/ask 请给 utils.ts 补上单元测试     # sends a prompt to the host and reports the result
/room               # who is in the room
/leave
```

Anyone can also open the invite link in a browser for a live view. The host link (`...?host=…`) adds approval buttons — use it from the host side only.

## Guest prompts & approvals (the important part)

- Guest text is queued on the host and injected **after the current turn** as a new user message `[GuestName]: text` (FR-3.1/3.2). The session log remains append-only and auditable. If the host is idle (no running turn), queued prompts wait for the host's next turn to end — `/room` shows the queue depth, and guests can nudge the host via side chat.
- During a guest-triggered turn the host enforces an extra policy on top of its normal permission system:
  - read-only tools (Read/Glob/Grep/…) pass,
  - writes / shell / network require host approval — default `guestWriteApproval: ask` shows the **native permission dialog** with the full command preview; `relay` mode instead pauses the tool and asks via `ss_approve` or the web host panel (guests see the decision); `allow-all` is not recommended,
  - approval timeout (default 9 minutes, inside the hook timeout budget) = deny,
  - host can set a guest to viewer-only or kick them (`/room` → `ss_set_policy`).
- If the host goes offline, new guest prompts are rejected with a clear message (FR-7.3); side chat and history still work. Rooms survive host restarts for `roomTtlHours` (default 24 h) and `/share` auto-resumes.

## Configuration

`~/.dsh-shared-session/config.json` (env vars override; see `lib/core.mjs`):

```json
{
  "relayUrl": "http://127.0.0.1:8787",
  "autoStartRelay": true,
  "defaultShareHistory": false,
  "guestWriteApproval": "ask",
  "toolResultMaxLines": 40,
  "roomTtlHours": 24,
  "displayName": null,
  "sideChatEnabled": true,
  "approvalTimeoutMs": 540000,
  "relayCreateToken": null,
  "shareThinking": true
}
```

`approvalTimeoutMs` defaults to 9 minutes: it must resolve before the hook timeout budget (590 s) so a pending approval always ends in an explicit decision instead of a killed hook. `relayCreateToken` is only needed when the relay was started with `--create-token`.

Env: `SHARED_SESSION_RELAY_URL`, `SHARED_SESSION_DISPLAY_NAME`, `SHARED_SESSION_GUEST_WRITE_APPROVAL`, `SHARED_SESSION_APPROVAL_TIMEOUT_MS`, … State (room tokens, 0600) lives in `~/.dsh-shared-session/rooms/<workspace>.json`.

## Self-hosting the relay

```
node <plugin>/relay/server.mjs --port 8787 --max-members 10 --ttl-hours 24
```

For an instance reachable from a network, add `--create-token <secret>` (or env `RELAY_CREATE_TOKEN`): room creation then requires the same value in an `x-create-token` header, and hosts set `relayCreateToken` in their config. Closed rooms answer `410` on join/rejoin/stream and their SSE connections are terminated.

Then point hosts/guests at it via `relayUrl` (or use links that already carry its origin). The bundled relay is in-memory, keeps ≤ 5000 events / 16 MB per room, and rate-limits to 60 events/min per member. Protocol: [docs/relay-protocol.md](relay-protocol.md). For a quick LAN/CI check: `node scripts/watch.mjs <invite-link>` tails the room from any terminal.

## Security & privacy (read this)

- **The relay is not end-to-end encrypted.** Everything in the room (prompts, replies, thinking, tool results, side chat) is readable by whoever operates the relay. Fine on `127.0.0.1`; for anything else, self-host.
- Guest prompts carry **only** the text the guest chose to send — no guest-side system prompt, files or secrets are forwarded (FR-3.4). In the other direction: treat guest text as **untrusted user input** — the approval gate exists precisely because guests can ask for anything.
- Tool call previews are broadcast to the room; avoid typing secrets while hosting, or restrict the room to trusted people.
- Tokens are stored hashed on the relay, 0600 on local disk, and never logged.
- Uninstall/disable removes all hooks and listeners; the host session log is untouched (NFR-3).

## Limitations (v0.1)

- Relay rooms are in-memory — restarting the relay process loses rooms (host can re-`/share`).
- Sub-agent inner steps are not mirrored (outer tool calls are visible).
- File/preview sharing, localhost preview forwarding, team login and E2E encryption are future work (see REQUIREMENTS §9).
- No web-overlay indicator inside ZCode itself; use `/room` or the browser viewer.

## Layout

```
.zcode-plugin/plugin.json   manifest (commands + skills + hooks + mcpServers)
mcp/server.mjs              MCP server: ss_share / ss_join / ss_room / ss_send / ss_approve / …
hooks/hook.mjs + hooks.json event tap + approval gate + guest-message injection
lib/                        core protocol, host/guest session logic, rendering
relay/server.mjs            zero-dependency relay + viewer.html
scripts/watch.mjs           terminal live-tail
commands/                   /share /join /room /stop-share /leave /ask
skills/shared-session       trigger knowledge for the agent
```
