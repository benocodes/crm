---
name: api-routes
description: Patterns for the vault's backend in packages/api — the operation registry (zod in/out, scope, handler), resource definitions with generic CRUD, commands, the service context, the events outbox, Hono + Kysely routes, and integration tests on a production-like tenancy pool. Use when adding or changing an operation, a resource, a command, a route, middleware, or writing tests against the backend.
---

# API: operations, resources, routes

Reference for backend work in `packages/api`. The design is in `knowledge/architecture.md` (§3–§9, §11); this
skill is how to write it. It is a rewrite around the vault's model of the predecessor's `api-routes`: the Hono and
Kysely mechanics carry over, the per-route bespoke style does not.

The shape, top down:

```
REST (@hono/zod-openapi)   MCP tools (Workers)   CLI (later)
          \                    |                   /
           +--- operation registry (zod in/out, scope, handler) ---+
                          |
     resources (generic CRUD from a definition) + commands (merge, send, accept…)
                          |
       service context: transaction, actor, scopes, tenancy
                          |
          Postgres (Hyperdrive) ── outbox: events table (same transaction)
```

**What exists:**
- **Service layer** ([[CORE12]]):
  - `src/errors.ts` (`ApiError`, `mapDatabaseError`);
  - `src/scopes.ts` (`ScopeSet`);
  - `src/outbox.ts` (`writeEvent`);
  - `src/context.ts` (`withContext`, `withAccountContext`);
  - `src/resources/{define,crud,tasks}.ts`.
- **Registry and HTTP** ([[CORE15]]):
  - `src/registry.ts` (`Registry`, `resourceOperations`, `toolName`);
  - `src/operations.ts` (`createVaultRegistry`, where new resources and operations are added);
  - `src/rest/{app,errors,openapi}.ts` (`createApp`, `renderError`);
  - `src/auth/{types,api-keys,middleware}.ts`;
  - `src/bootstrap.ts` and `scripts/bootstrap.ts`;
  - `src/dev-server.ts`.
- **Human auth** ([[CORE3]] cycle 1):
  - `src/auth/adapter.ts` (`AuthAdapter`, `createAuthAdapter(env)`, `parseOriginList`), `src/auth/clerk.ts`;
  - `src/auth/first-sight.ts` (`lookupUser`, `provisionUser`), `src/auth/organization.ts`
    (`resolveActiveOrganization`), `src/auth/roles.ts` (`SCOPE_POLICY`, `scopesForRole`, `grantableScopes`),
    `src/auth/user-authenticator.ts` (`createUserAuthenticator`); `AuthFailure` lives in `src/auth/adapter.ts`;
  - `src/account/` (`me.get` only; organisations and memberships come from Clerk, [[CORE29]]);
  - `scripts/smoke-auth.ts` (`SMOKE_EXPECT_DATABASE=<db> pnpm -C packages/api smoke:auth`: local key pair, fake
    Clerk API, real app; it also runs the identity-model flow). It refuses to run unless `current_database()`
    equals `SMOKE_EXPECT_DATABASE`, because an exported `DATABASE_URL` overrides `--env-file` ([[CORE36]]).
