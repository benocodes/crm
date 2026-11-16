---
"@vibase/server-d1": minor
---

Every API key the bootstrap makes now lives in the control-plane database, with its `api_key.created` audit row, and none in the CRM database: `bootstrap` (local and `--remote`), `vibase-server setup` and `setup:remote` write the operator key there, and a bootstrap that would make a key without a control database is refused before either database is written. If the control write fails after the CRM rows commit, the run fails naming the organisation and the agent, and the key is made with `api_keys.create`.
