---
'@vibase/server-d1': patch
---

CRM migration 0020 drops the `api_keys`, `webhook_subscriptions`, `webhook_secrets`, `webhook_dispatch_state` and `webhook_deliveries` tables from the CRM database; API keys and webhook subscriptions live only in the control database, where they have lived since the control-plane move. `schema.get` no longer lists them. API-key authentication reads the control database only, so a key whose hash control does not hold is refused, and `bootstrap` refuses to run without a control key store. Upgrade with `vibase-server upgrade`; rows in the dropped CRM tables go with them (they were unused).
