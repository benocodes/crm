---
"@vibase/server-d1": patch
---

`vibase-server status` and `upgrade` handle an instance's control-plane database beside its CRM database. The instance settings take an optional `control_d1` (`name` and `id`, recorded, never derived); the generated config then carries a `CONTROL_DB` binding, `status` reports `[control]` and `[crm]` separately, and `upgrade` migrates control first, checks its tracker, then CRM, then deploys. Settings with `AUTH_PROVIDER=better-auth` and no `control_d1` are refused. Without `control_d1` both commands handle the CRM database only and print one not-configured line.
