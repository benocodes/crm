---
name: api-routes
description: Patterns for the vault's backend in packages/api — the operation registry (zod in/out, scope, prepare), prepared resource definitions with generic CRUD, commands, storage identities and bindings (Postgres or D1), the events outbox, Hono + Kysely routes, and integration tests on a production-like tenancy pool. Use when adding or changing an operation, a resource, a command, a route, middleware, or writing tests against the backend.
---

# API: operations, resources, routes

Reference for backend work in `packages/api`. The design is in `knowledge/architecture.md` (§3–§9, §11); this
skill is how to write it. It is a rewrite around the vault's model of the predecessor's `api-routes`: the Hono and
Kysely mechanics carry over, the per-route bespoke style does not.

The shape, top down:

```
REST (@hono/zod-openapi)   MCP tools (Workers)   CLI (later)
          \                    |                   /
           +--- operation registry (zod in/out, scope, prepare) ---+
                          |
     resources (generic CRUD from a definition) + commands (merge, send, accept…)
                          |
   prepared unit: plan reads → typed statements, run by the storage binding as one identity
                          |
     Postgres (Hyperdrive, @vault/storage-postgres) or D1 (@vault/storage-d1) ── outbox: events (same unit)
```

**What exists:**
- **Service layer** ([[CORE12]]; prepared-only since [[CORE44]], the interactive `withContext` path is deleted):
  - `src/errors.ts` (`ApiError`, `mapStorageError`);
  - `src/scopes.ts` (`ScopeSet`);
  - `src/outbox.ts` (`eventStatement`, `eventSetStatement`: the only code that inserts into `events`);
  - `src/storage/internal.ts` (`InternalEnv { now, newId }`, `internalEnv(opts)`: built per request from
    `AppOptions.clock`/`newId`, handed to auth, first sight, the directory and the webhook, [[CORE41]] P5);
  - `src/resources/define.ts` (shared helpers only: `crudActions`, `scopeResourceOf`, `resourcePath`, `parseInput`,
    `parseListQuery`); `src/storage/{definition,prepare,crud}.ts` (the prepared core); `src/resources/*.ts` (definitions).
- **Registry and HTTP** ([[CORE15]]):
  - `src/registry.ts` (`Registry`, `resourceOperations`, `toolName`);
  - `src/operations.ts` (`createVaultRegistry`, where new resources and operations are added);
  - `src/rest/{app,errors,openapi}.ts` (`createApp`, `renderError`);
  - `src/auth/{types,api-keys,middleware}.ts`;
  - `src/bootstrap.ts` (`bootstrapOperation`, `bootstrap(storage, opts, env?)`: one internal unit, no events).
- **Postgres composition** (`@vault/server-postgres`, enterprise, [[CORE36]] D22, since [[CORE44]]): every entry point
  that picks the Postgres runtime lives here, importing the app from the `@vault/api` barrel.
  `packages/api` production code imports none of `pg`, `@vault/db`, `@vault/storage-postgres` or
  `@vault/server-postgres` (AGENTS.md invariant 10):
  - `src/dev-server.ts` (`pnpm -C packages/server-postgres dev`; `AUTH_PROVIDER` empty runs agent-only);
  - `scripts/bootstrap.ts` (`pnpm -C packages/server-postgres bootstrap -- --org … --email … --agent …`);
  - `scripts/smoke-auth.ts`, `scripts/smoke-admin.ts` (below).
  The golden generator is not here: it is open code, `packages/api/scripts/golden.ts` (`pnpm -C packages/api
  golden:generate|check`, on D1, [[CORE72]]).
