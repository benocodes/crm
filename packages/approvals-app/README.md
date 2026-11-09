# approvals-app

A small static page for reviewing what agents have proposed: lists `action_requests` (Pending, Executed, Failed, Rejected),
shows the operation, reason and arguments, and approves or rejects with an optional note. No framework, no server code: built
by esbuild into `dist/` and served by Cloudflare Workers Static Assets at `app.hq.vibase.ai`. Sign-in is Clerk (clerk-js from
the instance's Frontend API); the page calls the vault's REST API (`/api/v1/action-requests…`) with the session token as a Bearer.

```bash
pnpm -C packages/approvals-app test && pnpm -C packages/approvals-app typecheck
pnpm -C packages/approvals-app build        # APPROVALS_API_ORIGIN / APPROVALS_CLERK_ISSUER / APPROVALS_CLERK_PK override the hq defaults
pnpm -C packages/approvals-app dev          # wrangler dev on :8788 (the origin must be allowed by the API, see below)
```

## Deploy (user only: a hard stop for agents)

1. **Vault first:** `wrangler.jsonc` in `server-d1` adds `https://app.hq.vibase.ai` to `CORS_ALLOWED_ORIGINS` and
   `CLERK_AUTHORIZED_PARTIES` for `hq`. Deploy `vault-hq` (`deploy:remote -- --env hq`) so the browser calls are allowed and the
   Clerk token's `azp` is accepted.
2. **App:** `CLOUDFLARE_ACCOUNT_ID=… pnpm -C packages/approvals-app deploy:remote` (creates the `app.hq.vibase.ai` custom domain).
3. Clerk: `app.hq.vibase.ai` is a subdomain of the production instance's domain, so the session cookie is shared; if sign-in
   bounces, add it as an allowed origin in the Clerk dashboard.

A signed-in user sees what their principal may read; approving needs the target operation's `write` authority ([[AGT8]]).
Not in v1: editing arguments before approval (`edited_arguments`), withdraw, and live push (the page polls every 30 s).
