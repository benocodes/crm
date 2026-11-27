---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

A custom object's name now follows each surface's case convention and keeps its `__c` suffix: a multi-word object `session_recordings__c` is served at `/api/v1/session-recordings__c` (its `schema.get` `path` says so), its CLI command is `vibase session-recordings__c <action>`, and a flag for a multi-word `__c` field is `--referral-source__c` (the request still carries `referral_source__c`). The old spellings are gone, with no alias: `/api/v1/session_recordings__c` is a 404 and `--referral_source__c` an unknown flag. Stored names, schema file keys, operation ids, MCP tool names, scopes, event types and every JSON or query field name keep the snake_case `__c` name; one-word objects such as `projects__c` and every built-in are unchanged. The generated SDK map (`@vibase/sdk`) names the namespace `sessionRecordings__c`. No migration.
