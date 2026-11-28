# @vibase/sdk

The typed TypeScript client of a Vibase deployment, for building custom front ends, dashboards and scripts on its REST API. One
fetch-only runtime for Node 22+, Workers and browsers, with no dependencies.

## Install

```bash
npm install @vibase/sdk
```

The package is ESM only and ships its own type declarations. It needs `fetch`, which Node 22, Workers and every current browser
provide.

```ts
import { createClient, isVibaseError } from '@vibase/sdk'

const vibase = createClient({ url: 'https://crm.acme.example', auth: () => getToken() })

const page = await vibase.contacts.list({ limit: 50 })
await vibase.deals.moveStage({ id, stage_id })
```

## createClient

`createClient({ url, auth, fetch?, operations? })`

- **`url`** (required): the deployment's origin. One deployment per organisation.
- **`auth`**: a bearer token (a string), or a function returning `string | null` (or a promise of one), called before every
  request. `null` throws `401 no_credential` and sends nothing. The SDK calls the REST API, which accepts only bearer credentials, so it never sends or
  stores a session cookie: an API key, an OAuth access token or a Better Auth session JWT (a Clerk session token on a Clerk instance). Requests go out with `credentials: 'omit'` and
  `redirect: 'error'` (on workerd, which rejects that value, the client retries once with `manual` and refuses a redirect response as `unexpected_redirect`); a table path that would leave the configured origin is refused (`origin_mismatch`) before the
  credential is read. There is no automatic retry: a function that returns a fresh token on its own owns refresh.
- **`fetch`**: defaults to the global; inject one for tests.
- **`operations`**: the operation table, defaulting to the built-ins. A generated table infers its map.

## Calls

A client has one namespace per resource prefix and one method per operation, named from the operation id, camelCased:
`action_requests.approve` is `vibase.actionRequests.approve`, `deals.move_stage` is `vibase.deals.moveStage`. Data stays
snake_case, exactly as the API sends it.

A method takes the operation's flat arguments (path, query and body fields in one object) and an optional
`{ signal }`. It resolves to the success body; a `204` resolves `undefined`; `files.content` resolves the checked `Response`
for the caller to stream.

## Filters

A list operation's column filters (`x-vibase-filter` parameters) take a bare operand (sent as `eq.<value>`, so a value such as
`is.gd` is a literal) or an object of the field's operators, one repeated condition per key; `not` carries a second object.
Operands are typed by the field's kind (a `timestamp` also takes a `Date`), and an operator the field lacks is a type error.

```ts
await vibase.tasks.list({
  created_at: { gte: new Date('2026-01-01'), lt: '2026-02-01T00:00:00Z' },
  status: { not: { in: ['done', 'cancelled'] } },
  assignee_id: { is: null },
  title: { ilike: 'renew*' },
})
```

`in` items holding `,`, `(`, `)`, `"` or a backslash are quoted for you. Each parameter takes at most the conditions its
OpenAPI schema allows (`maxItems`, 4 today), counting `not` keys; more is a `400 validation_error` thrown before anything is
sent. Other parameters (`limit`, `sort`, `after`) are sent as given.

## Pagination

A method returns one page. A paginated operation also has `.all(args?, { signal? })`, an async iterable of items that
follows `next_cursor` until it is `null` or empty. Every page keeps the other arguments (`limit` included) and the signal and
calls `auth` once; an `after` in `args` is ignored; a repeated cursor rejects with `invalid_response`. Breaking out sends
no further request.

```ts
for await (const task of vibase.tasks.list.all({ limit: 100, status: 'open' })) console.log(task.title)
```

## Aggregates

