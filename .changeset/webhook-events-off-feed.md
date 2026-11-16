---
'@vibase/server-d1': minor
---

The `webhook` event type leaves the event feed. Historic `webhook.created`, `webhook.updated`, `webhook.deleted` and `webhook.secret_rotated` rows are no longer returned by `events.list` or `events.get` (nothing has written them since webhook subscriptions moved to the control plane), and `webhooks.create` and `webhooks.update` refuse a `webhook.*` event type with `400 unknown_event_type`. Subscription changes are recorded in the audit log: read them with `audit.list` (`audit:read`). A subscription already storing a `webhook.*` type is kept as stored and never fires.
