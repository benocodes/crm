---
name: mcp-auth-serving
description: How Vibase serves OAuth for MCP clients (Claude web connectors, Claude Code, other agents) on Better Auth - discovery documents, dynamic client registration, the token auth methods, cold-start budgets, and how to debug a connector that "couldn't register". Read whenever you touch packages/auth's oauth-provider setup, the /mcp or /.well-known routes, DCR policy, or the Worker's placement and caching, and before debugging any MCP client that fails to connect.
---

# Serving MCP auth (Better Auth on a Worker)

Learned on `hq` ([[OPS252]], #252, decisions 283.20 and 252.3), by guessing first and reading references second.
**Read the client's docs and a working reference server before changing anything; add logging before the second attempt.**
References that worked: Claude's MCP connector docs, Cloudflare's `workers-oauth-provider`, the Better Auth `oauth-provider` plugin.

## What Claude web does (observed)

1. Calls `/mcp` unauthenticated, reads `WWW-Authenticate` and RFC 9728 protected-resource metadata (scopes listed there).
2. Fetches RFC 8414 metadata with **path insertion**: issuer `https://<host>/auth` means `/.well-known/oauth-authorization-server/auth`.
3. Registers by DCR (RFC 7591) with `token_endpoint_auth_method: client_secret_post`, **all** PRM scopes, redirect `https://claude.ai/api/mcp/auth_callback`.
4. PKCE S256 authorize, then the token exchange.

Budgets: its connection check gives up after **5 s** ("some checks were skipped because the server took longer than 5 seconds", then the user must pick "Register automatically" by hand); discovery, registration and token endpoints get 10 s. Callers come from `160.79.104.0/21` and from many colos, so the first request hits a **cold isolate**.

## Rules

- **Accept all three methods at registration**: `none`, `client_secret_post`, `client_secret_basic`. An absent method becomes `none`. Refuse only what we cannot verify (`private_key_jwt`) and out-of-policy scopes or resources. Forcing public-only broke Claude web (400 `invalid_client_metadata`, surfaced as "Couldn't register").
- **Advertise what we accept.** Metadata `token_endpoint_auth_methods_supported` is `none`, `client_secret_basic`, `client_secret_post`. The library's own document also lists `private_key_jwt`; we serve our own (see below).
- **Serve the RFC 8414 document from config, not the database** (`staticAuthServerMetadata` in `packages/auth/src/auth.ts`). Built through the library it took 3.4 s cold, past the 5 s check. A drift test compares it with the library's document; keep it green.
- **A static answer must not leave provider init pending.** Better Auth builds on the first request; if that request returns without awaiting `auth.$context`, workerd cancels the init promise ("promise created by a request that has since ended") and the next request, e.g. `/auth/oauth2/authorize`, 500s. `createAuth` takes `keepAlive` (the Worker's `waitUntil`); do not drop it.
- **Answer before the app loads** (#522): `packages/server-d1/src/early.ts` answers the unauthenticated `POST /mcp` 401 (Origin rule first), the two protected-resource documents and the path-inserted metadata from variables alone, and `worker.ts` loads the composition by dynamic `import()` only for the rest. Measured on a fresh `smoked1` deploy from a colo beside the database: `/mcp` 401 0.53 s to 0.14 s, metadata 0.60 s to 0.07 s; the warm 401 had cost as much as the cold one, so the time was D1 round trips (migration check, marker read), not module load. Keep `early.ts` free of the composition, `@vibase/api`'s index and Better Auth; its list of scopes (`declared-scopes.ts`) must equal the registry's (`early.test.ts` fails on drift), and `early.test.ts` compares each early answer with the composition's. Anything it is unsure of returns `undefined` and takes the full path.
- **Placement:** `placement: { mode: "smart" }` on the env keeps the Worker near D1 (WEUR); US colos were adding 2-3 s to discovery. Pre-warming or caching is the next lever if cold starts still bite.
- **Client endpoints are owner-only** ([[CORE577]] D10): the `clientPrivileges` hook (`ownerOnlyClientPrivileges`, fed `clientOwner` by the composition from the live Vibase role) refuses every action for a non-owner and fails closed. The pinned `@better-auth/oauth-provider` calls it from `/oauth2/register` **only when the request carries a session**: unauthenticated DCR (what MCP clients do) never reaches it, while a registration carrying a member's session gets 401.
- **Rate limits live in D1:** registration is capped at 10 per hour per IP. Probing from your own machine locks you out; test from another IP or wait.
- CORS `*` on discovery documents; `Cache-Control` on the static metadata.
- **`/auth` has three CORS answers** (`compose.ts`'s `/auth` branch, [[API622]] D5–D7, [[API625]]), chosen in this order:
  an origin `AUTH_TRUSTED_ORIGINS` matches gets the credentialed answer on every `/auth` path ([[UI255]] D7); otherwise an
  origin `CORS_ALLOWED_ORIGINS` matches gets the credential-free answer (`withBearerCors`: the origin and `Vary: Origin`,
  never `Allow-Credentials`, a fixed `204` preflight with `POST` and `Content-Type` before the gates) on exactly the
  pathnames `/auth/oauth2/register` and `/auth/oauth2/token`, compared literally; the metadata document keeps the
  plugin's `*`. Better Auth's CSRF origin check runs only on cookie-bearing requests, so a cookie-less register or token
  call from an untrusted origin reaches the handler. Answers set `Access-Control-Allow-Origin` (never append: two values
  break the browser) and keep the plugin's other headers. A new credential-free path is a spec decision, not a list edit.
  Proofs: `packages/server-d1/src/oauth-cors-workerd.test.ts`.

## Writing `auth_oauth_*` rows by hand

The control store writes first-party clients with its own SQL ([[CORE623]] D6, `packages/storage-d1/src/control-store.ts`). Facts of `@better-auth/oauth-provider` 1.7.22 that such a writer, or its tests, depends on (623.24, 623.37, the cycle's RESULT):

- Copy encodings from a row the library wrote, and prove them by comparing a store-written row with one the library's own adapter wrote, column by column (`packages/server-d1/src/oauth-client-store-workerd.test.ts`). A registered client's `created_at`/`updated_at` are whole seconds; `auth_oauth_resources` keeps `custom_claims` and `metadata` as text `'null'`, booleans `0`/`1`.
- An access token issued for a resource is a JWT: it leaves **no** `auth_oauth_access_tokens` row, so a test cannot show that table non-empty before a revocation.
- Authorize answers an unknown `client_id` with status 200 and `{ redirect: true, url: '/auth/error?error=invalid_client' }` when fetched, not a 4xx.
- `skip_consent` is honoured for a signed-in user: authorize redirects straight to the client with a code, no `/app/consent`.
- The access token's audience is bound by **authorize's** `resource`, not the token request's: a code exchange without `resource` still yields a token `/api` accepts when authorize carried it; drop it from both and `/api` answers 401. A test that proves the audience binding mutates authorize too ([[DX624]] 624.26; `packages/server-d1/src/browser-sign-in-workerd.test.ts`, M15). Whether refresh's `resource` matters is #636's to establish.
- A client is first-party when `reference_id` is the organisation id and `user_id` is null ([[CORE623]] D5): the 7-day sweep skips it, the library's own client endpoints cannot change it, and deleting an auth user does not cascade it.

## Debugging a connector that will not connect

1. `wrangler tail --env <env>` (JSON) while the user retries; the `[oauth-register]` line in the before-hook logs method, grants, scope count, redirects, client name. Keep it.
2. Reproduce the client's calls with curl: PRM, path-inserted metadata, a DCR POST with `client_secret_post`. Time each cold.
3. The client's own error ("Couldn't register with ...", an `ofid_...` reference) says nothing; the tail does. Match the failing endpoint and status to the table below.

| Symptom | Cause found |
|---|---|
| "Couldn't register" | registration returned 400 (method refused) |
| "checks skipped, took longer than 5 seconds", manual "Register automatically" | cold metadata fetch too slow |
| Registers, then 500 on `/auth/oauth2/authorize` | init promise cancelled (missing `keepAlive`) |
| Registration slow (about 5 s cold) | open: #404 |

Production changes to `hq` are a hard stop for agents; the user authorised iterating there for this one fix only.
