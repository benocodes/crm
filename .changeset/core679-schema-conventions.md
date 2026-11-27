---
'@vibase/server-d1': patch
---

The CRM database's schema follows one set of conventions, held by a test: one id CHECK or a foreign key on every id column, one timestamp CHECK, every CHECK named, the unique (organization_id, id) index written one way and named `idx_<table>_organization_id_id`. No column's type, nullability, default or foreign key changes. There is no upgrade path: the change edits the genesis migration in place, so an existing instance is reinstalled, as for the genesis squash.
