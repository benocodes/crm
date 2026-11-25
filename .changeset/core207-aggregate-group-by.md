---
'@vibase/server-d1': minor
---

Every `<list>.aggregate` (contacts, companies, deals, tasks and each custom object; REST, MCP and `vibase <list> aggregate --group-by`) takes `group_by`: one or two comma-separated fields (uuid, text, integer or boolean columns except `id`, `__c` and custom object fields included). The answer keeps its top-level `count` and adds `groups`, one ungrouped answer per group beside its `key`, ordered by the group fields with the null group last. More than 200 groups is a 400, never a truncated answer. The one-currency rule for money is judged per group, so `deals/aggregate?group_by=currency&sum=amount_minor` answers one total per currency. `schema.get` lists each list's groupable fields as `aggregate.group_by`. No migration. The CLI derives its flag from the API, so `@vibase/cli` needs no release of its own.
