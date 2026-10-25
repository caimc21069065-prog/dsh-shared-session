---
description: Show shared-session room status (members, approvals, recent activity)
---

Call the `ss_room` tool and present the result clearly:

- Room id, role (host/guest), host online/offline, closed or active.
- Member list with online/viewer status.
- Recent activity timeline (last ~15 events).

If you are the host and there are pending approvals, show each request with its FULL command/path preview and ask the user to decide, then call `ss_approve` with the chosen decision (`allow`, `allow-always`, or `deny`) and the requestId.

If the user asks to manage members, you may also call `ss_set_policy` (set `viewer: true/false`, `kick: true`, or `roomMode: default|ask-all`) after confirming with the user.
