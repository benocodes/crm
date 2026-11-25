---
'@vibase/server-d1': minor
---

the schema file (`version` 1, `define` keyed by `<key>__c`) is validated with named errors, and its JSON Schema, `vibase.schema.schema.json`, ships beside the Worker in the server package. A new apply makes a D1 database's `__c` tables match the file: it creates missing tables and indexes, adds new fields, archives what the file no longer declares (nothing is dropped), and refuses kind, target, required and default changes, a removed `unique`, and data a new unique index would violate, before any change is made. Nothing in `redeploy` reads a file yet, so a deployment behaves as before.
