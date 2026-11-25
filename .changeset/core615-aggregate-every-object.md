---
'@vibase/server-d1': minor
---

Contacts, companies, tasks and every custom object now answer `<name>.aggregate` (REST `GET /api/v1/<name>/aggregate`, MCP `<name>_aggregate`, CLI `vibase <name> aggregate`) with the list's own filters: a count, and the sum, average, minimum or maximum of fields by kind. A function with no field on a list (`sum` and `avg` on contacts, companies and tasks until an integer `__c` field is declared) is not a parameter of it, and naming it is a 400. `schema.get` reports each list's aggregate. **Six field names are now reserved for custom objects: `count`, `sum`, `avg`, `min`, `max` and `group_by`.** A deployed schema file that declares a custom object field with one of these names is invalid under this release and the Worker fails closed on it (503 `schema_invalid`) after upgrade until the field is renamed; `redeploy --schema` refuses such a file with `reserved_name` before any deploy step.
