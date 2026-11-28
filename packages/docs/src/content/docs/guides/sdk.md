---
title: TypeScript SDK
description: Call your instance from TypeScript with typed methods, typed filters, pagination and proposals.
---

`@vibase/sdk` is a typed client for your instance's REST API. Use it to build dashboards, scripts and custom front ends. It runs on Node 22 or newer, Cloudflare Workers and browsers, uses only `fetch`, and has no framework dependency.

```bash
npm install @vibase/sdk
```

The package is on npm and is released with the CLI and the server at the same version.

```ts
import { createClient, isVibaseError } from '@vibase/sdk'

const vibase = createClient({ url: 'https://crm.mycompany.com', auth: () => getToken() })

const page = await vibase.contacts.list({ limit: 50 })
await vibase.deals.moveStage({ id, stage_id })
```

## Create a client

`createClient({ url, auth, fetch?, operations? })`

- `url` is your instance's origin. One instance serves one organisation.
- `auth` is a bearer token, or a function that returns one (or a promise of one) and is called before every request. Returning `null` throws `401 no_credential` and sends nothing. The function owns refresh: there is no automatic retry.
- `fetch` defaults to the global one; pass your own in tests.
- `operations` is the operation table. It defaults to the built-ins; see [custom objects and fields](#types-for-custom-objects-and-fields).

The SDK sends **bearer tokens only**, because it calls the REST API, which does not accept cookies. The token can be:

- an API key,
- an OAuth access token, from an app registered as a [first-party OAuth client](/guides/oauth-clients/) (the [browser sign-in guide](/guides/browser-apps/) shows `browserSignIn()`, which produces one), or
- a Better Auth session token (a JWT) obtained with the `sessionToken` helper.

Requests go out without credentials from the browser's cookie jar, and the SDK refuses to send a credential to any origin other than `url`.

### Sessions in a browser

`sessionToken({ url })` returns an `auth` function for an app that shares the instance's registrable domain and is listed in its `AUTH_TRUSTED_ORIGINS`. It asks `GET <url>/auth/token` for a fresh JWT on every call, using the person's signed-in session, and returns `null` when they are signed out. Apps on other origins should use OAuth instead.

```ts
const vibase = createClient({ url, auth: sessionToken({ url }) })
```

## Calls

A client has one namespace per resource and one method per operation, camelCased from the operation id: `deals.move_stage` is `vibase.deals.moveStage`, `action_requests.approve` is `vibase.actionRequests.approve`. Data keeps the API's snake_case.

A method takes the operation's arguments (path, query and body fields in one flat object) and an optional `{ signal }`. It resolves to the response body, or to `undefined` for a `204`. Your editor completes every argument and result type.

## Filters

Column filters take a plain value (an equality) or an object of operators:

```ts
await vibase.tasks.list({
  created_at: { gte: new Date('2026-01-01'), lt: '2026-02-01T00:00:00Z' },
  status: { not: { in: ['done', 'cancelled'] } },
  assignee_id: { is: null },
  title: { ilike: 'renew*' },
})
```

Operands are typed by the field's kind, and an operator the field does not have is a type error. A field takes at most four conditions, counting `not`; more is a `400 validation_error` thrown before anything is sent. See [ranges and filters](/concepts/records/#filter-lists).

## Pagination

A method returns one page. Paginated operations also have `.all()`, an async iterable that follows the cursor until the end:

```ts
for await (const task of vibase.tasks.list.all({ limit: 100, status: 'open' })) {
  console.log(task.title)
}
```

Breaking out of the loop stops further requests.

## Aggregates

Contacts, companies, deals, tasks and every custom object have an `aggregate` method that takes the list's filters:

```ts
const open = await vibase.deals.aggregate({ status: 'open', sum: 'amount_minor' })

const perStage = await vibase.deals.aggregate({ group_by: ['stage_id', 'currency'], sum: 'amount_minor' })
for (const g of perStage.groups) console.log(g.key.stage_id, g.key.currency, g.count, g.sum.amount_minor)
```

`sum`, `avg`, `min` and `max` take one field or an array, and only fields the function accepts type-check. See [aggregation](/concepts/records/#count-and-sum).

## Proposals

An operation an agent may propose has `.propose(args, proposal)`, which creates an [action request](/concepts/permissions/) for a person to approve instead of acting directly. `reason` is required.

```ts
const request = await vibase.tasks.update.propose(
  { id, title: 'Renamed' },
  { reason: 'Matches the new naming' },
)
```

## Errors

Every failure rejects with a `VibaseError { status, code, message }`. Use `isVibaseError(e)` to check.

| Failure | status | code |
| --- | --- | --- |
| The API's error body | the response's | the API's |
| Another non-2xx answer | the response's | `http_<status>` |
| `fetch` rejected | `0` | `network_error` |
| A 2xx answer that is not JSON | the response's | `invalid_response` |
| `auth` returned `null` | `401` | `no_credential` |
| A path that would leave `url`'s origin | `0` | `origin_mismatch` |
| A redirect (never followed) | the redirect's | `unexpected_redirect` |

An aborted request rethrows the `AbortError`.

## Types for custom objects and fields

The default client types the built-in resources. To type your own [custom objects and `__c` fields](/guides/schema/), run the SDK's generator against your instance or your schema file. It writes two files, a full operation table and its types:

```bash
# from the running instance's public OpenAPI documents
pnpm -C packages/sdk generate --url https://crm.mycompany.com --out src/vibase
# from the schema file, offline, before a redeploy
pnpm -C packages/sdk generate --schema ./vibase.schema.json --out src/vibase
```

Commit the output and regenerate when the schema file changes. Pass the table to the client:

```ts
import { workspaceOperations } from './vibase/operations.js'

const vibase = createClient({ url, auth, operations: workspaceOperations })
await vibase.projects__c.list({ budget: { gte: 5000 } })
await vibase.sessionRecordings__c.list({ length_seconds: { gte: 30 } }) // the object `session_recordings__c`
await vibase.contacts.update({ id, tier__c: 'gold' })
```

A custom object's name follows each surface's own case rule and keeps its `__c` suffix: the SDK camelCases the stem (`sessionRecordings__c`), REST and the CLI use hyphens (`/api/v1/session-recordings__c`, `vibase session-recordings__c list`). Argument and field names stay `snake_case` everywhere in the SDK and the API.

Nothing checks at run time that the generated table matches the instance.
