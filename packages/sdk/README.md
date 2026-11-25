# @vibase/sdk

The typed TypeScript client of a Vibase deployment ([[DX603]]). Workspace-internal (`private: true`, not published). One
fetch-only runtime for Node 22+, Workers and browsers: it imports nothing from `node:*` or `@vibase/*`.

```ts
import { createClient, isVibaseError } from '@vibase/sdk'

const vibase = createClient({ url: 'https://api.acme.example', auth: () => getToken() })

const page = await vibase.contacts.list({ limit: 50 })
await vibase.deals.moveStage({ id, stage_id })
```

## createClient

`createClient({ url, auth, fetch?, operations? })`

- **`url`** (required): the deployment's origin. One deployment per organisation.
- **`auth`**: a bearer token (a string), or a function returning `string | null` (or a promise of one), called before every
  request. `null` throws `401 no_credential` and sends nothing. The REST API accepts only bearer credentials: an API key,
  an OAuth access token, a Clerk session token or a Better Auth session JWT. Requests go out with `credentials: 'omit'` and
  `redirect: 'error'` (on workerd, which rejects that value, the client retries once with `manual` and refuses a redirect response as `unexpected_redirect`); a table path that would leave the configured origin is refused (`origin_mismatch`) before the
  credential is read. There is no automatic retry: a function that returns a fresh token on its own owns refresh.
- **`fetch`**: defaults to the global; inject one for tests.
- **`operations`**: the operation table, defaulting to the built-ins. A generated table infers its map ([[DX604]]).

## Calls

A client has one namespace per resource prefix and one method per operation, named from the operation id, camelCased:
`action_requests.approve` is `vibase.actionRequests.approve`, `deals.move_stage` is `vibase.deals.moveStage`. Data stays
snake_case, exactly as the API sends it.

A method takes the operation's flat arguments (path, query and body fields in one object) and an optional
`{ signal }`. It resolves to the success body; a `204` resolves `undefined`; `files.content` resolves the checked `Response`
for the caller to stream.

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

An abort rethrows the `AbortError` untouched.

## Regeneration

`src/generated/operations.ts` (the table) and `src/generated/types.ts` (the types) are generated from the `api` and `meta`
OpenAPI documents, built in-process from the production router. **Any change to an operation or its schema regenerates them:**

```bash
pnpm -C packages/sdk generate
```

The drift test (`src/generate/drift.test.ts`) fails until the committed files match. The generator is the Node-only entry
`@vibase/sdk/generate`; the runtime never imports it. `openapi-typescript` (a 7.x devDependency) needs `typescript` 5.x, so
this package pins `typescript` 5.9.3 beside the workspace's 7.x.
