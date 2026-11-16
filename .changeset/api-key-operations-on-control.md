---
"@vibase/server-d1": minor
---

The API key operations (`api_keys.create`, `revoke`, `list`, `get`) now run on the control-plane database: a create or revoke writes its `control_audit` row and no `api_key.*` event, and keys held only in the CRM database by an earlier version are not listed, read or revocable through them (none are in use; they still authenticate until the CRM key table is retired).
