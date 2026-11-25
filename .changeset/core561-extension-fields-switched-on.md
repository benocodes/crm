---
'@vibase/server-d1': minor
---

A deployment adds its own `<name>__c` fields to contacts, companies, deals and tasks by writing an `extend` section in its schema file. `vibase-server redeploy --schema <path>` validates it, plans the new columns and indexes with the custom objects, applies them after the core migrations and attaches the file; the Worker serves the fields on create, update, get, list filters, MCP and OpenAPI from start. `/health.schema` adds `fields` when the file extends, and a file that only extends counts as a file for the redeploy guard, `verify` and `status`. A file without `extend` behaves as before.
