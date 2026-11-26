---
'@vibase/server-d1': minor
---

Owners can edit a first-party OAuth client (`PATCH /meta/v1/oauth-clients/{client_id}`, also an MCP tool): name, redirect URIs, scopes and `skip_consent` (the lists replace the stored ones; `skip_consent: false` is still refused). An edit revokes no token. Creating or editing a client now answers `warnings`: one entry for each redirect origin that is not in `CORS_ALLOWED_ORIGINS`, which means the app's browser calls to the token endpoint and the API are refused until it is added; the write happens either way. A client's redirect list also decides its stored type, so switching between an https and a loopback `http` redirect keeps sign-in working.
