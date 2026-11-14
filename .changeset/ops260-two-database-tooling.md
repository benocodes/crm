---
"@vibase/server-d1": patch
---

CRM migration 0019 drops the dormant `auth_*` tables (they live in the control database now). The package ships `control-migrations/` under the new export `./control-migrations/*`, listed in `release.json` as `control_migrations`.
