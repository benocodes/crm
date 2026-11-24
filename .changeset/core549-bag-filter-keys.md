---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

Every custom object now carries the `additional_props` bag too (a new `__c` table gets the column, and `vibase-server redeploy` adds it to an existing one, once). Lists of contacts, companies, deals, tasks and custom objects, and `deals aggregate`, take `additional_props=<key>.<condition>` (`eq`, `neq`, `in`, `is.null`, `not.is.null`; a string matches by its text, a number or boolean by its JSON literal; no index serves it). A new read, `<resource>.property_keys` (`GET /api/v1/<resource>/property-keys`, MCP `<resource>_property_keys`, CLI `<resource> property-keys`), lists the bag keys in use with record counts and JSON types, never a value. `schema.get` describes the bag column's rules.
