---
title: Sign in from a browser app
description: Register a first-party client, allow the app's origin, and sign people in from a static page with the SDK or by hand, with refresh, sign-out and troubleshooting.
---

A static web page on its own origin (a deals board, a notes taker, a dashboard) can sign a person in to your instance and call the API as that person, with no server of its own. It runs the OAuth authorization code flow with PKCE in the browser, keeps a bearer token and never holds a secret. This guide is for the developer who builds the page and the owner who registers it. [OAuth clients for your apps](/guides/oauth-clients/) covers the client's fields and the `CORS_ALLOWED_ORIGINS` rules in full.

`@vibase/sdk` does the whole flow in `browserSignIn()`. It is workspace-internal until it is published, so a page outside this repository follows the flow below by hand. The example app, `packages/browser-app-example`, is the reference: a small page that signs in, shows who you are and your contacts, refreshes and signs out.

## What the owner does

1. **Register a first-party client** with the page's exact redirect URI. The answer carries the `client_id`.

   ```bash
   vibase oauth-clients create --data '{
     "name": "Deals board",
     "redirect_uris": ["https://deals.example.com/callback"]
   }'
   ```

   `http` redirect URIs are accepted only on `localhost` and `127.0.0.1`, so a page under development can use `http://localhost:5180/callback`. A first-party client skips the consent screen.

2. **Add the page's origin to `CORS_ALLOWED_ORIGINS`** on the instance (an exact origin such as `https://deals.example.com`, or a wildcard, subject to the wildcard warnings in [OAuth clients](/guides/oauth-clients/#allow-the-apps-origin)). Do **not** add it to `AUTH_TRUSTED_ORIGINS`: that variable grants cookie-based access to the sign-in routes, which a bearer-token page does not need.

   If the origin is missing, creating the client still works and the answer carries an `origin_not_allowed` warning naming the origin and the variable. The warning is a check at that moment; fix the variable and the page works.

## What the page does

With the SDK:

```ts
import { browserSignIn, createClient } from '@vibase/sdk'

const signIn = browserSignIn({
  url: 'https://api.acme.example',
  clientId: 'the-client-id',
  redirectUri: `${location.origin}/callback`,
})
const vibase = createClient({ url: 'https://api.acme.example', auth: signIn.token })

// On every page load:
const done = await signIn.handleRedirect() // { returnTo } after a sign-in, else null
if (done) history.replaceState(null, '', done.returnTo)
if (!signIn.isSignedIn()) {
  // show a "Sign in" button that calls signIn.signIn()
}
```

Pass no `scopes` and the instance's default set applies, so the page keeps working when new scopes are declared. Pass `scopes` to ask for fewer or more; the SDK adds `openid offline_access`.

## The flow, endpoint by endpoint

A page that does not use the SDK makes the same requests. Every request it sends itself goes without cookies (`credentials: 'omit'`).

| Step | Request | Browser rule |
| --- | --- | --- |
| Find the deployment's OAuth settings | `GET <url>/.well-known/vibase` gives `auth.issuer` and `auth.resource`. Then `GET <issuer origin>/.well-known/oauth-authorization-server<issuer path>` gives the endpoints. | Both answer `Access-Control-Allow-Origin: *`. |
| Send the person to sign in | Navigate (a full page navigation, never `fetch`) to `authorization_endpoint` with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (`S256` of a random verifier), `code_challenge_method=S256`, `state`, and `resource` set to the `auth.resource` value. Add `scope` only to narrow or widen the default set. | A navigation, so the instance's own session cookie reaches it. A signed-out person sees the instance's sign-in page and comes back. |
| Come back | The browser lands on your `redirect_uri` with `code`, `state` and `iss`. Check that `state` is the one you sent and `iss` is the issuer, then remove the parameters from the address bar. | None: it is your own page. |
| Trade the code | `POST` the form `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `resource` to `token_endpoint`. No secret. | A listed origin gets `Access-Control-Allow-Origin: <your origin>` and no `Access-Control-Allow-Credentials`. |
| Call the API | `Authorization: Bearer <access_token>` on `/api/v1/...` and `/meta/v1/...`. | A listed origin may call with a bearer token and no cookie. |
| Refresh | `POST` the form `grant_type=refresh_token`, `refresh_token`, `client_id`, `resource` to `token_endpoint`. | As for the code trade. |

The authorization server's revoke, userinfo and end-session endpoints answer no CORS headers to a bearer page, so a page cannot call them.

The signed-in person acts as themselves, within their own role and the scopes of the client. `me.get` shows the principal: a `user`.

## Storage, refresh and sign-out

- **Storage.** The SDK keeps the token record in `sessionStorage`: it survives a reload and stays in one tab, so two tabs never race to refresh a single-use refresh token. A new tab signs in again, which asks for nothing while the instance's session lives. `'local'` shares the sign-in across tabs and `'memory'` keeps nothing; the SDK README lists them with the trade-offs.
- **Refresh.** Access tokens are short-lived. When under a minute remains, the SDK refreshes once and shares the answer between concurrent calls. A refresh the server answers `400` or `401` means the grant is gone: the SDK clears the record and treats the page as signed out. A network failure or a `5xx` keeps the record so the next call tries again.
- **Sign-out is local.** `signOut()` forgets the tokens on this device and sends nothing. The instance's own session stays, so signing in again returns without a password and without consent.

## Revoke an app

The owner deletes the client (`vibase oauth-clients delete <client-id>`). Its refresh tokens go at once, and access tokens already issued are refused within about a minute. The page's next call or refresh fails; it should sign out and show its sign-in button.

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| The browser console shows a CORS error on the token request or an API call | The page's origin is not in `CORS_ALLOWED_ORIGINS` (check scheme, host and port exactly). `AUTH_TRUSTED_ORIGINS` is the wrong variable. |
| The token request answers `invalid_client` | The `client_id` is wrong, or the owner deleted the client. |
| The authorize page reports a `redirect_uri` mismatch | The URI the page sends is not byte-for-byte one of the client's `redirect_uris`: check the scheme, port, path and trailing slash. Update the client, or the page. |
| The page reports `state_mismatch` | The callback's `state` is not the one this tab stored: the callback was opened in another tab or a second time, or storage was cleared in between. Sign in again from the page's button. |
| An API call answers `401` | The grant is gone: the owner deleted the client, or the token has expired and cannot be refreshed. Sign out and show the sign-in button. |
| An API call answers `403` | `organization_forbidden`: the person was removed. `insufficient_scope`: the owner narrowed the client's scopes. Signing in again does not help; show the error. |
