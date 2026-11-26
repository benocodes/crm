---
'@vibase/server-d1': minor
---

`CORS_ALLOWED_ORIGINS` and `AUTH_TRUSTED_ORIGINS` now accept a wildcard origin, `https://*.<host>[:port]` (`http://*.localhost:5173` too, where the variable allows `http`). It matches subdomains of `<host>` at any depth, never the bare host, another scheme or another port, and is the same pattern Better Auth uses for its own trusted origins. A matched origin is answered with its own `Origin` and `Vary: Origin`. Exact entries answer as before. There is no public-suffix guard: `https://*.workers.dev` trusts every Cloudflare customer, and a wildcard in `AUTH_TRUSTED_ORIGINS` gives every matched origin on the API's own site the session on `/auth`. `CLERK_AUTHORIZED_PARTIES` still refuses wildcards. The session cookie is unchanged.
