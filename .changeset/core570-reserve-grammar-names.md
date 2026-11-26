---
'@vibase/server-d1': patch
---

a custom object can no longer have a field named `or`, `and`, `not` or `select`: the names are reserved for later filter grouping and column-selection parameters. A schema file that already uses one fails after upgrade: the Worker answers `503 schema_invalid` until the field is renamed, and `redeploy --schema` refuses the file with `reserved_name` before any deploy step. Object names, `__c` fields on built-in objects and property bag keys are unaffected. No migration.
