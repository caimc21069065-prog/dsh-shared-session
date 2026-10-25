---
description: Join a shared session as a guest (watch live, send prompts to the host)
argument-hint: <link-or-code>
---

Join a shared session as a guest. The HOST's machine runs the model and all tools; you only watch and relay prompts. This costs no local tokens.

Steps:

1. Call the `ss_join` tool with `linkOrCode = $ARGUMENTS`. If `$ARGUMENTS` is empty, call it with no arguments to resume the previous room.
2. Summarize the replay for the user (what happened in the room so far), and give them the browser viewer link.
3. Explain how this session works now:
   - The user types a request here → you call `ss_send` with EXACTLY the user's request text. Never add your own commentary, local file contents, or context to it (privacy: nothing from this machine besides the requested text may reach the host).
   - After sending, poll `ss_read` every few seconds until you see `assistant/done`, then summarize the host's reply and tool activity for the user.
   - If `ss_send` fails with "host offline", report that the host is away and the message was not delivered.
4. `/room` shows members and status; `/leave` exits.

You are a relay and narrator only — do not attempt to execute the guest's request locally.
