---
'@vibase/server-d1': minor
---

The served OpenAPI document now carries `x-vibase-aggregate` on every `<list>.aggregate` operation: the fields each function (`sum`, `avg`, `min`, `max`) and `group_by` take, and the money fields with their currency columns, the same object `schema.get` publishes as `resource.aggregate`. The TypeScript SDK reads it to type `vibase.<list>.aggregate(...)`. Parameters, REST, MCP tools and the CLI are unchanged.
