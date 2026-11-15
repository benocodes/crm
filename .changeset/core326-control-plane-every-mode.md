---
'@vibase/server-d1': minor
---

The control-plane database is required in every auth mode. The Worker answers `500` on every non-health request without a `CONTROL_DB` binding, `503 migrations_pending` while its migrations are behind, and refuses a control database not paired with its CRM database, whatever `AUTH_PROVIDER` is (it was `better-auth` only). `audit.list` is served on Clerk and unset instances too. The remote scripts (`db:migrate:remote`, `db:status:remote`, `deploy:remote`, `bootstrap --remote`) and `vibase-server status` and `upgrade` refuse an instance with no control database before any call, pointing at `setup:remote` or `vibase-server setup`; local `bootstrap` pairs the control marker in every mode and refuses a local environment with no control database.
