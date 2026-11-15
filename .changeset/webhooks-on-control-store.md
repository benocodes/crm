---
"@vibase/server-d1": minor
---

Webhook subscriptions, their dispatch state and deliveries now live in the control-plane database (`CONTROL_DB`). The subscription operations, the dispatcher and the sender read and write it (a subscription change writes its `control_audit` row and no `webhook.*` event), and the per-minute tick runs them only when the control migrations are applied and the control marker matches the CRM database. Subscriptions held in the CRM database by an earlier version are not copied: agents re-create them.
