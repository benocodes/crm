---
"@vibase/server-d1": patch
---

`vibase-server setup` names a new instance's resources `vb-<kind>-<env>` (Worker `vb-<env>`, D1 `vb-crm-<env>`, R2 `vb-bodies-<env>`, Workflow `vb-mail-sync-<env>`), refuses a name over 63 characters before any step, and never renames an existing instance: the names in the instance settings file win over the derivation, and a `--worker-name`, `--d1-name` or `--r2-name` that differs from the record is refused (exit 2).
