---
"@vibase/server-d1": patch
---

Built-in auth clients and discovery. `bootstrap --auth-provider better-auth --public-base-url <origin>` seeds the first-party `vibase-cli` client into the control database (idempotent; no human is created). Open dynamic client registration is limited to public clients, the agent-grantable scopes and the API and MCP resources, 10 registrations per IP per hour. `/.well-known/vibase` carries `resource` on `better-auth`, the protected-resource documents and the RFC 8414 document at `/.well-known/oauth-authorization-server/auth` name `PUBLIC_BASE_URL`. `vibase login` finds a path issuer by RFC 8414 path insertion (appended form only on a non-200) and sends `resource` on device authorization, polling and refresh when discovery names one.
