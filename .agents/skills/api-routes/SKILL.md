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

**This package is not built yet.** The sections below are the contract the first CORE and API cycles
implement. Where this skill names a file, it is the intended path; correct it when the file lands.

## Operations: define once, expose everywhere

Every operation is one registry entry: a name, input and output zod schemas, the **scope** it requires, and
a handler that receives the service context. REST routes and MCP tools are generated from the registry by
thin adapters, so the surfaces cannot drift apart and OpenAPI comes from the same schemas. Do not hand-write
a route or an MCP tool that bypasses the registry.

- Reads and writes go through the same registry. There is no second read path (no GraphQL, no direct table
  access from a handler).
- Commands are ordinary registry entries exposed as POST routes (`POST /contacts/{id}/merge`), so they get
  scopes, MCP tools and OpenAPI for free.
- Hono RPC (`hc`) is the typed client over those routes for TypeScript consumers; `@hono/zod-openapi` routes
  keep its typing. It is a client, not a separate transport.

## Resources: declarative definitions, generic CRUD

A resource (contact, company, task, deal, interaction) is a definition: table, zod schema, scopes,
validators, and which fields agents may write. Generic create, read, update, delete and list run from the
definition inside the service context. **Every write for a resource goes through that layer; nothing else
inserts into its table.** Keep definitions small and give each one an escape hatch (a validator or a custom
handler); a generic layer that tries to express every behavior turns into a framework to fight.

Adding a resource also means adding it to the **contract suite** (see Testing); don't hand-write those
tests.

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
only `SELECT, INSERT` on `events`, and nothing on `api_keys`.

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

## Principals and scopes

Agents are first-class principals with their own identity, credentials and **scopes** (which channels,
which contacts or companies, read vs. suggest). Every registry entry declares the scope it needs and the
service context enforces it, so scope checks are written once.

- Auth middleware, two kinds, never both on one route: human sessions (Clerk) and **API keys / agent
  tokens** (hashed at rest, looked up under `withServiceRole`, never logged beyond a short prefix).
- **Agents never get send rights.** An agent's write surface is "submit a suggestion"; sending is performed
  by the vault's execution rail with credentials it holds.
- A provisioner that creates the user or organisation row on first sight must SELECT first and INSERT only
  on a miss.

## Every write emits an event

A write appends an event row (`task.created`, `contact.updated`, with `before` and `after`) to the `events`
table **in the same transaction**. Hooks, webhooks, the agent cursor and the audit trail all read that one
table. Because the event commits with the write, a crash between commit and delivery cannot lose it (the predecessor's in-memory after-commit kick could, and needed recovery crons). Commands emit through the same outbox.
`before`/`after` scalars into a jsonb column need `JSON.stringify` (see `db-schema-and-migrations`).

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

**Real Postgres, no mocking the context.** Integration tests call the app in-process
(`app.fetch(new Request(…))`), seed through the same helpers production code uses, and assert DB rows
directly. Unit tests only for pure helpers.

**The test pool behaves like production: nothing is preset.** The predecessor's test pool presets
`app.organization_id` and `service_role` globally, so a query that skips its tenancy wrapper passes every
test and reads or writes zero rows in production. The vault's pool (`createTestDb()` from `@vault/db/test`)
connects as `vault_app` and presets nothing, every fixture names its organisation, and a query without a
wrapper fails in tests. Seeds (`seedOrganization`, `seedUser`, `seedAgent`) run under `withServiceRole`;
there is deliberately no task or event seed: create those through the service layer. `createOwnerTestDb()`
is for `truncateAll` and catalog inspection only, never fixtures. Both factories refuse a database whose
name doesn't match `/(^|_)test(_|$)/`.

- **A cross-tenant test needs a REAL second organisation** with an explicit `organization_id` threaded
  through every fixture on the other side. Two "different" users that land in one default org prove nothing;
  RLS has nothing to separate and the assertion passes for the wrong reason.
- **The contract suite runs over every resource definition automatically:** create emits
  `<resource>.created`; cross-tenant reads return nothing; a missing scope is refused; the REST and MCP
  adapters both work. The generic machinery (tenancy isolation, scope enforcement, an event on every write,
  webhook delivery and retries, the cursor) is tested once, in depth. Bespoke tests are for real logic:
  commands (merge, send, suggestion lifecycle) and channel adapters.
- **An absence test ("never reveals X") only counts once seen failing** with the leak deliberately injected,
  on every code path that renders the value.
- `truncateAll(owner)` lists every `public` base table from the catalog at call time (except Kysely's two), so a new table needs no harness edit.
- `beforeEach` is scoped to its enclosing `describe`. A second top-level `describe` in a file does not
  inherit the first one's reset; give it its own.
- Before API tests: `pnpm db:test:reset` (or `db:test:worktree`). Run: `pnpm -C packages/api test [file]`.
- **A full-suite failure that reproduces standalone is a real bug, not contention.** If it only fails in the
  full run and passes alone, rerun once. To tell "my change broke it" from "it was already broken", revert
  your diff against the clean tree and rerun; a pre-existing failure belongs in a follow-up, not in your
  commit.
- Never run two API suites against one database at once (`pgrep -f vitest`).
- For file downloads, assert a UTF-8 BOM on `response.arrayBuffer()` (`EF BB BF`), not `response.text()`:
  Fetch's decoder strips the BOM.
- Postgres `NUMERIC` comes back from `pg` as a string even when a `sql<number>` annotation says otherwise.
  Convert at the DTO boundary and assert actual JSON value types in route tests.

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
- Fire-and-forget updates (`.execute().catch(() => {})`) only for observability columns like `last_used_at`
  where a lost write is acceptable.
- `sql.ref(alias)` emits a quoted identifier; if the surrounding raw SQL declares an unquoted alias, pass its
  folded lowercase spelling or Postgres says `42P01`.
- **Kysely 0.27's `JoinBuilder` has no `orOn`.** An OR across a merged-identity alias (a contact and its
  canonical contact) needs `.on((eb) => eb.or([...]))` inside the join, or a small resolver query first.
  Check for an existing resolver before hand-rolling an identity-graph join.

## Things to avoid

- Importing `db` in a handler instead of using the service context.
- Inserting into a resource's table from anywhere but its service layer.
- A route or MCP tool that bypasses the registry.
- Re-declaring middleware-set context variables on a route's `Hono<{ Variables }>`.
- Unit tests that mock the Hono context; use an integration test against the real DB.
- Normalizing a stored string value (an error code, a status) without first grepping the OLD spelling across
  **every** package, not just the one being touched.
