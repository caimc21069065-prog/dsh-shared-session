---
description: Send a prompt to the shared-session host (guest) and report the result
argument-hint: <message>
---

You are in a guest session. Relay `$ARGUMENTS` to the host:

1. Call `ss_send` with `text` = exactly `$ARGUMENTS` (the user's message, nothing added).
2. Poll `ss_read` every few seconds until you observe `assistant/done` after your `chat/user` event (give up after ~3 minutes and tell the user the host is still working — they can ask again).
3. Summarize what the host did and answered, including key tool calls and results.

If `ss_send` fails (host offline / viewer-only), report the exact reason and stop.
