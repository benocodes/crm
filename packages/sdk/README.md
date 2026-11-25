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
in each group. An optional `group_by` gives the union of both. A workspace's generated types (`generate --schema`) carry the
same typing for its custom objects and `__c` fields.

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

`sessionToken({ url, fetch?, cookie? })` is a credential function for a Better Auth browser session: it exchanges the
session cookie at `GET <origin>/auth/token` on every call (never cached) and resolves `null` when signed out (a `401`, or a
success without a `token`), which `createClient` turns into `401 no_credential` without sending the API request. In a
browser it sends `credentials: 'include'`; server-side, pass `cookie` (a string, or a function called once per request) to
send that cookie header with `credentials: 'omit'`. Other failures reject with `VibaseError` as above.

```ts
const vibase = createClient({ url, auth: sessionToken({ url }) })
```

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

## Regeneration

`src/generated/operations.ts` (the table) and `src/generated/types.ts` (the types) are generated from the `api` and `meta`
OpenAPI documents, built in-process from the production router. **Any change to an operation or its schema regenerates them:**

```bash
pnpm -C packages/sdk generate
```

The drift test (`src/generate/drift.test.ts`) fails until the committed files match. The workspace-map fixture the type tests compile
(`src/generate/fixtures/workspace/`) has its own drift check in `src/generate/workspace.test.ts`; regenerate it from the repo root:

```bash
pnpm -C packages/sdk generate --schema packages/sdk/src/generate/fixtures/workspace.schema.json --out packages/sdk/src/generate/fixtures/workspace
```
 The generator is the Node-only entry
`@vibase/sdk/generate`; the runtime never imports it. `openapi-typescript` (a 7.x devDependency) needs `typescript` 5.x, so
this package pins `typescript` 5.9.3 beside the workspace's 7.x.

## Workspace types

The built-in client types the built-ins only. A workspace's custom objects (`projects__c`) and `__c` fields on contacts,
companies, deals and tasks are declared in its schema file; the generator turns that workspace into a **full map**
(every operation, built-ins included) that `createClient` takes through `operations`. Two sources, one output directory:

```bash
# from the deployment: its two public OpenAPI documents (https; http only for localhost, 127.0.0.1, [::1]); no credential is sent
pnpm -C packages/sdk generate --url https://api.acme.example --out apps/pipeline/src/vibase
# from the schema file, built in-process: works offline, before a redeploy
pnpm -C packages/sdk generate --schema ./vibase.schema.json --out apps/pipeline/src/vibase
```

A relative `--schema` or `--out` resolves against the directory you ran the command from. `--out` is required with a source and
may not be this package's own `src/generated/`. The two files (`operations.ts`, `types.ts`) are deterministic: the header
names the command, the source (for `--schema` the file name and its SHA-256, the digest `/health.schema` reports) and the
documents' `info.version`, and there is no timestamp. Commit them and regenerate when the schema file or the release changes;
nothing checks at run time that the map matches the deployment.

```ts
import { createClient } from '@vibase/sdk'
import { workspaceOperations } from './vibase/operations.js'

const vibase = createClient({ url: 'https://api.acme.example', auth: () => getToken(), operations: workspaceOperations })
await vibase.projects__c.list({ budget: { gte: 5000 } }) // a custom namespace keeps its `__c` key, untranslated
await vibase.contacts.update({ id, tier__c: 'gold' }) // 'platinum' is a type error
```

`Client<WorkspaceOperations>` (from `./vibase/types.js`) is the type to pass around.
