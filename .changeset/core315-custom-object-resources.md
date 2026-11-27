---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

A custom object declared as plain data is now served by the generic layer on D1: full CRUD with soft delete, events, scopes, proposals and associations, under its one `<key>__c` name. Nothing in the Worker passes a declaration yet (the schema file arrives in a later release), so a deployment behaves as before. The CLI spells a custom object's command and a `__c` flag with the same kebab rule as a built-in's, keeping the `__c` suffix (`session-recordings__c`, `--referral-source__c`).
