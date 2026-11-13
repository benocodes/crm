---
"@vibase/server-d1": patch
"@vibase/cli": patch
---

The OpenAPI extension on tenant operations is now `x-vibase-proposal` (was `x-vault-proposal`), new executions default to a `@vibase.invalid` client reference, the local R2 bucket and Workflow are `vb-bodies` and `vb-mail-sync`, and the connect page's key variable is `VIBASE_API_KEY`.
