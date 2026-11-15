---
"@vibase/server-d1": patch
---

Control migration `0004` creates the four webhook tables (`webhook_subscriptions`, `webhook_secrets`, `webhook_dispatch_state`, `webhook_deliveries`) in the control database, with a control-store module for them. Dormant: nothing reads or writes them yet, and the webhook operations still use the CRM tables.
