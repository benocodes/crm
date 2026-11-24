---
'@vibase/server-d1': minor
---

A custom object's declaration can now hold reference fields (to companies, deals, tasks, principals or another custom object, with the live check and an index) and unique fields (409 `value_exists` naming the holder), and every declared field is a column filter with an honest index cost. `schema.get` describes a custom table from its declaration (`origin: custom`), lists an undeclared custom table as archived, and every table entry gains `archived`. Nothing in the Worker passes a declaration yet, so a deployment behaves as before apart from the extra `archived: false` on each table.
