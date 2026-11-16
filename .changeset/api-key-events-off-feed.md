---
'@vibase/server-d1': patch
---

The `api_key` event type leaves the event feed. Historic `api_key.created` and `api_key.revoked` rows are no longer returned by `events.list` or `events.get` (nothing has written them since API keys moved to the control plane), and `webhooks.create` and `webhooks.update` refuse an `api_key.*` event type with `400 unknown_event_type`. Key issue and revoke are recorded in the audit log: read them with `audit.list` (`audit:read`).
