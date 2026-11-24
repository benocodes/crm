---
'@vibase/server-d1': minor
---

`vibase-server redeploy --extensions <path>` attaches an extensions file of custom objects. It validates the file, applies its `__c` tables to the database after the core migrations, uploads the Worker with the file as a `vibase-extensions.json` Text module, records the file's path in the settings so a later `redeploy` or `upgrade` attaches it again, and waits for `/health` to show the file's digest. A refused plan (a changed kind or target, a unique field that live rows violate) changes nothing, and a run with no file is refused while the live Worker carries one. The Worker serves the custom objects from start, lists their scopes in its early discovery answers, shows them as one "Custom records" area on the consent page, reports the file's digest and object names in `/health` and `vibase-server status`, and answers every route but `/health` with `503 extensions_invalid` when it cannot load its file.
