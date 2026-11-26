# Browser sign-in example

A static page that signs a person in to a Vibase deployment from its own origin, with `browserSignIn()` from `@vibase/sdk`, shows who they are (`me.get`) and their first contacts, refreshes the token on demand and signs out. It is the reference for [Sign in from a browser app](../docs/src/content/docs/guides/browser-apps.md) and the demo of the browser sign-in work. It runs locally only: there is no deploy script, and hosting it is your call.

## Set up

1. **Register the client** (an owner does this), with this page's callback as its redirect URI:

   ```bash
   vibase oauth-clients create --data '{
     "name": "Browser app example",
     "redirect_uris": ["http://localhost:5180/callback"]
   }'
   ```

   Keep the `client_id` from the answer. The answer's `warnings` should be empty.
2. **Allow the page's origin** on the deployment: `CORS_ALLOWED_ORIGINS` must list `http://localhost:5180`. Do not add it to `AUTH_TRUSTED_ORIGINS`.
3. **Give the build its settings**: copy `settings.env.example` to `settings.env` (gitignored) and fill in `VIBASE_URL` (the deployment, for example `http://localhost:8787`) and `VIBASE_CLIENT_ID`. Environment variables of the same names win over the file. The build refuses, writing nothing, when either is missing.
4. **Run it**: `pnpm -C packages/browser-app-example dev` runs `build:app`, which builds the page into `dist/`, and serves it with `wrangler dev` on `http://localhost:5180`. `/callback` is served by the same page. Nothing is deployed and no remote resource is used.

The page passes no `scopes`, so the instance's default set applies and the app keeps working when new scopes are declared.

## The demo

Open `http://localhost:5180` and check each step:

1. The page shows "Sign in".
2. Click it. You go to the deployment's sign-in page (or straight through if you are already signed in there). **No consent screen appears.**
3. Back on `http://localhost:5180`, the page shows who you are with `principal: user` and your email, and lists the first contacts.
4. In the browser's network panel, the token request (`POST .../auth/oauth2/token`) has no `Cookie` header, and its answer has `Access-Control-Allow-Origin: http://localhost:5180` and no `Access-Control-Allow-Credentials`.
5. Reload: still signed in. Click "Refresh now": the list loads again after a `grant_type=refresh_token` request. Click "Sign out": "Sign in" returns, and signing in again needs no password (the deployment's own session stays) and no consent.
6. Delete the client (`vibase oauth-clients delete <client-id>`), then click "Refresh now": the refresh is refused and the page shows "Sign in" with a line saying the deployment signed the app out.

`pnpm -C packages/server-d1 e2e:browser-app` runs these steps in a real browser against a local deployment (see the header of `packages/server-d1/e2e/browser-app.e2e.ts`).

## How it works

- `src/app.ts` is the page. Every browser seam (fetch, location, navigate, history, storage) is injected, and `src/main.ts` wires the real ones.
- A `401` from the API (including no credential) signs the page out. A `403` (a removed person, a narrowed app) or any other error is shown inline with its code and the page stays signed in.
- "Refresh now" marks the stored access token expired in the page's own storage wrapper, so the SDK's next `token()` takes its refresh path. The SDK has no export for it.
- `pnpm -C packages/browser-app-example test` runs the build and page suites.