- **Administration** ([[CORE3]] cycle 2, [[CORE27]]):
  - definitions `src/resources/{memberships,agents,api-keys}.ts` (`memberships` is read-only, written only
    by the directory sync; `agents` validates scopes with `normalizeAgentScopes`; `api_keys` is read-only, `softDelete: false`);
  - `src/admin/` (`users.list`, `users.get`, `api_keys.create`, `api_keys.revoke`: `adminOperations()`);
  - `src/directory/` ([[CORE29]]): `repairMembership` (the token claim repairs one user's membership),
    `reconcileOrganization` (fetch-and-reconcile one Clerk organisation), `refreshUser`, `systemPrincipalId`
    (created on first use) and `clerkWebhookHandler`, mounted as `POST /webhooks/clerk` by `createApp` only
    when an `authAdapter` is given. It is the first plain route: no auth middleware (the Svix signature is
    its credential), not in OpenAPI, `c.var.db` only. Directory events are attributed to the system principal;
  - admin-kit (`src/test/admin-kit.ts`): `call(path, sub, { org })` mints the organisation claim from the copy
    (`claim` overrides, `header` sends `x-organization-id`), `webhook(payload)` posts a signed delivery,
    `seedOrg` links the organisation and mirrors it in the fake Clerk (`k.clerk.organizations`, `.members`);
  - `scripts/smoke-admin.ts` (`pnpm -C packages/api smoke:admin`, same scaffolding as `smoke-auth.ts`, without the
    database guard yet: confirm the database it prints before trusting it).
- **Test helpers** in `src/test/`:
  - `tenant.ts` (`seedTenant`, `asUser`, `asAgent`);
  - `keys.ts` (`seedApiKey`);
  - `user-auth.ts` (`mintTestUserToken`, `fakeUserAuthenticator`: a stand-in for the contract suite);
  - `clerk.ts` (`testIssuer`, `mintClerkToken`, `fakeClerkFetch`, `testClerkAdapter`: real verification
    with a locally generated RS256 key pair; no test calls Clerk);
  - `admin-kit.ts` (`useAdminKit()`: per-file setup for suites that need **real** roles: a real
    authenticator over the fake Clerk issuer, `call(path, sub, init)` per Clerk subject, `keyCall` per API
    key, `profile`, `seedOrg` (owner `o` and member `m`), `seedKeyedAgent`, `userId`, and `events()` in
    write order). Use it for any test that checks who may do what, instead of `fakeUserAuthenticator`;
  - `contract.ts` (`runContractSuite`);
  - `fixtures.ts`.
- **Not yet built:**
  - the Worker entry ([[OPS4]]);
  - MCP (after the MVP).

## The registry and the REST adapter ([[CORE15]])

- **An operation** is `{ kind: 'tenant' | 'account', name, summary, method, path, request?, validation?,
  response, handler }`. `scope` is required on tenant operations; account operations take none and are for
  users only (`403 user_required`).
  - `name` is dotted and lowercase (`contacts.merge`). It is the OpenAPI `operationId`, and `toolName`
    derives the CLI/MCP name from it (`contacts_merge`, at most 64 characters).
  - `path` uses OpenAPI form (`/contacts/{id}/merge`).
  - `register` throws at load on a bad name, an empty summary, a duplicate name or route, a 204 with a
    schema (or a non-204 without one), or an undeclared `{param}`.
- **Validation.** With `validation: 'adapter'` (the default), the adapter parses params, query and body
  with `request`; a failure is `400 validation_error`. Use `'handler'` only when the schema is chosen per
  request (generic CRUD, [[CORE10]]).
  - The body is read as text and `JSON.parse`d. No `Content-Type` is required, so agents can
    `curl -d`.
  - Don't use `createRoute` validators: they answer with their own error shape and a 415.
  - Plain zod 4 schemas document fine through `registerPath`.
- **Order inside a handler:**
  1. parse the input;
  2. tenant operations: `organization_forbidden` (the principal's flag), then `organization_required`,
     then the one scope check (`403 insufficient_scope`, `requires <scope>`). Account operations ignore
     both organisation flags and see `ctx.organizationId: null` instead;
  3. `withContext` / `withAccountContext`;
  4. respond with `c.json(result, status)`, or an empty 204.
  Any new transport (MCP) must apply the same order.
- **`createApp({ db: (c) => Kysely, registry?, authAdapter? | userAuthenticator?, corsOrigins?, version? })`.**
  - `authAdapter` builds the real authenticator over the registry's declared scopes; `userAuthenticator`
    is for tests and custom setups. Passing both throws, so a test can't silently run the fake.
  - `corsOrigins` empty or absent: no CORS middleware and no `Access-Control-*` header.
  - The db resolver runs once per request, in `app.use('*')`, and never at construction.
  - Auth is mounted on each registry route, never on `*`. A plain route the caller adds to the returned
    app (`/health`, a webhook receiver) gets `c.var.db`, no auth, and no OpenAPI entry.
  - `GET /openapi.json` is unauthenticated.
- **Errors.** `renderError` turns an `ApiError` into its own status and body, and
  `TenancyContextError(missing_organization)` into `403 organization_required`. Anything else is
  logged (`[api] unhandled`) and masked as `500 internal`. Unmatched routes and methods return
  `404 not_found`, `no such route`.
- **Resource definition knobs:**
  - `operations` (a CRUD subset; read-only definitions omit `create`/`update`);
  - `scopeResource` (share a scope, e.g. identities use `contacts:*`);
  - `rowFilter(ctx)` (extra equality conditions on list, get, update and delete; rows outside the
    filter are 404).
  - Routes are `resourcePath(def)`: `_` becomes `-`, so `api_keys` routes at `/api-keys`.

## Operations: define once, expose everywhere

Every operation is one registry entry: a name, input and output zod schemas, the **scope** it requires, and
a handler that receives the service context. REST routes and MCP tools are generated from the registry by
thin adapters, so the surfaces cannot drift apart and OpenAPI comes from the same schemas. Do not hand-write
a route or an MCP tool that bypasses the registry.

- Reads and writes go through the same registry. There is no second read path (no GraphQL, no direct table
  access from a handler).
- Commands are ordinary registry entries exposed as POST routes (`POST /contacts/{id}/merge`), so they get
  scopes, MCP tools and OpenAPI for free.
- There is no Hono RPC (`hc`) typing: a registry built in a loop gives no static route types. A TypeScript
  consumer that needs typed calls should generate a client from `/openapi.json` ([[CORE15]]).

## Resources: declarative definitions, generic CRUD

A resource (contact, company, task, deal, interaction) is a definition: table, zod schema, scopes,
validators, and which fields agents may write. Generic create, read, update, delete and list run from the
definition inside the service context. **Every write for a resource goes through that layer; nothing else
inserts into its table.** Keep definitions small and give each one an escape hatch (a validator or a custom
handler); a generic layer that tries to express every behavior turns into a framework to fight.

Adding a resource also means adding it to the **contract suite** (see Testing); don't hand-write those
tests.

**The definition** (`defineResource` in `src/resources/define.ts`; `agents.ts` is a worked example. `tasks`, `companies`, `contacts` and `identities` have moved to the prepared path below):
`name` (plural, scope resource), `eventName` (singular, event prefix), `table`, `record` (read schema, a
plain `z.object` so unlisted columns are stripped), `create`/`update` (`z.strictObject`, so unknown keys and
`organization_id`/`created_by` are `validation_error`), optional `agentWritable`, `filters` (each with a
`schema` and an optional `normalize(value, parsedFilters)`), `references` (`{ table, live? }`), and the
escape hatches:

| Hook | When it runs | Use it for |
|---|---|---|
| `inputSchema(ctx, op)` | instead of `create`/`update`, per request | custom fields ([[CORE10]]) |
| `beforeWrite(ctx, { op, input, before })` | after validation, agent and reference checks, inside the lock on update | derived columns (`completed_at`), invariants that read `before` or lock other rows, throwing an `ApiError` (409s) |
| `overrides.create(ctx, input, generic)` | after validation, agent and reference checks | `ON CONFLICT` inserts, multi-row creates, minting a parent row first (`agents`' principal) |
| `overrides.update(ctx, id, input, generic)` | after validation and the agent-field check, **before** the row lock | locking other rows before the target (`memberships`' last-owner guard) |
| `overrides.delete(ctx, id, generic)` | instead of the generic soft delete | cascading soft deletes, guards that lock other rows first |

- **`softDelete: false`** marks a table with no `deleted_at` (`agents`, `api_keys`: disabled or revoked,
  never deleted). List, get and the row lock drop the live-row condition, and `defineResource` refuses such
  a definition if it generates `delete` ([[CORE27]] P1). Don't add a never-set `deleted_at` column instead.
- **A guard that locks more rows than the target must lock them before the target.** `beforeWrite` runs
  inside the target's lock, so a guard there that also locks siblings takes the locks in the wrong order:
  two owners demoting each other at once each hold their own row and wait on the other's (`40P01`, an
  unmapped 500). Use `overrides.update`/`overrides.delete`: lock the sibling set `FOR UPDATE ORDER BY id`
  first, decide, then call `generic`. The second transaction waits, re-reads and gets the `409`
  (`guardLastOwner`, `src/resources/memberships.ts`, [[CORE27]] P2).
- **A response that carries a secret is a hand-written operation over a read-only definition.** The
  generic create emits its return value as the event's `after`, so a create that returns a plaintext key
  would put it in the outbox. `api_keys` generates only `list`/`get`; `api_keys.create` inserts, reads the
  record back through `getResource`, emits that, and returns `{ ...record, key }` ([[CORE27]] P6). The
  contract fixture names the route in `handwritten: ['create']`, so the suite's "not generated" case
  skips it.

- **An override that writes without calling `generic` must emit** with `emitResourceEvent(ctx, def, action,
  before, after, id)`.
- **References are checked on the parsed input, before `overrides.create` runs.** If an override changes a
  reference field before calling `generic` (or inserts itself), the new value is not checked: only the
  foreign key catches it, and a plain FK accepts another organisation's id (Postgres checks FKs without
  RLS). Re-check with a `SELECT` on `ctx.trx`, or rely on a composite `(organization_id, id)` FK.
- `defineResource` throws at module load on any of these:
  - a key named `custom` (reserved);
  - an unknown `agentWritable` field;
  - a bad `name` or `scopeResource`;
  - empty, repeated or unknown `operations`;
  - a generated create or update without its schema;
  - `softDelete: false` with a generated `delete`.
- **Generic reads and writes name their columns** (`readColumns(def)` = the keys of `record`). A column
  left out of `record` (`api_keys.key_hash`, `content_key`) is never selected, never returned and never
  in an event, so column-level grants work ([[CORE15]]). Never reintroduce `selectAll()` or
  `returningAll()` in `crud.ts`.
- **Known limits, owed by later plans:** filters are column equality only, and `toRecord` maps one flat
  row. Join filters and embedded child rows need definition hooks ([[CHN5]]).

## Prepared resources: the storage seam ([[CORE35]])

Resources are moving from the interactive layer above to **prepared operations**: a bounded program of
typed Kysely statements that runs as one atomic unit on Postgres (`@vault/storage-postgres`, enterprise)
or D1 (`@vault/storage-d1`, open). `tasks` is the first, and the worked example is
`src/resources/tasks.ts`; the identity model (`companies`, `contacts`, `identities`, resolve, merge, the
cascades) followed in [[CORE36]]. Until [[CORE41]] (the cutover), both paths coexist.

- **`definePreparedResource({ table, record, ... })`** (`src/storage/definition.ts`) infers the table from
  `table`. `RecordShape` makes every `record` key a public column of that table with a compatible type,
  so an unknown, secret or mistyped column is a compile error at the call. `computed` (a SQL expression
  over the stored row, e.g. the completion CASE) and `prepare` return values keyed and typed by column.
  Every hook is synchronous and DB-free. Prove each new call-site rule in
  `src/storage/definition.typecheck.ts`: an `@ts-expect-error` with a positive sibling, seen red.
- **The registry marks prepared operations `executor: 'prepared'`.** `run()` in `src/rest/app.ts` executes
  them through the binding from `createApp({ storage })` and never wraps them in `withContext`. **Every
  composition (`dev-server.ts`, the smoke scripts, test apps) must pass `storage`**; a prepared operation
  without one throws. Storage errors go through `mapStorageError`:
  - a foreign-key failure is `invalid_reference`;
  - drift, and a unique-index failure inside a unit (only a racing D1 writer can cause it), are `409 conflict`;
  - the cap is `set_limit_exceeded`;
  - a foreign organisation is `403 organization_forbidden`.
- **Generic writes compose three statements:** the mutation, `eventStatement` (an INSERT…SELECT that
  renders `after` from the stored row and is gated on the mutation having applied), and a result select
  gated on the event existing. Event `after` is therefore the stored row, never a recomputation.
- **An empty patch is a no-op** (existence check only, no event); **a same-value patch is a real update**
  (event, new `updated_at`; spec D22).
- **The application owns every timestamp, on both engines** ([[CORE36]] D2). A unit stamps `created_at`,
  `updated_at`, `deleted_at` and its events' `created_at` from its one injected `now`. Postgres has no
  `set_updated_at` trigger any more (migration 006), so a writer that does not set `updated_at` leaves it
  unchanged. Never write `now()` in a program.
- **`references: { col: { table, live? } }`** (principals, companies, contacts). The plan read
  (`400 invalid_reference`) and the commit guard use one predicate: id, plus `organization_id` when the
  target has it, plus `deleted_at IS NULL` when `live`. A create becomes `INSERT … SELECT … WHERE EXISTS`, an
  update gets an extra `WHERE EXISTS`; on D1 a vanished reference makes the write a no-op and the gated event
  and result turn it into drift.
- **`conflicts`** (extension 5): refusals decided from extra plan reads, such as a company domain or an
  identity address that is already taken. It returns `{ read, refuse(row | null) }` pairs. It is synchronous
  and DB-free, it gets the prepared (normalised) values, and it runs after the reference checks. The partial
  unique index is the commit-time re-check; a unique failure inside a unit maps to the retryable
  `409 conflict` ([[CORE36]] P4).
- **`override`** replaces a generated action with a concrete program. Its input is `{ after, limit, filters }`
  for list, the id for get and delete, the body for create, and `{ id, body }` for update. The cascades
  (`src/identity/cascades.ts`) are the `override.delete` of companies and contacts.
- **Multi-statement units re-assert their plan at commit** ([[CORE36]] D4). On Postgres the org writer lock
  makes the plan authoritative; on D1 nothing does, so:
  - `assertStep(qc, cond)` aborts the unit as drift when `cond` is false (D1: an insert into the always-empty
    `unit_assertion` table with the named CHECK `unit_assertion_holds`; Postgres: `select cond as holds`);
  - `exactly(qc, step, n)` requires the step to touch exactly `n` rows (D1 adds an assertion on
    `changes() = n`, which must immediately follow the step);
  - **a set write is three guards:** restrict it to the PLANNED ids (`memberOf(qc, table, 'id', ids)`), wrap it
    in `exactly(n)`, then `assertStep(not exists <live row still matching the predicate>)`. The count alone
    misses a swap (one planned row gone, one unplanned row added): the unplanned row changes with no event.
    The set guard alone misses an addition. See `cascades.ts` and `merge.ts` ([[CORE36]] review).
  - **A statement that inserts no row resets D1's `changes()` to 0**, and so does a holding assertion. Never put
    an `appliedPrev`-gated statement (such as `eventStatement`) directly after an assertion. Gate it on an
    `exists (event id)` instead, or rely on the `exactly` before it.
- **Sets cost a constant number of statements** ([[CORE36]] D5). Bind a set as ONE parameter with
  `jsonRows(qc, alias, columns, rows)` (D1 `json_each`, Postgres `jsonb_array_elements … with ordinality`), and
  emit its events with ONE `eventSetStatement` (ids and `before` in the parameter, `after` rendered from the
  stored rows). The statement-count test compares a set of 1 with a set of 10 on both engines. Current
  counts: company and contact delete 9, merge 12, resolve 7 on Postgres and 6 on D1.
- **Concrete programs are `Program<T>` plan/build pairs** (`src/identity/program.ts`) with namespaced read
  keys (`resolve:`, `own:`, `merge:`), so [[CORE25]] can compose them later. `resolveProgram`,
  `ensureOwnProgram` and `mergeOperation` are the worked examples.
- **Testing on both engines:** see `writing-tests` section 3.

## The service context and tenancy

Every operation runs inside the service context, which carries the transaction, the actor (user or agent
principal), the granted scopes and the tenant. Tenancy is the **organisation**. The scoping wrappers in
`packages/db/src/tenancy.ts` (exported from `@vault/db`) are the only code that sets role or session config:

| Wrapper | Use |
|---|---|
| `withOrganization(db, { principalId, organizationId }, fn)` | The default. Validates both ids (throws `TenancyContextError`, codes `missing_organization` / `missing_principal` / `invalid_id`) before opening a transaction, sets `app.organization_id` / `app.principal_id` with `set_config(…, true)`, then `SET LOCAL ROLE vault_authenticated`. |
| `withServiceRole(db, fn)` | `SET LOCAL ROLE vault_service` (BYPASSRLS), no tenant context. Auth lookups and cross-tenant maintenance only. |

The app connects as `vault_app` (`LOGIN NOINHERIT`, a member of both roles, no privileges of its own), so
a query outside a wrapper fails with `42501`. `vault_authenticated` has no `DELETE`/`TRUNCATE` anywhere,
only `SELECT, INSERT` on `events`, and nothing on `api_keys`. `vault_service` has `SELECT, INSERT, UPDATE`
(events `SELECT, INSERT`), no `DELETE`, and nothing on Kysely's tables.

Operations don't call the wrappers directly; they run in a service context (`src/context.ts`):

- `withContext(db, { actor, organizationId, scopes }, ctx => …)`: tenant operations. `ctx` has `trx`,
  `actor`, `organizationId`, `scopes` and `emit(event)`, and deliberately **no `db`**. Usable outside a
  request (a Workflow step) with an explicit principal.
- `withAccountContext(db, { actor }, ctx => …)`: account operations with no organisation ([[CORE3]]):
  service role, `ctx.emitFor(organizationId, event)`.
- Both map a `23503` to `400 invalid_reference` **after** the transaction rolled back (in `.catch` on the
  wrapper), never inside it; everything else, including `TenancyContextError`, passes through unchanged.

- **Handlers never import `db` directly.** They use the transaction from the context. Plain `db` is for
  auth lookups and test fixtures.
- **Do not use a plain `db.transaction()` because "RLS isn't wired yet".** The role and gate exist; bypasses
  that rely on future-you remembering to switch back are dead on arrival.
- **Org-required operations guard first, then wrap.** Return one consistent error shape and status for "no
  active organisation" across the whole API (decide it once in the first API cycle; the predecessor ended up with two
  shapes by route family and regretted it).
- **Keep tenancy transactions short** and never hold one across a storage call (see `hyperdrive-pg-rls`).
- **TS gotcha:** if you re-run a helper through a second wrapper call, don't type the callback's `trx` as
  `any`. That erases the wrapper's `Transaction<Database>` generic and its return type collapses to `{}`.
  Cast the callback's *return value* instead.

### Tenancy per engine ([[CORE35]] D6, D18)

| | Postgres (multi-tenant, cloud and enterprise) | D1 (single organisation, self-hosted MVP) |
|---|---|---|
| Boundary | `organization_id` is the RLS gate | the database itself |
| Enforcement | RLS in the same migration that creates the table; only the scoping wrappers set role or session config | `organizations.id` references the singleton deployment marker; every tenant table has a foreign key onto `organizations`; D1 always enforces foreign keys, so a second organisation cannot be stored |
| Shared programs | write `organization_id` | write `organization_id` too, but no D1 guarantee depends on it; RLS is not emulated |
| Foreign identity | refused by RLS (`42501`) | refused before any SQL by the storage layer |

Every tenant table on either engine also carries `user_id`/actor attribution.

## Principals and scopes

Agents are first-class principals with their own identity, credentials and **scopes** (which channels,
which contacts or companies, read vs. suggest). Every registry entry declares the scope it needs and the
service context enforces it, so scope checks are written once.

- **One Bearer credential per request, dispatched by shape** ([[CORE3]] D6, `src/auth/middleware.ts`).
  Routes are shared by users and agents, so there is no "one auth kind per route". The scheme is matched
  case-insensitively (`bearer` works). No cookies are read.
  - A JWT-shaped token (three base64url segments) goes to the `UserAuthenticator` seam. With no
    authenticator configured, it is `401`. The real authenticator verifies the token with no network call
    (`AuthAdapter.verify` returns a failure reason, which the single 401 log line carries; the response is
    always `401 invalid or expired credentials`). It then looks up the user (SELECT only), provisions it
    on first sight, resolves the organisation and derives scopes from the role.
  - **The authenticator never throws for organisation problems**: it cannot know the operation kind. It
    returns `organizationId: null`, and sets `organizationForbidden` when the token's organisation claim is
    unusable (unmapped role, a newer soft-deletion in the copy) or the header contradicts it. `run` turns that
    into the 403 (see the order above).
  - A user's active organisation is the token's `o` claim; `X-Organization-Id` is only a cross-check, compared
    case-insensitively for users and agents (the [[CORE2]] upper-case-UUID lesson).
  - Anything else is an API key: `vk_` plus 32 random bytes in base64url, stored as SHA-256 hex, looked up
    under `withServiceRole` together with its agent. Revoked keys, expired keys and disabled agents all
    return the same `401 invalid or expired credentials`.
  - An agent that sends an `X-Organization-Id` other than its own gets `403 organization_forbidden`.
  - A 401 logs at most an 8-character token prefix, once (the middleware logs an authenticator's 401;
    authenticators don't log their own).
- **A user's scopes come from their role on every request; they are never stored** ([[CORE3]] D8).
  - **Every declared scope needs a row in `SCOPE_POLICY`** (`src/auth/roles.ts`: `{ member, agentGrantable }`).
    A catalog test requires the policy's keys to equal `registry.declaredScopes()` exactly, so a cycle that
    declares a scope fails CI until it decides both flags in the same change. Owners hold every declared
    scope. A scope without a row is held by no member and granted to no agent (fail closed).
  - Human-only scopes (`agentGrantable: false`) are never granted to an agent; bootstrap refuses them.
- **Agents never get send rights.** An agent's write surface is "submit a suggestion"; sending is performed
  by the vault's execution rail with credentials it holds.
- A provisioner that creates the user or organisation row on first sight must SELECT first and INSERT only
  on a miss. In order (`src/auth/first-sight.ts`): any network call (the profile fetch) **before** the
  transaction opens. Then lock every unique key the insert can collide on (subject and email), re-select,
  insert with `ON CONFLICT DO NOTHING` as the backstop, and throw on an empty `RETURNING` so the parent
  `principals` row rolls back.
- **Error classes live in a leaf module** (`errors.ts`, or the seam's own module such as `auth/adapter.ts`),
  never next to their main thrower. `AuthFailure` once sat in `user-authenticator.ts`, and `first-sight.ts`
  imported it back, an import cycle; it now lives in `auth/adapter.ts` beside `VerifyFailure` ([[CORE27]] P12).

## Every write emits an event

A write appends an event row (`task.created`, `contact.updated`, with `before` and `after`) to the `events`
table **in the same transaction**. Hooks, webhooks, the agent cursor and the audit trail all read that one
table. Because the event commits with the write, a crash between commit and delivery cannot lose it (the predecessor's in-memory after-commit kick could, and needed recovery crons). Commands emit through the same outbox.
`before`/`after` scalars into a jsonb column need `JSON.stringify` (see `db-schema-and-migrations`).
Writes that are not resources (identity bookkeeping, channel machinery, `bootstrap`) are the named
exceptions in AGENTS.md invariant 5. A new exception needs a spec decision.

## Response shape and errors

- Success returns the resource or result per the operation's output schema; creates return `201`;
  accepted-for-later work returns `202`.
- Errors: a stable machine code plus a short message (`{ error: { code, message } }`), mapped to `400`
  validation, `401` unauthenticated, `403` missing scope or organisation, `404` not found (also for
  cross-tenant ids; RLS makes them indistinguishable by design), `409` conflict, `413` too large.
- Idempotent replay of a confirm- or ack-style call returns success with a status marker rather than a 4xx.
- Validate with the operation's zod schema; never `c.req.json<T>()` and trust the shape, because agents are
  third-party callers.
- Let unexpected errors propagate to the error middleware; don't wrap handlers in `try/catch → 500
  internal`.

## Logging

`console.log` / `console.warn` with `[tag]` prefixes. Log sizes and counts, not per-request success lines
(Hono's `logger()` already emits one per request, skipped under `VITEST`). Auth failures log method, path,
whether credentials were present and a truncated token prefix. **Never log full tokens**, and never log
message bodies or addresses at info level (customer communications are personal data).

## Large bytes and object storage

- `ObjectStore` (`src/storage/types.ts`, R2 and local-disk implementations) holds raw email bodies and
  attachments the Worker writes. Postgres holds a pointer and metadata only.
- A Worker request body caps at 100 MB; anything a browser uploads goes browser ↔ R2 over presigned URLs,
  and validation moves to a separate "complete" call that `head`s and sniffs what actually landed.
- **Never hold a DB transaction across a storage call.** Do the DB work, close the transaction, then call
  R2. On delete, remove the row first and the object after commit, best-effort: an orphaned object is
  harmless, a row pointing at missing bytes is not.
- A dependency that throws without its env goes on the context as a **lazy getter**, so sibling routes keep
  working on a box without that env.

## Testing

Test-writing rules live in the `writing-tests` skill: red first, the contract suite and fixtures, golden
fixtures and both-engine suites, absence mutations, event-order assertions, no leaked state, flakes. Tenancy
in tests is in `writing-tests` section 6.

## Verifying against a local dev server

A foreign process on the dev port, or a watcher that outlived its child, can keep serving old code while
your edits never run. That reads as a logic bug and costs real debugging time. Before re-reading your diff,
compare the port holder's start time with the file's mtime:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN -t | xargs ps -o pid=,lstart=,command=
```

If the process predates the edit, restart it. If the holder started recently and you didn't start it,
another session may be using this checkout: run an isolated second instance on another `PORT` against the
same dev database, scope every fixture row to explicit ids you generate (not rows you found by browsing),
and delete them when done. Before any smoke that reads through a running server, confirm which database it
is actually on: an already-exported `DATABASE_URL` overrides `--env-file`.

## Concurrency patterns

- Upsert with `ON CONFLICT` (`onConflict((oc) => oc.columns([...]).doUpdateSet({...}))` or `.doNothing()`)
  instead of SELECT-then-INSERT. Use `excluded.<col>` via `sql\`excluded.col\`` when the new value depends on
  the incoming row. A partial unique index needs its predicate repeated in the conflict clause.
- Hot counters and "greatest of" columns: a raw-SQL update, not read-modify-write.
- **No fire-and-forget queries in a request.** A query that outlives the response needs `waitUntil` in a
  Worker, races the per-request pool teardown, and interleaves with the next test's truncate.
  - Throttle an observability write and await it instead. For example, `last_used_at` is updated at most
    once a minute, in the lookup transaction ([[CORE15]]).
- `sql.ref(alias)` emits a quoted identifier; if the surrounding raw SQL declares an unquoted alias, pass its
  folded lowercase spelling or Postgres says `42P01`.
- **Kysely 0.27's `JoinBuilder` has no `orOn`.** An OR inside a join needs `.on((eb) => eb.or([...]))`.
  (The vault has no canonical-contact alias to join across: contacts are people and identities are
  addresses, [[CORE2]] D1.)
- **On the prepared path, find-or-create needs no key lock** ([[CORE36]] D3). On Postgres the org writer lock
  serialises all writers; on D1 the atomic batch plus the partial unique index makes a racing loser abort
  whole (`409 conflict`, no orphan parent). The paragraph below applies only to the legacy writers left
  until [[CORE41]] (first sight and the directory).
- **Legacy path: find-or-create of a parent plus child needs a lock before the select, not just `ON CONFLICT`.** An
  `ON CONFLICT DO NOTHING` on the child alone leaves the losing transaction's parent row (and its
  `*.created` event) orphaned. Take `lockKeys(ctx.trx, keys)` (`src/identity/locks.ts`: one statement,
  `pg_advisory_xact_lock` over distinct `hashtextextended` keys in ascending hash order, so overlapping
  batches cannot deadlock), then select, then insert with `ON CONFLICT DO NOTHING` as the backstop. Every
  insert path for that key must take the same lock ([[CORE2]] D16; `first-sight.ts`). `lockKeys(trx, keys)`
  takes a `Transaction<Database>`, so service-role code (`first-sight.ts`) and tenant code (`ctx.trx`) share
  it; type every shared transaction helper that way ([[CORE27]] P12). Key builders live beside it
  (`directoryOrgKey(provider, externalId)`).
- **Canonicalise ids before comparing or sorting them in JS.** `z.uuid()` accepts upper case, Postgres
  treats both cases as one uuid, JS string comparison does not. An upper-cased self-merge got past an
  `===` guard into a CHECK violation (an unmapped 500), and a case-sensitive sort can invert a lock order
  ([[CORE2]] review). Lower-case at the top of the command.

## Things to avoid

- Importing `db` in a handler instead of using the service context.
- Inserting into a resource's table from anywhere but its service layer.
- A route or MCP tool that bypasses the registry.
- Re-declaring middleware-set context variables on a route's `Hono<{ Variables }>`.
- Unit tests that mock the Hono context; use an integration test against the real DB.
- Normalizing a stored string value (an error code, a status) without first grepping the OLD spelling across
  **every** package, not just the one being touched.