- **D1 composition** (`@vault/server-d1`, open, [[CORE38]]): the self-hosted module Worker on one D1 binding `DB`.
  Its boundary rules (`server-d1/src`, `server-d1/scripts`) forbid every enterprise import with no allow-list.
  - `src/compose.ts` (`composeD1Worker(env, deps?)`, Node-testable): the organisation comes from the **deployment
    marker** (`readDeployment`), never from Worker vars. Only success is cached per isolate: an absent marker answers
    `503 not_initialised` and is re-read on the next request, so a bootstrap takes effect without a restart. A bad auth
    or CORS configuration fails closed (`500 internal` on every non-health route) and logs one line naming the variable,
    never its value. `GET /health` is outside the registry and reads the marker live. A missing `deployment`
    table counts as an absent marker.
  - **Migration gate** ([[CORE61]]): `fetch` runs in this order: `/health` → the two discovery documents ([[CORE84]]: `discoveryResponse`, answered unless `configError`, which is `500` there too) → the `behind` gate
    (`503 migrations_pending`; the two OpenAPI documents, `GET /api/v1/openapi.json` and `GET /meta/v1/openapi.json`, are exempt; the root `/openapi.json` no longer exists and answers like any unknown path: `503` while uninitialised or behind, `404` otherwise, [[API32]] D5) → the auth-config `500` → the marker. The state comes from
    `readMigrationState` (`@vault/storage-d1`) against `MIGRATIONS`. It is cached per isolate once
    `current`/`ahead`, re-read at most every 5 s (`deps.nowMs`, not `deps.clock`) while `behind`/`unknown`, and
    never cached after a thrown read. `/health.migrations` reports it. The tracker read is one more query on a
    cold isolate.
  - `src/init-deployment.ts` (`initDeploymentOperation`: marker insert `ON CONFLICT DO NOTHING` plus `assertStep`, no
    events) and `src/bootstrap-d1.ts` (`bootstrapD1`: marker unit, then [[CORE41]]'s `bootstrap`; resumable).
  - `scripts/bootstrap.ts` (`pnpm -C packages/server-d1 bootstrap -- …`): local only. `getPlatformProxy` defaults
    `remoteBindings` to **`true`**, so the CLI always passes `false`; `scripts/bootstrap.test.ts` pins it.
  - `scripts/smoke-worker.ts` (`pnpm -C packages/server-d1 smoke:worker`): esbuild bundle run in workerd through
    Miniflare. `outboundService` is the fake Clerk and fails on any other host, which proves no real network call.
  - The bundle needs **no `nodejs_compat`** (Web Crypto only). Keep Node built-ins out of `@vault/api` production
    code; the smoke is the check. A package whose entry imports Node built-ins at top level (`chat@4.43.0`) is
    a devDependency imported type-only; `production-boundary.test.ts` enforces that for `chat` ([[CORE69]] D25).
  - **workerd streams** ([[CORE69]]): R2's `put` refuses a `ReadableStream` of unknown length (`TypeError`), so pipe a
    known-size stream through `FixedLengthStream(size)` and send an unknown-size one through `ObjectStore.putStream`
    (buffer to 5 MiB, else multipart). `crypto.DigestStream` and `FixedLengthStream` reach `@vault/api` only as
    injected `StreamPrimitives` (`workerdStreams()`; Node versions in `@vault/api/test`). Node fakes accept any
    stream, so only the smoke proves this path. A smoke-only entry (`scripts/smoke-pipeline-entry.ts`) may export
    only its handler; constants it shares with the smoke go in a sibling module.
  - Test D1s come from `src/test/kit.ts` (a fresh in-memory D1 per test), so no clearing helper is needed.
  - **Per-request D1 budget** ([[CORE47]]). Workers Free allows 50 D1 queries per invocation (a `batch()` is one)
    and 50 subrequests, D1 queries and outbound fetches together. A prepared unit costs one read batch plus one
    write batch, so most requests send 2–4 queries. `src/measured-limits.test.ts` meters each scenario through
    `meterD1` (kit) and pins its exact query count in `EXPECTED_QUERIES`: a new round trip turns it red, and you
    re-pin it in the same change. A loop of units grows with its input. The directory snapshot runs one unit per
    first-seen member, 2k+3 queries and 3k+5 subrequests, so more than about 15 new members exceeds Free
    (follow-up #51). Prefer one set unit over a unit per row, and add a scenario when an operation's
    cost grows with its input.
  - `pnpm -C packages/server-d1 open:check` copies the open packages into a temp workspace and installs,
    typechecks production code, tests and smoke-runs them there. A new directory under `packages/` must be
    classified in `scripts/open-check.ts` (`OPEN_PACKAGES`/`ENTERPRISE_PACKAGES`), or the check fails.
  - `README.md` is the self-hoster's document (quickstart, profile, measured limits, golden rule). Update it
    when a refusal, the cap or a measured number changes.
- **Human auth** ([[CORE3]] cycle 1):
  - `src/auth/adapter.ts` (`AuthAdapter`, `createAuthAdapter(env)`, `parseOriginList`), `src/auth/clerk.ts`;
  - `src/auth/first-sight.ts` (`lookupUserOperation`, `firstSightOperation`, `firstSightRecheckOperation`, and the
    wrappers `lookupUser(storage, …)`, `provisionUser(storage, adapter, subject, env)`), `src/auth/organization.ts`
    (`resolveActiveOrganization`), `src/auth/roles.ts` (`SCOPE_POLICY`, `scopesForRole`, `grantableScopes`),
    `src/auth/user-authenticator.ts` (`createUserAuthenticator`); `AuthFailure` lives in `src/auth/adapter.ts`;
  - `src/account/` (`me.get` only, a prepared account operation `meOperation(env)`; organisations and memberships
    come from Clerk, [[CORE29]]);
  - **D1 workspace sign-in** ([[CORE64]] cycle 1). `createApp({ workspace: { adapter? } })` is exclusive with
    `authAdapter`/`userAuthenticator`. `@vault/server-d1` sets it for every composition, `AUTH_PROVIDER` unset
    included. It uses `createWorkspaceAuthAdapter` (never reads `CLERK_WEBHOOK_SECRET`) and
    `src/auth/workspace-authenticator.ts`. The role is read on every request from the claim `AUTH_ROLE_CLAIM`
    (default `vibase_role`) and mapped through `SCOPE_POLICY`. The vault never reads or writes `memberships`
    for it. A missing, unknown or non-string role throws `403 organization_forbidden` before first
    sight, so a refused token writes nothing. `/webhooks/clerk` is not mounted. `me.get` answers agents (the
    op flag `agents: true`), and memberships are synthesised from the role. `CLERK_AUTHORIZED_PARTIES` is
    optional on D1, because session tokens minted through Clerk's Backend API carry no `azp`. An `azp` that is
    present must still be listed. Bootstrap uses `src/bootstrap-workspace.ts` (no human, attributed to `system`).
  - **D1 agent principals** ([[CORE77]], migration `0007`). The workspace adapter returns `kind: 'session' | 'oauth'`;
    an OAuth token is marked by RFC 9068's `typ: at+jwt` header **or** a `client_id` claim (required), verified with
    the session key, no `aud`/`azp` check. Clerk's own scopes are dropped, the rest go through
    `fromProviderScope` (identity). Resolution lives in `src/auth/workspace-authenticator.ts` +
    `src/auth/agent-principals.ts`: one read-only lookup unit (user row, account agent by `auth_subject`, delegated
    agent by (client, human)); `AUTH_CLI_CLIENT_ID` acts as the human (role ∩ token); any other client is a
    delegated agent (token ∩ stored cap ∩ role ∩ grantable); role `agent` is an agent account (grants ∩ token for
    OAuth, grants for a session token). Kinds never convert (`403 organization_forbidden`); a disabled agent is
    `401`. First sight inserts `ON CONFLICT DO NOTHING`, gates the event on the insert, then asserts the stored id
    (the race loser re-looks up once, else `409`). The profile (`fetchProfile`, with `role`) is cached per isolate
    for 60 s by `env.now`; a `404` is cached as a refusal, any other failure is `500` and uncached. The client
    name comes from `GET /v1/oauth_applications?name_query=<client_id>` (Clerk documents that `name_query` also
    matches an exact `client_id`), falling back to the id. A scope term that is vacuous under `SCOPE_POLICY`
    (the role term) is tested with an injected `policy` option.
  - **Clerk OAuth facts seen live** ([[CORE77]] E2E): Clerk grants custom scopes that are "Not advertised" and
    absent from `scopes_supported`, so the issuer metadata is not the list of grantable scopes (the vault
    publishes its own, [[CORE84]]). The DCR `registration_endpoint` is in `/.well-known/oauth-authorization-server`,
    not in `openid-configuration`.
  - **OAuth discovery** ([[CORE84]], `src/discovery.ts`): `GET`/`HEAD` of `/.well-known/vibase` (D21) and
    `/.well-known/oauth-protected-resource` (D22; `404` with no provider), exact paths, `Cache-Control: public,
    max-age=60`, `Access-Control-Allow-Origin: *`, URLs on the request's origin. A public document mounted before
    the gates must check `configError` itself: the config check sits after the migration gate, so moving a path
    earlier silently skips it. The `401` challenge (`WWW-Authenticate: Bearer resource_metadata="…"`, no `error=`)
    is one outer middleware in `createApp` that reads `c.res.status` after `next()` (so `onError`'s rendering is
    covered), active only with `workspace.adapter`; per-path setting missed paths in the absence mutation. Shared
    CORS exposes `WWW-Authenticate` (not safelisted). The goldens come from `d1GoldenBackend`'s `createApp`, which has
    no `workspace.adapter`, so workspace-adapter auth behaviour (the challenge, discovery) is pinned in `server-d1`
    tests, not goldens. A browser
    preflight (`OPTIONS`) on the documents falls through to the shared CORS policy (no `*`): the MCP adapter spec
    revisits it.
    The Organizations authenticator stays for `@vault/server-postgres` and the engine-harness suites;
  - `packages/server-postgres/scripts/smoke-auth.ts` (`SMOKE_EXPECT_DATABASE=<db> pnpm -C packages/server-postgres smoke:auth`: local key pair, fake
    Clerk API, real app; it also runs the identity-model flow). It refuses to run unless `current_database()`
    equals `SMOKE_EXPECT_DATABASE`, because an exported `DATABASE_URL` overrides `--env-file` ([[CORE36]]).
- **Administration** ([[CORE3]] cycle 2, [[CORE27]]):
  - prepared definitions `src/resources/{memberships,agents,api-keys}.ts` since [[CORE40]] (`memberships` is
    read-only, written only by the directory sync; `agents` normalises scopes with `normalizeAgentScopes` in
    `prepare`, and its create is the concrete `createAgentOperation`; `api_keys` is read-only, its writes are
    hand-written);
  - `src/admin/` (`users.list`, `users.get`, `api_keys.create`, `api_keys.revoke`: `adminOperations()`, all
    prepared since [[CORE40]]; `issueApiKeyOperation`, `revokeApiKeyOperation`, `listUsersOperation`, `getUserOperation`);
  - `src/directory/` ([[CORE29]], on storage since [[CORE41]]): `repairMembership` (the token claim repairs one
    user's membership; `repairOperation`), `reconcileOrganization` (fetch-and-reconcile one Clerk organisation;
    `reconcilePlanOperation` then `reconcileOperation`, one unit with a constant statement count), `refreshUser`
    (`refreshUserOperation`, outcomes `updated | unchanged | unknown | conflict | unsupported`),
    `system-principal.ts` (`systemPrincipalRead`, `systemPrincipalSteps`: created lazily inside a unit that writes an
    event) and `clerkWebhookHandler(adapter, { clock?, newId? })`, mounted as `POST /webhooks/clerk` by `createApp`
    only when an `authAdapter` is given. It is the first plain route: no auth middleware (the Svix signature is
    its credential), not in OpenAPI, `c.var.storage` only. Directory events are attributed to the system principal;
  - admin-kit (`src/test/admin-kit.ts`): `call(path, sub, { org })` mints the organisation claim from the copy
    (`claim` overrides, `header` sends `x-organization-id`), `webhook(payload)` posts a signed delivery,
    `seedOrg` links the organisation and mirrors it in the fake Clerk (`k.clerk.organizations`, `.members`);
  - `packages/server-postgres/scripts/smoke-admin.ts` (`SMOKE_EXPECT_DATABASE=<db> pnpm -C packages/server-postgres smoke:admin`, same scaffolding
    as `smoke-auth.ts`, with the same `SMOKE_EXPECT_DATABASE` guard since [[CORE40]]).
- **Test helpers** in `src/test/`:
  - `tenant.ts` (`seedTenant`: a Postgres organisation with an owner and an agent);
  - `storage.ts` (`pgStorage(db)`, `coldStorage()`: a binding whose `execute` throws, for apps that must run no
    unit; `probeUnit(value)`: a statement-free read unit for probe operations in routing and auth suites);
  - `keys.ts` (`seedApiKey`: a direct insert under `withServiceRole`, not the production path);
  - `auth-kit.ts` (`openAuthKit(engine)`, [[CORE41]]): the real authenticator and webhook over the fake Clerk on
    either engine's binding, a spy that records every unit (`ran`: name, identity, stats) and `armOn(name, hook)`
    for D1 drift in one named unit;
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
  - the Worker entry ([[OPS4]]).

## The registry and the REST adapter ([[CORE15]])

- **An operation** is `{ kind: 'tenant' | 'account', name, summary, method, path, request?, validation?,
  response, prepare }`. `scope` is required on tenant operations; account operations take none and are
  for users only (`403 user_required`). An account operation is `prepare(env: AccountEnv, input)` returning a
  **read-only** prepared operation, run with the `account` storage identity ([[CORE41]] P12). One that must write
  becomes an internal unit with an explicit organisation instead.
  - `name` is dotted and lowercase (`contacts.merge`). It is the OpenAPI `operationId`, and `toolName`
    derives the CLI/MCP name from it (`contacts_merge`, at most 64 characters).
  - `surface` is required, `'api'` (records) or `'meta'` (configuration: agents, API keys, members, users, `me`,
    later the schema), by architecture principle 14's test; no default, so a missing one is a type error ([[API32]] D1).
    Generated CRUD inherits the definition's `surface`.
  - `path` uses OpenAPI form and is **surface-relative** (`/contacts/{id}/merge`); the wire path is
    `fullPath(op)` = `/api/v1` or `/meta/v1` + `path` (`src/surfaces.ts`). The router, both documents, the
    contract suite and the goldens use the full path; the duplicate-route check runs on it, so the same relative
    path may exist on both surfaces.
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
     both organisation flags and see `env.organizationId: null` instead;
  3. `prepare(env, input)`, then `execute` with the operation's storage identity (`tenant` or `account`), errors
     through `mapStorageError`;
  4. respond with `c.json(result, status)`, or an empty 204.
  This order lives in `executeOperation` (`src/rest/app.ts`), which REST and MCP `tools/call` both call
  ([[API106]] D12). A new transport builds an `OperationInput` and calls it; it never re-implements the order.
- **`createApp({ storage: (c) => StorageBinding, registry?, authAdapter? | userAuthenticator? | workspace?, clock?, newId?, randomBytes?, corsOrigins?, version? })`** ([[CORE44]] C1: `storage` is required, there is no `db`).
  - `authAdapter` builds the real authenticator over the registry's declared scopes; `userAuthenticator`
    is for tests and custom setups; `workspace` is the D1 workspace authenticator ([[CORE64]]). Passing more than one throws, so a test can't silently run the fake.
  - `corsOrigins` empty or absent: no CORS middleware and no `Access-Control-*` header.
  - The storage resolver runs once per request, in `app.use('*')` before auth, and never at construction. Auth,
    the operation and the webhook reuse that binding (`c.var.storage`).
  - Auth is mounted on each registry route, never on `*`. A plain route the caller adds to the returned
    app (`/health`, a webhook receiver) gets `c.var.storage`, no auth, and no OpenAPI entry.
  - `GET /api/v1/openapi.json` (`Vault records API`) and `GET /meta/v1/openapi.json` (`Vault meta API`) are
    unauthenticated; each lists only its surface's operations at full paths. There is no root document and no
    root resource path ([[API32]] D4, D5, D8). Machinery (`/health`, `/webhooks/clerk`) stays at the root,
    unversioned, outside the registry (D7).
- **Errors.** `renderError` turns an `ApiError` into its own status and body. `run()` refuses a tenant operation
  with no organisation (`403 organization_required`) before any unit, so no tenancy error reaches it. Anything else is
  logged (`[api] unhandled`) and masked as `500 internal`. Unmatched routes and methods return
  `404 not_found`, `no such route`.
- **Resource definition knobs:**
  - `operations` (a CRUD subset; read-only definitions omit `create`/`update`);
  - `scopeResource` (share a scope, e.g. identities use `contacts:*`).
  - Routes are `resourcePath(def)`: `_` becomes `-`, so `api_keys` routes at `/api-keys`.

## Operations: define once, expose everywhere

Every operation is one registry entry: a name, input and output zod schemas, the **scope** it requires, and
a `prepare(env, input)` that builds a prepared unit from the trusted environment and the input. REST routes and MCP tools are generated from the registry by
thin adapters, so the surfaces cannot drift apart and OpenAPI comes from the same schemas. Do not hand-write
a route or an MCP tool that bypasses the registry.

- Reads and writes go through the same registry. There is no second read path (no GraphQL, no direct table
  access from a handler).
- Commands are ordinary registry entries exposed as POST routes (`POST /api/v1/contacts/{id}/merge`), so they get
  scopes, MCP tools and OpenAPI for free.
- **The CLI derives its commands from a cached copy of the documents** (`packages/cli/src/derive.ts`, cache up to an hour
  old). Any change to how commands are derived, and any new resource, must be tested against a cache written *before* the
  change, for every invocation form (`vibase <resource>`, `vibase <resource> <action>`, `--help`): a stale cache must
  refresh once and answer as a fresh one. [[CORE130]]'s kebab-cased action threw `TypeError` on `vibase deals` with a
  pre-deals cache (`cli.integration.test.ts`, "a cache that predates deals" edits the cache file to build that state).
  A new list flag on a stale cache is refused as unknown by `parseInvocation`, so `main` refreshes once and re-parses
  against the live document ([[CORE136]]); it never sends the list without the flag it was asked for.
- **A retry that re-runs a parser must not consume one-shot input twice.** stdin (`--data -`) can be read once per
  process: the stale-cache re-parse in `packages/cli/src/cli.ts` reads it through a memoised `io.readStdin`
  (`stdin ??= deps.readStdin()`), so a genuine usage error (bad JSON) answers the same on a cached run as on a fresh
  one. Any new retry around input parsing reuses that `io`, never `deps.readStdin` directly ([[CORE136]] review).
- There is no Hono RPC (`hc`) typing: a registry built in a loop gives no static route types. A TypeScript
  consumer that needs typed calls should generate a client from `/api/v1/openapi.json` and `/meta/v1/openapi.json` ([[CORE15]], [[API32]]).

## Resources: declarative definitions, generic CRUD

A resource (contact, company, task, deal, interaction) is a definition: table, zod schema, scopes,
validators, and which fields agents may write. Generic create, read, update, delete and list run from the
definition inside the service context. **Every write for a resource goes through that layer; nothing else
inserts into its table.** Keep definitions small and give each one an escape hatch (a validator or a custom
handler); a generic layer that tries to express every behavior turns into a framework to fight.

Adding a resource also means adding it to the **contract suite** (see Testing); don't hand-write those
tests.

The definition is `definePreparedResource` (next section). Rules that hold for every definition:

- **A response that carries a secret is a hand-written operation over a read-only definition.** The
  generic create renders its event `after` from the stored record, so a create that returned a plaintext key
  would leak it into the outbox if the key were a column. `api_keys` generates only `list`/`get`;
  `api_keys.create` is `issueApiKeyOperation`, which adds the plaintext only to the successful result's
  `decode` ([[CORE27]] P6, [[CORE40]]). The contract fixture names the route in `handwritten: ['create']`,
  so the suite's "not generated" case skips it.
- **Generic reads and writes name their columns** (the keys of `record`). A column left out of `record`
  (`api_keys.key_hash`, `content_key`) is never selected, never returned and never in an event, so
  column-level grants work ([[CORE15]]). Never select or return a whole row in `src/storage/crud.ts`.
- `definePreparedResource` throws at load on a bad `name`, a table with no physical schema, an unknown
  `agentWritable` field, and `delete` on a table without `deleted_at` (`src/storage/definition.test.ts`).
- **Embedded children** ([[CORE25]] D50): `embed: { <field>: { table, key, columns, orderBy } }` renders a child set
  into the record as a JSON array (`messages.attachments`, `interactions.participants`). The record schema names the
  field as an array; `columnsOf(def)` returns the physical columns only (record keys minus embed keys), `embedsOf(def)`
  the specs, and `afterOf(def)` is the `after` of an event (`{ table, columns, embeds }`), so the record and the event
  carry the same rendering from ONE helper (`embedJson` in `@vault/storage`: Postgres `coalesce(jsonb_agg(... order by ...), '[]')`,
  D1 `json_group_array(json_object(...) ORDER BY ...)`, wrapped in `json(...)` inside `recordJson`). An empty set is `[]`,
  never null. Table, key, columns and order are checked against `COLUMN_KINDS` at the call site (types) and at load.
- **Join filters** ([[CORE25]] D51): `joinFilters: { <key>: { schema, normalize?, where(qc, value) } }` are list filters
  that are not columns (`interactions.contact_id`, `identity_id`, an `EXISTS` over a child table). A key may never be a
  column of the table nor also in `filters` (load-time throw); `where` is a synchronous Kysely/`sql` fragment ANDed into
  the list. `contact_id` joins through `identities` with `deleted_at IS NULL`, so it follows a merge and a deleted identity.
  A join filter that reveals another resource or an edge declares the scopes it needs, `requires?: readonly Scope[]`
  (`tag_id` on companies, contacts and tasks requires `tags:read` then `associations:read`, `src/resources/tag-filter.ts`).
  The generic `listOperation` checks them in declaration order, before it builds the query, and answers `403
  insufficient_scope` naming the first missing scope. Never check them ad hoc in an override ([[CORE129]] D12a). An `EXISTS`
  over `associations` must match **both canonical sides** (the tag is `b` for companies, contacts and notes, `a` for tasks)
  and only live edges. Prove each with its own absence mutation.
- **A repeated query parameter is refused on REST** (`readInput` in `src/rest/app.ts`, [[CORE129]] D10a): Hono's
  `c.req.query()` keeps the first value, so `?x=a&x=b` is `400 validation_error` naming `x`. MCP refuses an array argument
  through the schema. The first operation that declares an array query parameter must exempt that parameter there and read
  it with `c.req.queries()`.
- **Derived fields** ([[CORE131]], `derived: { name: { kind, expression(qc, parent), requires?, filters? } }` on a
  definition; contacts' `last_contacted_at` / `last_interacted_at` in `src/resources/contact-activity.ts`): a read-only
  value computed by a correlated subquery, rendered by the crud core's `projection` only when the caller holds every
  `requires` scope (absent, not null, without it). **Never in events** (D2): `afterOf`/`columnsOf` exclude them, and
  `beforeRead` defaults to `{ derived: false }`, but **`selectRecord` defaults to derived on** (it serves get and list).
  So any read whose rows become an event's `before`/`after` must pass `{ derived: false }` explicitly: the cascade
  children in `src/identity/cascades.ts` missed it, and `companies.delete` leaked an `interactions:read` value into each
  unlinked contact's `contact.updated` ([[CORE131]] review F1). A new program that reads a resource with derived fields
  and emits its events (a cascade, a merge, a bulk op) needs a test that runs it as an actor holding the `requires`
  scope and asserts the keys absent from both sides of the event. Pin the D1 join order of a correlated derivation with
  `cross join` and assert the exact index lines of `EXPLAIN QUERY PLAN`, not just "SEARCH" (plain joins let SQLite start
  from the wide table, still a SEARCH, [[CORE131]] Decision 7). A derived field may share its name with a join filter
  only when it lists that filter in its own `filters` (`deals.status`, [[CORE130]]); any other clash is a load-time throw.
- **A read-only resource written by a program** (`threads`, `messages`, `interactions`, `files`): `operations: ['list',
  'get']`, no `create`/`update`, no `deleted_at` on the table. Until the capture program exists (CORE25 cycle 2) the
  fixtures seed rows by direct insert: `seedConversation(insert, opts)` (`@vault/api/test/messaging`, `src/test/messaging-kit.ts`)
  through `Engine.insert` or the contract kit's `insert`. Production code has no other writer.
- A `ReferenceTarget` may name `files` (no `deleted_at`, so never `live`). A link resource (`contact_files`) is create +
  soft delete only, with a `conflicts` read for the live pair (`409 link_exists`) and the partial unique index as backstop.
  The backstop answers the generic mapper's `409 conflict` (retryable), not the named code: the named code (`link_exists`,
  `domain_exists`, `tag_exists`) comes only from the `conflicts` pre-check. Removing the pre-check is the absence mutation that
  shows both layers (named code becomes `conflict`, never a `500`) ([[CORE129]] D4a).
- **Merge and delete know the links.** `CONTACT_REFERENCES` entries may carry `uniqueWith` (the re-point first soft-deletes
  the source rows that would duplicate a live survivor row, `<event>.deleted`, then moves the rest: both set statements are
  always emitted); `IDENTITY_REFERENCES` lists every FK onto `identities` with no re-point (`identity-catalog.integration.suite.ts`
  compares it to both engines). `cascadeDelete` takes several children in order (contact: identities then `contact_files`;
  company: contacts then `company_files`), each with the three set guards and its own set event.
- **Definition mechanisms added for deals and pipelines** ([[CORE130]], `src/resources/deals.ts`, `pipelines.ts`,
  `pipeline-stages.ts`). Reuse them; do not hand-roll a fourth shape:
  - **`createOnly: { field: hint }`** (`src/storage/prepare.ts`): `prepareUpdate` refuses a listed key *before* the strict
    update schema, `400 validation_error`, `<field> cannot be changed after creation; <hint>`. Without it the strict schema
    still refuses, but with `Unrecognized key`, so a test that only checks the status passes with the mechanism removed
    ([[CORE130]] M12b): assert the message, on every resource that uses it.
  - **`createComputed`**: columns of an `INSERT ... SELECT` taken from other rows in the same statement (a deal's
    `pipeline_id` and `closed_at` from its stage), beside the reference guards. Use it instead of a plan read whenever a
    stored value is derived from a referenced row: a plan read goes stale, the `SELECT` cannot. A command's `UPDATE ... SET`
    can do the same (`deals.move_stage`): the right-hand side sees the old row, and the target is re-checked in the `WHERE`.
  - **`hold` on `cascadeDelete`** (`src/identity/cascades.ts`): a delete refused while live rows point at the parent
    (`409 stage_in_use` / `pipeline_in_use`). The plan read counts and lists the first five ids for the message; the commit
    guard is `assertStep(not exists ...)` with the **same predicate** (`holdRows`), placed right after the parent's tombstone,
    so a row created between plan and commit aborts the unit. Each hold needs a race test and its own absence mutation.
  - **`childrenFirst`**: allocates the children's event ids before the parent's, so the feed (ordered by event id) shows
    children deleted, then the parent, while the physical insert order stays parent-first (children's statements are gated
    on the parent's event). Other cascades keep the old order, which their goldens pin.
  - Normalise input (upper-casing `currency`) in `prepare`, never with a zod `transform`: a transform cannot be rendered
    into the OpenAPI or MCP schema.
  - A command with `validation: 'adapter'` (`deals.move_stage`, `contacts.merge`) skips the body schema when the test kit
    calls `prepare` directly; test its bad-body cases over REST.
- **Associations** ([[CORE62]], `src/associations/`): a polymorphic edge `(a_type, a_id) ↔ (b_type, b_id)` stored once in
  canonical order. A table joins the graph with `associable: true` on its definition (load-time checks: an `id` column, a
  lowercase-identifier table name); the associable set and each type's read scope (`scopeResource`) come from the registry, and
  **a table name reaches SQL only from a definition, never from input**. `cascadeDelete` soft-deletes an associable parent's live
  edges on either side automatically (`touches(table, id)` in `src/identity/cascades.ts`), so a new associable resource with a
  delete needs no extra code there, only a cascade test; `contacts.merge` re-points edges and lists `associations` in
  `CONTACT_NON_FK_REFERENCES`. Associations are custom operations over a prepared definition, not generic CRUD.
  **Per-type neighbour rules** ([[CORE129]] D8a): a definition may list `neighbours` (the associable types it may link to;
  `tags` lists companies, contacts, tasks, notes). The list is carried onto `EndpointType`, and `mayLink` checks it symmetrically, so
  both argument orders behave the same, before the scope checks: a refused pair is `400 validation_error` naming the allowed types,
  whatever the caller holds. `createVaultRegistry` validates that every listed neighbour is associable (`assertNeighbours`). This
  is not done in `endpointTypesOf`, so partial test registries still build. `tags` ([[CORE129]], `src/resources/tags.ts`) is the
  second plain associable resource after notes; its members are association edges, not a join table.
  `notes` ([[CORE74]], `src/resources/notes.ts`) is a plain associable resource on generic CRUD whose `override.delete` is
  `cascadeDelete` with no children: the flag alone brings the edge cascade. **`include=associations`** on an associable
  `get` (D6) needs `associations:read` (else `403`), parses `include` inside `prepare` (unknown value `400 validation_error`),
  and reuses `orientedEdges` descending with limit 51 → 50 plus `associations_truncated`, filtering unreadable neighbour types
  in SQL so the cap counts only visible edges. Without the parameter the response is unchanged.
- **A D1-only table read by a shared write path breaks the dormant Postgres suites.** Postgres has no `associations` table, so
  every Postgres-path delete of a contact, company or task, and every contact merge, fails with `relation "associations" does not
  exist` ([[CORE62]]: 62 of 63 api failures); [[CORE74]] added `notes` (79 api failures, plus 4 storage-postgres schema
  parity and audit failures). That is accepted drift under AGENTS.md *Engines*: list the failing groups in the
  cycle's RESULT, keep Postgres compiling, never bend D1. The future Postgres adapter needs each such table with RLS.
- **Content operations** ([[CORE58]]): `src/messaging/content-operations.ts` holds `messages.content` (JSON, `messages:read`) and
  `files.content` (binary, `files:read`), registered in `createVaultRegistry`. `SecretColumns` (`@vault/storage`) now holds
  `messages.content_key` and `files.storage_key`: a record naming either is a compile error, and the operations read them with
  `selectColumns`, never `publicSelect`.

## Prepared resources: the storage seam ([[CORE35]])

Every operation is a **prepared operation**: a bounded program of typed Kysely statements that runs as one
atomic unit on Postgres (`@vault/storage-postgres`, enterprise) or D1 (`@vault/storage-d1`, open). The worked
example is `src/resources/tasks.ts`; the identity model, administration, auth, the directory and bootstrap
followed in [[CORE36]], [[CORE40]] and [[CORE41]]. Since [[CORE44]] it is the only path: there is no
interactive transaction, no `withContext` and no `executor` marker.

- **`definePreparedResource({ table, record, ... })`** (`src/storage/definition.ts`) infers the table from
  `table`. `RecordShape` makes every `record` key a public column of that table with a compatible type,
  so an unknown, secret or mistyped column is a compile error at the call. `computed` (a SQL expression
  over the stored row, e.g. the completion CASE) and `prepare` return values keyed and typed by column.
  Every hook is synchronous and DB-free. Prove each new call-site rule in
  `src/storage/definition.typecheck.ts`: an `@ts-expect-error` with a positive sibling, seen red.
  - **A table without `deleted_at` is hard-lived** ([[CORE40]] P4: `agents`, `api_keys`): the core adds no
    `deleted_at IS NULL`, the default operations are `list, get, create, update`, and listing `delete` throws.
    There is no `softDelete` flag on this path; the schema decides.
  - **A write field that is not a column is a hook input only** (P5): the core writes only `COLUMN_KINDS`
    keys, so `agents`' `disabled` drives `disabled_at` in `computed` and is never stored.
  - **`string_array` is a full column kind** (P6): Postgres binds `cast($n as text[])`; D1 stores JSON text
    (the runtime encodes a JS array) and `recordJson` renders it as `json(col)`, so an event's `after` holds a
    JSON array on both engines. Its column type is the decoded `string[]`, so a record typing it `z.string()`
    does not compile.
- **`TenantOperation.prepare` may be async** ([[CORE40]] P8): `run()` awaits it inside the try that
  maps errors. Use it only for work that cannot be a hook, such as hashing a minted secret.
  `PreparedEnv.randomBytes(n)` is the injected random source beside `now` and `newId()`
  (`AppOptions.randomBytes`, default `crypto.getRandomValues`), so a unit that mints a secret is
  deterministic in golden runs. The plaintext rides only in the result's `decode`, never in a statement, an
  event or a log.
- **There is one tenant operation shape** ([[CORE44]] P4). `run()` in `src/rest/app.ts` executes it through the
  binding from `createApp({ storage })`, which every composition must pass (the type requires it). Storage errors
  go through `mapStorageError`; anything it does not recognise passes through and is masked as `500`:
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
  (`src/identity/cascades.ts`) are the `override.delete` of companies, contacts, tasks and notes. `get` with
  `include=associations` goes to `getWithAssociations` (`src/associations/embed.ts`), **not** to `override.get`
  (`src/registry.ts`); no associable resource has an `override.get` today, and one that adds it must route the
  embedded view through it too ([[CORE74]] review).
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
  `ensureOwnProgram` and `mergeOperation` are the worked examples. **Composing one program into another**
  (`recordMessages` in `src/messaging/capture.ts`, [[CORE68]]): spread the inner `reads` into the outer's; in
  `build`, call the inner `build`, drop its `result` step and put its steps first (its events precede yours);
  `unit()` allows one `first-mutation` and one `first-event`, so label your own first INSERT and first event only
  when the inner program emitted no steps; the outer has no `result` step when `build` already knows the answer
  (`decode` returns it). Read what you need (`own`, say) through your own namespaced read, not the inner
  program's internal rows. Keep the statement count constant by emitting every set statement even for an
  empty set; filtering empty sets out changes the shape per chunk (M12).
- **Every unit runs as a `StorageIdentity` with a required `kind`** ([[CORE41]] C1). Composition code picks it, never
  request input:
  - `tenant` (`actorId`, `organizationId`): Postgres RLS role plus the org writer lock when it mutates; D1 refuses a
    foreign organisation before SQL;
  - `account` (`actorId`): a signed-in user's own cross-organisation **reads** (`me.get`). Postgres service role; a
    mutating account unit is refused with `StorageError` before SQL on both engines;
  - `internal` (`organizationId: string | null`): API-key auth, lookup, first sight, the directory, bootstrap.
    Postgres service role; the writer lock only when it mutates **and** names an organisation (a non-UUID is refused
    before SQL). D1 admits its own organisation or `null`, nothing else.
- **On Postgres the plan reads of an unlocked internal unit are not one snapshot** ([[CORE41]] review). With no writer
  lock (`organizationId: null`), each plan read is its own READ COMMITTED statement, run one at a time in insertion
  order. A concurrent commit can land between two reads. So order them so that every interleaving reads as a
  consistent state: first sight reads the **email before the subject**, because a winner commits both together, so
  "email held" implies a later subject read sees the winner. Reading the subject first misreported a same-subject race
  as `409 account_conflict` (found by the 20-trial concurrency suite). The commit-time guards (an `assertStep` on the
  row you meant to create, `expect`, `exactly`) are what make such a unit safe; the plan is only a hint. If two reads
  cannot be ordered safely, make them one statement.
- **A unit that runs inside sign-in retries drift once; webhook units do not** ([[CORE41]] P7, P8). First sight
  reruns as a read-only recheck (winner → login; email held → `409 account_conflict`; neither → `409 conflict`),
  and repair reruns the same unit with a fresh plan. A recheck that cannot write cannot loop. Reconcile and refresh
  map drift to `409 conflict` and let Svix redeliver.
- **Testing on both engines:** see `writing-tests` section 3 (engine in the file name: `.postgres.test.ts` / `.d1.test.ts`, a shared `.suite.ts` body; no flag or `skipIf`).

## The service context and tenancy

Every operation runs as one prepared unit under a storage identity carrying the actor (user or agent principal),
and, for tenant units, the organisation. The granted scopes are checked by `run()` before the unit. Tenancy is the **organisation**. The scoping wrappers in
`packages/db/src/tenancy.ts` (exported from `@vault/db`) are the only code that sets role or session config:

| Wrapper | Use |
|---|---|
| `withOrganization(db, { principalId, organizationId }, fn)` | The default. Validates both ids (throws `TenancyContextError`, codes `missing_organization` / `missing_principal` / `invalid_id`) before opening a transaction, sets `app.organization_id` / `app.principal_id` with `set_config(…, true)`, then `SET LOCAL ROLE vault_authenticated`. |
| `withServiceRole(db, fn)` | `SET LOCAL ROLE vault_service` (BYPASSRLS), no tenant context. Auth lookups and cross-tenant maintenance only. |

The app connects as `vault_app` (`LOGIN NOINHERIT`, a member of both roles, no privileges of its own), so
a query outside a wrapper fails with `42501`. `vault_authenticated` has no `DELETE`/`TRUNCATE` anywhere,
only `SELECT, INSERT` on `events`, and nothing on `api_keys`. `vault_service` has `SELECT, INSERT, UPDATE`
(events `SELECT, INSERT`), no `DELETE`, and nothing on Kysely's tables.

Programs never call the wrappers or touch a transaction. The Postgres runtime picks the wrapper from the unit's
`StorageIdentity`: `withOrganization` for `tenant`, `withServiceRole` for `account` and `internal`. Only enterprise
packages and tests import `@vault/db` (invariant 10); seeds run under `withServiceRole`.

- **Do not use a plain `db.transaction()` because "RLS isn't wired yet".** The role and gate exist; bypasses
  that rely on future-you remembering to switch back are dead on arrival.
- **Org-required operations guard first, then execute.** Return one consistent error shape and status for "no
  active organisation" across the whole API (decide it once in the first API cycle; the predecessor ended up with two
  shapes by route family and regretted it).
- **Keep tenancy transactions short** and never hold one across a storage call (see `hyperdrive-pg-rls`).

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
    into the 403 (see the order above). **One exception, D1 only** ([[CORE36]] D19, [[CORE41]] P13): a D1 serves
    one provider organisation, so a token claiming another `(provider, externalId)` than the binding's
    `authProvider`/`authOrgId` is `403 organization_forbidden` right after `verify`: no lookup, no fetch, no SQL.
    That decision is about the deployment, not the operation. The webhook acknowledges a D1 delivery for another
    organisation `200` with no fetch. Golden names it as the one engine difference.
  - A user's active organisation is the token's `o` claim; `X-Organization-Id` is only a cross-check, compared
    case-insensitively for users and agents (the [[CORE2]] upper-case-UUID lesson).
  - Anything else is an API key: `vk_` plus 32 random bytes in base64url, stored as SHA-256 hex, looked up
    in one internal unit (`apiKeyAuthOperation`, hashed before the unit) together with its agent. Revoked keys,
    expired keys (`expires_at <= now`, compared in the program against the injected clock) and disabled agents all
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
- **A provisioner that creates a parent and a child on first sight** (`src/auth/first-sight.ts`, [[CORE41]] P7): any
  network call (the profile fetch) and normalisation **before** the unit. Then plan-read every unique key the insert
  can collide on, insert the parent with an app-minted id, the child with `ON CONFLICT DO NOTHING`, and
  `assertStep` that the child row for the natural key carries **this** parent's id. A race loser inserts nothing,
  fails the assertion and drifts; the whole unit rolls back, so no orphan parent remains on either engine. No key lock.
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

## The MCP adapter ([[API106]])

`POST /mcp` (`src/mcp/`) is root machinery, not an operation: stateless, one JSON-RPC message in, JSON out.
- **Tools come from the registry** (`deriveTools`): every operation except `output: 'binary'` ones, named by
  `toolName`, a flat input schema (params, query and body fields as siblings; a name collision is an
  error at derivation). A new operation is a tool with no MCP code. `tools/list` filters by `isVisible` (the caller's scopes,
  human-only meta operations never shown to agents) and runs no storage unit.
- **`splitArguments`** sends path and query values over as strings (REST coerces them), the rest into the body;
  an unknown name goes into an object body (a strict schema refuses it) or, with no body, is
  `400 validation_error`. Execution is `executeOperation`, so errors, scopes and events are REST's.
- **Status codes ([[API117]]):** an envelope fault (`-32700`, `-32600`: the body is not one JSON-RPC message) is
  HTTP `400` with `id: null` (`envelopeFault` in `src/mcp/handler.ts`); an error answering a well-formed request
  (`-32601`, `-32602`) is HTTP `200` with the id echoed, because the SDK client discards the body of any non-2xx and
  would lose the code. The SDK interop test in `packages/server-d1/src/mcp.test.ts` (an unknown method rejects with
  `McpError -32601`) is what pins the `200`; a new request-level error belongs on the `200` side. Transport refusals are plain HTTP with the REST error body
  (`400` version, `401`, `403 origin_forbidden`, `405`, `413`, `415`). An `ApiError` from an operation is a tool
  result with `isError: true`.
- **Origin** is checked in a `/mcp` middleware registered before CORS (an absent `Origin` passes, a present one
  must be in `corsOrigins`); `MCP-Protocol-Version` is in the CORS `allowHeaders`.
- **The instructions text (`src/mcp/instructions.ts`) is pinned:** a test fails if it names a tool that doesn't
  exist. Renaming an operation it mentions means editing the text.
- **The reference client is the referee.** `@modelcontextprotocol/sdk` is an exact-pinned devDependency of
  `@vault/server-d1` only; its `Client` runs against `composeD1Worker` in `src/mcp.test.ts`, and `smoke:worker`
  checks the bundle does not contain it. Never import it from `packages/api/src` or `src/worker.ts`.

## A static page on the API origin ([[UI30]])

`/connect` is the pattern for any page the Worker serves (`packages/server-d1/src/connect-serving.ts`):
- **Workers Static Assets with `run_worker_first` for the page's prefix only.** `assets` is the one block every
  env inherits (unlike `vars`, `d1_databases`, `r2_buckets`, `routes`). Build into a directory that mirrors
  the request prefix (`dist/assets/connect/…`), so no asset exists at any other path even if
  `run_worker_first` were widened. In `smoke:worker`, Miniflare serves it with
  `assets: { directory, binding, routerConfig: { has_user_worker: true, static_routing: { user_worker: [...] } } }`.
- **The Worker sets the security headers on every response kind** (HTML, asset, `308`, `404`, `405`): a CSP
  built per request from `CLERK_ISSUER`, `nosniff`, a referrer policy, and `no-store` on HTML. Test them
  in an `afterEach` over every response the test saw, so a new branch cannot skip them.
- **The page answers before the migration, marker and configuration gates.** It is static, and the API calls it
  makes meet those gates.
- **The page is an API client:** a Bearer session token per request, only existing operations, values
  rendered as text (`textContent`), with a source guard against markup sinks and browser storage. DOM tests
  run under `happy-dom` per file (`// @vitest-environment happy-dom`).
- **Clerk's `signOut()` with no `redirectUrl` lands on the origin root**, which is the API's 404. Pass the page's
  own path. Only a real browser run caught this.

## Large bytes and object storage

- `ObjectStore` (`src/objects/store.ts`, [[CORE58]]) is `put`, `get`, `delete`: `r2ObjectStore(bucket)` over the structural
  `R2BucketLike` (no `@cloudflare/workers-types` import) and `memoryObjectStore()` for tests. No Node built-in: production
  `@vault/api` runs in workerd (`smoke:worker` and `open:check` are the checks). `AppOptions.objects` carries it; the D1 Worker
  builds it from an optional `BODIES` binding. Postgres holds a pointer and metadata only.
- The key layout ([[CORE25]] D23) is pure functions in `src/messaging/r2-keys.ts`: `content_key` is
  `orgs/<org>/messages/<channel>/<sha256 hex of external_id>` (no trailing slash), the body `<content_key>/v<version>/body.md`,
  `storage_key` `orgs/<org>/files/<object id>` and the bytes `<storage_key>/blob`. Reader and writer both import them.
- **Objects are read after the unit.** An operation declares `objects(value, store)`: its read unit returns the hidden key to the
  stage only (never into a response or event), and the app calls the stage once the unit has finished, so a unit never calls R2.
  A composition without a store answers `503 objects_unavailable` after the scope checks and before any unit.
- **Binary output.** `output: 'binary'` (status 200, no response schema, an `objects` stage) returns a `BinaryBody`;
  the app sets `Content-Type` (`safeContentType`: `type/subtype` or `application/octet-stream`), `Content-Length`,
  `Content-Disposition` (`contentDisposition`: ASCII fallback plus RFC 5987 `filename*`), `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox`. `mime_type` and `name` come from a mail sender: never put them in a header raw.
  A sanitiser for an untrusted header value rejects the **whole** value on any control character before it parses
  anything: cutting `text/html; charset=utf-8\r\nx: y` at `;` first would have accepted it as `text/html` ([[CORE58]]
  review ruling).
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
    once a minute, in the key-auth unit, guarded `last_used_at IS NULL OR < cutoff`, with no `expect` (a racer may
    have stamped it), no event and no `updated_at` ([[CORE15]], [[CORE36]] D17).
- `sql.ref(alias)` emits a quoted identifier; if the surrounding raw SQL declares an unquoted alias, pass its
  folded lowercase spelling or Postgres says `42P01`.
- **Kysely 0.27's `JoinBuilder` has no `orOn`.** An OR inside a join needs `.on((eb) => eb.or([...]))`.
  (The vault has no canonical-contact alias to join across: contacts are people and identities are
  addresses, [[CORE2]] D1.)
- **Find-or-create needs no key lock** ([[CORE36]] D3, [[CORE41]]: `lockKeys` is deleted). On Postgres the org
  writer lock serialises tenant writers; an internal unit with no organisation has no lock, and its commit-time
  assertion makes a racing loser abort whole (see "A provisioner …" above). On D1 the atomic batch plus the unique
  index does the same (`409 conflict` or the sign-in retry, no orphan parent).
- **Canonicalise ids before comparing or sorting them in JS.** `z.uuid()` accepts upper case, Postgres
  treats both cases as one uuid, JS string comparison does not. An upper-cased self-merge got past an
  `===` guard into a CHECK violation (an unmapped 500), and a case-sensitive sort can invert a lock order
  ([[CORE2]] review). Lower-case at the top of the command.

## Things to avoid

- Importing `db`, `@vault/db` or a runtime package in `packages/api` production code (the boundary test fails).
- Inserting into a resource's table from anywhere but its service layer.
- A route or MCP tool that bypasses the registry.
- Re-declaring middleware-set context variables on a route's `Hono<{ Variables }>`.
- Unit tests that mock the Hono context; use an integration test against the real DB.
- Normalizing a stored string value (an error code, a status) without first grepping the OLD spelling across
  **every** package, not just the one being touched.
