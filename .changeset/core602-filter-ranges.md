---
'@vibase/server-d1': minor
---

A list filter can now carry more than one condition on a field, so a list answers ranges. Repeat the query parameter (`GET /api/v1/deals?expected_close_date=gte.2026-11-01&expected_close_date=lt.2026-12-01`), or send an array to an MCP tool (`{ "expected_close_date": ["gte.2026-11-01", "lt.2026-12-01"] }`); the conditions on a field, at most 4, are ANDed with each other and with every other filter, on every list, custom object list, `action_executions` and `deals.aggregate`. Only column filters repeat: any other repeated parameter is still `400 validation_error`. In the OpenAPI document each column filter parameter is now a string or an array of 1 to 4 strings, and carries `x-vibase-filter` with its `kind` and `operators`. The CLI keeps one string flag per filter for now.
