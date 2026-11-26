---
title: OAuth clients for your own apps
description: Register first-party OAuth clients so a browser app on its own origin can sign people in and call the API with a bearer token.
---

A web app you deploy yourself, such as a deals board or a note taker, can sign people in to your instance and call its API as the person who signed in. The app uses OAuth (authorization code with PKCE) and sends a bearer token; it needs no cookie from the instance, so it can live on any origin you control.

An owner registers one **first-party client** per app. Each has a stable `client_id`, fixed redirect URIs, its own scopes, and can be revoked on its own.

## First-party clients and MCP clients

| | First-party client | MCP or other dynamically registered client |
| --- | --- | --- |
| Registered by | An owner, through the API | The client itself, over open registration |
| Consent screen | Skipped | Always shown |
| Redirect URIs and name | Fixed by the owner | Chosen by the client |

Open registration stays on for MCP clients. Registering a first-party client does not change it.

## Register a client

Only an owner can manage clients (`oauth_clients:read` and `oauth_clients:write`; neither can be granted to an agent). The operations exist on the workspace API, MCP and the CLI:

| Operation | REST | Purpose |
| --- | --- | --- |
| `oauth_clients.create` | `POST /meta/v1/oauth-clients` | Register a client. |
| `oauth_clients.list` | `GET /meta/v1/oauth-clients` | List first-party clients. |
| `oauth_clients.get` | `GET /meta/v1/oauth-clients/{client_id}` | Read one. |
| `oauth_clients.update` | `PATCH /meta/v1/oauth-clients/{client_id}` | Change name, redirect URIs, scopes or `skip_consent`. |
| `oauth_clients.delete` | `DELETE /meta/v1/oauth-clients/{client_id}` | Delete and revoke it. |

```bash
vibase oauth-clients create --data '{
  "name": "Deals board",
  "redirect_uris": ["https://deals.example.com/callback"]
}'
```

The answer carries the `client_id`. There is no client secret: these are public clients that rely on PKCE.

| Field | Rule |
| --- | --- |
| `name` | 1 to 100 characters. |
| `redirect_uris` | 1 to 10. `https`, or `http` on `localhost` or `127.0.0.1`. No fragment, user info or `*`. Duplicates are removed. |
| `scopes` | Optional. Within the scopes an MCP client could register for, never an administrative scope. Omitted: the default scopes. |
| `skip_consent` | Omitted means `true`. `false` is refused for now. |

On update, `redirect_uris` and `scopes` replace the stored lists. An update revokes no token.

A person who signs in through a first-party client acts as themselves, and the token carries only the scopes you gave the client.

## Origin warnings

A browser app can only call the token endpoint and the API from an origin the instance allows. When you create or update a client, the answer includes `warnings`, one entry for each redirect origin that is not in `CORS_ALLOWED_ORIGINS`:

```json
{
  "code": "origin_not_allowed",
  "origin": "https://deals.example.com",
  "list": "CORS_ALLOWED_ORIGINS",
  "message": "https://deals.example.com is not in CORS_ALLOWED_ORIGINS: the app's browser calls to the token endpoint and the API will be refused until it is added"
}
```

The client is saved either way. The warning is a check at that moment: changing the variable later does not update it. An app on the API's own origin is never warned.

## Allow the app's origin

Two instance variables control which browser origins may call the instance. Both are comma-separated lists of exact origins, set on the Worker; empty means none.

| Variable | What it allows |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | Bearer-token calls to the REST API and `/mcp`, with no cookies. It also allows credential-free calls to the OAuth register and token endpoints. **A bearer-token app needs only this.** |
| `AUTH_TRUSTED_ORIGINS` | Cookie-based sign-in on `/auth` for first-party pages that share the API's registrable domain. Not needed for a bearer-token app. |

An entry can be a wildcard, `https://*.example.com` (or `http://*.localhost:5173`). It matches subdomains at any depth, never the bare host and never another scheme or port. List `https://example.com` separately if you need it.

A wildcard trusts everything that can serve from that zone. Do not use one that other people can publish under, such as `https://*.workers.dev` or `https://*.pages.dev`: it would allow every Cloudflare customer's apps. A wildcard in `AUTH_TRUSTED_ORIGINS` also gives every matched subdomain credentialed access to sign-in routes.

A malformed entry makes the instance refuse requests until fixed.

## Sign in from the app

The app runs a standard authorization code flow with PKCE against the endpoints in the instance's OAuth discovery document, sends no secret and calls the API with a bearer token. [Sign in from a browser app](/guides/browser-apps/) describes the flow step by step, with the TypeScript SDK's `browserSignIn()` and a troubleshooting list.

## Revoke a client

Deleting a client revokes it: its refresh tokens and consents go at once, so no new sign-in or refresh works. Access tokens already issued are refused within about a minute.

```bash
vibase oauth-clients delete <client-id>
```

Only first-party clients appear here. Clients registered by MCP tools and the CLI's own login are not listed and cannot be changed through these operations.
