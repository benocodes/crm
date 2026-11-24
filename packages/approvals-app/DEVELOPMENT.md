# approvals-app

A small static page for reviewing what agents have proposed: lists `action_requests` (Pending, Executed, Failed, Rejected),
shows the operation, reason and arguments, and approves or rejects with an optional note. No framework, no server code: built
by esbuild into `dist/` and served by Cloudflare Workers Static Assets at `app.hq.vibase.ai`. At load the page reads the API origin's
`/.well-known/vibase` and signs in with the provider it reports: Clerk (clerk-js from the instance's Frontend API) or Better Auth (the
`better-auth/client` SDK against the API origin's `/auth`). Each provider is its own chunk behind a dynamic `import()`, so an instance
never downloads the other's code. The page calls Vibase's REST API (`/api/v1/action-requests…`) with the session token as a Bearer.

```bash
pnpm -C packages/approvals-app test && pnpm -C packages/approvals-app typecheck
pnpm -C packages/approvals-app build        # APPROVALS_API_ORIGIN / APPROVALS_CLERK_ISSUER / APPROVALS_CLERK_PK override the hq defaults
pnpm -C packages/approvals-app dev          # wrangler dev on :8788 (the origin must be allowed by the API, see below)
```

## Better Auth instances

The Better Auth path needs the app and the API on **one registrable domain** (for example `app.example.com` and `api.example.com`):
the session cookie is sent credentialed across the two origins, which browsers allow for same-site origins only. **It does not work
on `workers.dev`** (a public suffix: every `*.workers.dev` is a different site), and no code enforces this. To configure it:

- on the Worker, add the app's origin to **both** `AUTH_TRUSTED_ORIGINS` (credentialed CORS on `/auth/*`, and the return target of
  `/app/sign-in`) and `CORS_ALLOWED_ORIGINS` (the REST calls);
- build the app with `APPROVALS_API_ORIGIN=<the Worker's origin>` (the Clerk variables are not needed);
- Sign in sends the person to the vault's `/app/sign-in` with `return_to` set to the app's URL, and back.

`pnpm -C packages/server-d1 e2e:approvals-app` runs the whole flow locally in a browser (prerequisites in `e2e/approvals-app.e2e.ts`).

## Deploy (user only: a hard stop for agents)

1. **Vibase first:** `wrangler.jsonc` in `server-d1` adds `https://app.hq.vibase.ai` to `CORS_ALLOWED_ORIGINS` and
   `CLERK_AUTHORIZED_PARTIES` for `hq`. Deploy `vault-hq` (`deploy:remote -- --env hq`) so the browser calls are allowed and the
   Clerk token's `azp` is accepted.
2. **App:** `CLOUDFLARE_ACCOUNT_ID=… pnpm -C packages/approvals-app deploy:remote` (creates the `app.hq.vibase.ai` custom domain).
3. Clerk: `app.hq.vibase.ai` is a subdomain of the production instance's domain, so the session cookie is shared; if sign-in
   bounces, add it as an allowed origin in the Clerk dashboard.

A signed-in user sees what their principal may read; approving needs the target operation's `write` authority ([[AGT8]]).
Not in v1: editing arguments before approval (`edited_arguments`), withdraw, and live push (the page polls every 30 s).