`vibase.<list>.aggregate(args?)` exists on contacts, companies, deals, tasks and every custom object. It is one method, typed
from the `x-vibase-aggregate` extension the API publishes on each aggregate operation, so the call site names only the fields
a function takes. `sum`, `avg`, `min` and `max` take one field or an array of them (a function with no field on the list has no
parameter); `group_by` takes one groupable field or a tuple of one or two. Filters are typed as for `list`. A comma-joined
string no longer type-checks; the client joins an array itself and refuses an empty one with
`VibaseError(400, 'validation_error', '<param>: give at least one field; nothing was sent')`. It checks no names, group cap or
duplicates: the server's own 400 comes back.

The answer is typed by what was asked: ungrouped it is `{ count }` plus the functions given and `currency` for a money field;
grouped it is `{ count, groups }` with `groups[].key` by field kind (always `| null`, the null group) and the same function keys
in each group. An optional `group_by` gives the union of both. Typing for a workspace's custom objects and `__c` fields needs
the generated workspace types (`vibase gen types`, see [Workspace types](#workspace-types)).

```ts
const total = await vibase.deals.aggregate({ status: 'open', sum: 'amount_minor' })
total.sum.amount_minor // number | null
total.currency.amount_minor // string | null

const perStage = await vibase.deals.aggregate({ group_by: ['stage_id', 'currency'], sum: 'amount_minor' })
for (const g of perStage.groups) console.log(g.key.stage_id, g.key.currency, g.count, g.sum.amount_minor)

await vibase.deals.aggregate({ sum: 'name' }) // compile error: sum takes amount_minor
```

## Proposals

A proposable operation also has `.propose(args, proposal, { signal? })`, which calls `action_requests.create` with the
operation id and the same flat `args` (path fields and `null`s kept), and resolves to the action request with `operation`
narrowed and `arguments` typed. `proposal` is the request's other fields; `reason` is required.

```ts
const request = await vibase.tasks.update.propose({ id, title: 'Renamed' }, { reason: 'Matches the new naming' })
```

## Browser sessions

The SDK itself only sends bearer tokens. `sessionToken({ url, fetch?, cookie? })` is a credential function for a Better Auth browser session: it exchanges the
session cookie (the only place a cookie is used) for a short-lived bearer JWT at `GET <origin>/auth/token` on every call (never cached) and resolves `null` when signed out (a `401`, or a
success without a `token`), which `createClient` turns into `401 no_credential` without sending the API request. In a
browser it sends `credentials: 'include'`; server-side, pass `cookie` (a string, or a function called once per request) to
send that cookie header with `credentials: 'omit'`. Other failures reject with `VibaseError` as above.

```ts
const vibase = createClient({ url, auth: sessionToken({ url }) })
```

## Browser sign-in

`browserSignIn(options)` signs a person in to a browser app that lives on its own origin (a dashboard, a deals board), with the OAuth
authorization-code flow and PKCE (`S256`), and hands `createClient` an access token. It serves Better Auth deployments only
(`unsupported_provider` otherwise), uses only `fetch`, Web Crypto and the page's own storage, and reads no browser global until a
verb runs. It sends no cookie: every request is `credentials: 'omit'`.

```ts
import { browserSignIn, createClient } from '@vibase/sdk'

const signIn = browserSignIn({
  url: 'https://crm.acme.example',
  clientId: 'the-client-id',
  redirectUri: `${location.origin}/callback`,
  scopes: ['contacts.read'], // optional
})
const vibase = createClient({ url: 'https://crm.acme.example', auth: signIn.token })

// On the callback page, once on load:
const done = await signIn.handleRedirect() // { returnTo } after a sign-in, else null
if (done) history.replaceState(null, '', done.returnTo)
else if (!signIn.isSignedIn()) await signIn.signIn() // the browser leaves for the sign-in page
```

### The verbs

- **`signIn({ returnTo? })`** stores one pending record (state, PKCE verifier, redirect URI and a same-origin `returnTo`, which defaults to the current page) in `sessionStorage` and navigates to the authorize endpoint. Its promise never resolves: the page is leaving. A `returnTo` on another origin rejects `invalid_return_to`.
- **`handleRedirect()`** answers `null` when the current URL is not the callback. On the callback it deletes the pending record first, checks `state` and `iss`, exchanges the code (no cookie, no client secret), stores the token record, removes the callback parameters from the address bar and resolves `{ returnTo }`. It does not navigate.
- **`token()`** is the `auth` function `createClient` takes. It returns the stored access token, refreshes it when less than 60 seconds remain (see Refresh), and resolves `null` when signed out.
- **`isSignedIn()`** is synchronous: true while a token record exists. It does not check expiry or the server.
- **`signOut()`** forgets the token and pending records on this device and sends nothing (see Sign-out).

### Options

| Option | Meaning |
|---|---|
| `url` | The deployment; only its origin is used. |
| `clientId` | The first-party client's id. |
| `redirectUri` | A redirect URI registered on that client, on the page's origin. |
| `scopes` | Omitted: no `scope` is sent and the instance grants its default set. Given: `openid offline_access` followed by these. |
| `storage` | Where the token record lives: `'session'` (default), `'local'`, `'memory'`, or an object with `getItem`, `setItem` and `removeItem`. The pending record is always in `sessionStorage`. |
| `fetch`, `location`, `navigate`, `replaceUrl`, `sessionStorage` | Injection points for tests and unusual hosts. |

Records are keyed by the deployment's origin and the client id, so two clients on one page do not see each other. If the chosen
storage throws or is absent (a private window, blocked site data), the SDK falls back to memory for the life of the page.

### What the app needs

- **A first-party client**, created by an owner with `oauth_clients.create`, whose `redirect_uris` include the exact `redirectUri`. A client of this kind signs people in without a consent screen.
- **The app's origin in `CORS_ALLOWED_ORIGINS`** on the deployment (not `AUTH_TRUSTED_ORIGINS`): the token endpoint and `/api` answer the browser's cross-origin requests only for listed origins.
- **On a Better Auth deployment** the signed-in person acts as themselves: within their own role and the app's scopes. An app whose scopes are left to the default gains new scopes as they are declared. The SDK decodes no token and assumes no principal.

### Storage and tabs

`sessionStorage` (the default) keeps the sign-in to one tab: a new tab signs in again. `'local'` shares it across tabs, and then two tabs
can refresh at the same time. Single-flight (below) is per sign-in object, so it does not coordinate tabs; when a refresh token is
rotated, the tab that loses the race can find its token refused and be signed out. Use `'session'` unless you need the shared sign-in.
`'memory'` survives only the page.

### Refresh

When less than 60 seconds remain, `token()` refreshes once at the token endpoint (`grant_type=refresh_token`, with `client_id` and
`resource`) and stores the answer. A new `refresh_token` replaces the old one; an answer without one keeps it. Concurrent calls share one
request and one answer, and a refresh that finishes after `signOut()` (or after another sign-in stored a different record) stores
nothing and resolves `null`. An expired token with no refresh token resolves `null` and clears the record.

A failed refresh is one of two kinds, and they need different handling:

- **The grant is gone** (the server answered `400` or `401`): the record is cleared and `token()` resolves `null`. The app is signed out; show the sign-in button.
- **The refresh could not be completed** (`fetch` threw: `network_error`; a `5xx` or another status: rejects with that status; an unusable `200`: `invalid_response`): `token()` rejects and the record is kept, so the next call tries again. The app can retry or tell the person to try later.

### Sign-out and revocation

`signOut()` is local. It calls no revoke or end-session endpoint (neither answers a browser app's cross-origin request), so a token that was
already issued stays valid until it expires. The owner's revocation is deleting the client (`oauth_clients.delete`): the next refresh is refused and the app is signed out.

### A 401 from the API

The SDK never retries. A `401` from `/api` for a token `token()` returned rejects as `VibaseError 401` and leaves the record alone. It means the token is no longer accepted, chiefly because the owner deleted the app (refused within about a minute). Call `signOut()` and show the sign-in button. A removed person gets `403 organization_forbidden` and a narrowed app gets `403 insufficient_scope` for operations outside its list; refresh cures neither.

### Errors

Every failure is a `VibaseError { status, code, message }`.

| Code | status | When |
|---|---|---|
| `unsupported_provider` | 0 | The deployment is not Better Auth. |
| `discovery_failed` | 0 | A discovery document is missing, not `200`, or lacks what is needed (including S256). |
| `issuer_mismatch` | 0 | The metadata, or the callback's `iss`, names another issuer. |
| `endpoint_origin` | 0 | An endpoint is not a URL or is not on the issuer's origin. |
| `insecure_issuer` | 0 | The issuer is not `https` (`http` is allowed on `localhost` and `127.0.0.1`). |
| `invalid_return_to` | 0 | `returnTo` is not a URL on the page's origin. |
| `state_mismatch` | 0 | The callback matches no sign-in this page started (or it was already used). |
| `authorization_failed` | 0 | The callback carries an `error`; the message holds it and its description. |
| `invalid_response` | the response's | A `200` from the token endpoint without an access token and a numeric `expires_in`. |
| `network_error` | 0 | `fetch` rejected. |
| the OAuth `error` (`invalid_grant`, `invalid_client`, ...) | the response's | The token endpoint refused the code exchange, or a refresh failed with a status other than `400`/`401` and a body naming one. |
| `http_<status>` | the response's | The token endpoint answered a failed refresh with no OAuth `error`. |

## Errors

Every failure rejects with a `VibaseError { status, code, message }`; `isVibaseError(e)` is the guard.

| Failure | status | code |
|---|---|---|
| The API's `{ error: { code, message } }` | the response's | the API's |
| Another non-2xx | the response's | `http_<status>` (message holds an excerpt) |
| `fetch` rejected | `0` | `network_error` |
| 2xx whose JSON does not parse | the response's | `invalid_response` |
| `auth` returned `null` | `401` | `no_credential` |
| A path that leaves the origin | `0` | `origin_mismatch` |
| A 3xx answer (never followed) | the 3xx status | `unexpected_redirect` |
| A path argument is missing | `0` | `invalid_argument` |

An abort rethrows the `AbortError` untouched.

## Workspace types

The built-in client types the built-ins only. A workspace's custom objects (`projects__c`) and `__c` fields on contacts,
companies, deals and tasks are declared in its schema file; a generated map of every operation (built-ins included) gives them
types, and `createClient` takes it through `operations`:

```ts
import { createClient } from '@vibase/sdk'
import { workspaceOperations } from './vibase/operations.js'

const vibase = createClient({ url: 'https://crm.acme.example', auth: () => getToken(), operations: workspaceOperations })
await vibase.projects__c.list({ budget: { gte: 5000 } }) // a one-word custom object keeps its key
await vibase.sessionRecordings__c.list({ length_seconds: { gte: 30 } }) // `session_recordings__c`: the stem is camelCased, the `__c` suffix kept; argument keys stay snake_case
await vibase.contacts.update({ id, tier__c: 'gold' }) // 'platinum' is a type error
```

A custom object's namespace is its key with the stem camelCased and the `__c` suffix kept (`session_recordings__c` is
`vibase.sessionRecordings__c`); the arguments and the results keep the snake_case names of the API.

Generate the map with the Vibase CLI, which reads your instance's own documents (no login is needed for them):

```bash
npm i -D @vibase/sdk openapi-typescript@7
npx vibase gen types --out src/vibase --server https://crm.acme.example
```

It writes `src/vibase/operations.ts` and `src/vibase/types.ts`. `openapi-typescript` 7 is the project's own dependency and needs
`typescript` 5 where it resolves (a project on TypeScript 7 adds `typescript@5` for it). Commit the two files and run the command
again when the schema file or the release changes; nothing checks at run time that the map matches the deployment. Without the
map the client still works against any deployment; the custom objects are simply untyped by the built-in table.
