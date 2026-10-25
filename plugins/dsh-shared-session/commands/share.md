---
description: Share this session with teammates (you become the host)
---

Share the current ZCode session so teammates can watch it live and send prompts that YOU execute.

Steps:

1. Call the `ss_share` tool. Pass `includeHistory: true` only if `$ARGUMENTS` contains "history" or "历史".
2. Present to the user, prominently:
   - The invite link (they should copy it and send it to teammates).
   - The short code as a fallback.
   - The host control panel link — the user can open it in a browser to watch the room and approve guest-triggered actions there.
3. Explain in one or two sentences:
   - Guests open the link in their own ZCode and run `/join <link>`; they can also just watch it in a browser.
   - Guest prompts arrive as `[GuestName]: text` after the current turn finishes.
   - When a guest triggers file writes / shell / network, a normal approval prompt appears (config `guestWriteApproval`).
4. If `ss_share` fails because the relay is unreachable, show the exact error and the manual relay command it suggests (the tool auto-starts a local relay by default), then retry once after the user confirms.

Keep sharing active until the user runs `/stop-share`. Mention that command once.
