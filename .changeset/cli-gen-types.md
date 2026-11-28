---
'@vibase/cli': minor
---

`vibase gen types --out <dir>` writes the typed SDK map of the instance you are signed in to: `operations.ts` and `types.ts` with its custom objects and `__c` fields, for `createClient({ operations })`. It needs `openapi-typescript` 7 (with `typescript` 5) in the project it runs in.
