---
'@vibase/server-d1': minor
---

Migration `0021_capture_settings.sql`: every connection stores its capture settings. `channel_connections` gains `exclude_group_addresses`, `exclude_personal_domains` and `contact_creation`; new tables `connection_capture_labels` (INBOX and SENT for every existing connection), `connection_blocked_senders` and `blocked_senders` (the workspace blocklist, not yet writable). The connection record (`connections.get`, `connections.list`, `connection.created`) now carries `capture_labels`, `blocked_senders` and the three scalars. Defaults change nothing: capture and contact creation behave as before.
