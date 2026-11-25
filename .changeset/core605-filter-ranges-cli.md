---
'@vibase/cli': minor
'@vibase/server-d1': minor
---

A column filter flag can be repeated to send a range: `vibase deals list --expected-close-date gte.2026-11-01 --expected-close-date lt.2026-12-01` sends two conditions, which AND together (up to 4 per field; the server refuses a fifth). `--help` marks the flags that may repeat. The filter parameter descriptions in the OpenAPI documents, the MCP tools and `schema.get` no longer say "once per field": they say the parameter may repeat and give a range example for text, integer and timestamp fields.
