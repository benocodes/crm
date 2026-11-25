---
'@vibase/server-d1': minor
---

The file that declares custom objects and extension fields is the schema file. `vibase-server redeploy --schema <path>` attaches it and records its absolute path under the `schema` key of the instance settings; `vibase.schema.json` is its conventional name, and its JSON Schema ships beside the Worker as `worker/vibase.schema.schema.json`. In the file, `define` declares new custom objects (required: an extend-only file writes `"define": {}`) and `extend` adds fields to contacts, companies, deals and tasks. `/health.schema` reports what is attached, `vibase-server status` and the redeploy plan print a `schema:` line, and a Worker that cannot load its file answers every route but `/health` with `503 schema_invalid`. The empty file that drops everything on purpose is `{"version":1,"define":{}}`.
