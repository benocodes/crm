---
'@vibase/server-d1': minor
---

Owners can register, list, read and delete first-party OAuth clients on the meta API (`POST/GET /meta/v1/oauth-clients`, `GET/DELETE /meta/v1/oauth-clients/{client_id}`, also MCP tools and `vibase` CLI commands from the meta document), with the new owner-only scopes `oauth_clients:read` and `oauth_clients:write` (never granted to agents or dynamically registered clients). A client is public (PKCE, no secret), skips the consent screen and signs people in to your own web app as themselves; `skip_consent: false` is refused for now. Deleting a client is the revocation: its refresh tokens stop working at once and access tokens already issued last at most one more hour. Needs `AUTH_PROVIDER=better-auth`; other deployments answer `501 provider_not_configured`.
