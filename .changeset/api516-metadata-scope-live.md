---
'@vibase/server-d1': minor
---

`messages:read_metadata` is a grantable scope: an agent or an OAuth client holding it reads message and thread subjects (the list and get operations, the thread links, the event feed and webhook deliveries) without message text or attachments, which still need `messages:read`. Holding `messages:read` implies it, so every existing grant behaves as before; the agents page shows it as "read metadata". A caller with neither scope is refused with `requires messages:read_metadata`.
