-- [[CORE329]], [[CORE259]] D12/D13: API keys and webhook subscriptions live in the control-plane database (control migrations 0004 and 0005); the CRM copies (0003, 0016, 0017) were dormant after CORE350, CORE351,
-- CORE356, CORE337 and CORE347. 0016/0017 stay (forward-only); this drops the five tables, children first so no foreign key is ever violated: the three tables that reference `webhook_subscriptions`
-- (deliveries, dispatch state, secrets), then their parent, then `api_keys` (it references agents and organizations, nothing references it). Their rows go with them; `events` rows of type
-- `api_key.*` and `webhook.*` stay (hidden from the feed since CORE347 and CORE357). The `webhook_secrets_append_only` trigger goes with its table. Nothing else references the five tables.
drop table "webhook_deliveries";
drop table "webhook_secrets";
drop table "webhook_dispatch_state";
drop table "webhook_subscriptions";
drop table "api_keys";
