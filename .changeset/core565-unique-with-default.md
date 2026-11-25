---
'@vibase/server-d1': patch
---

An `extend` field on contacts, companies, deals or tasks can no longer be both `unique` and have a `default`: `setup` and `redeploy` refuse the schema file with `unique_with_default`, naming the field, because every row the vault creates itself would take the default and a second one would collide on the unique index. Custom objects are unchanged, and `unique` with `required` and no default is still accepted.
