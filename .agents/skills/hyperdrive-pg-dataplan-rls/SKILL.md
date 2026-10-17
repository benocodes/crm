---
name: hyperdrive-pg-dataplan-rls
description: How node-postgres (`pg`), `@dataplan/pg`, Cloudflare Hyperdrive (transaction-mode pooling), and session-state RLS (`SET LOCAL`) interact in Cloudflare Workers. Read whenever the API worker (`packages/api`) shows intermittent GraphQL hangs ("Workers runtime canceled this request"), `timeout exceeded when trying to connect`, or `prepared statement "<hash>" does not exist` (SQLSTATE 26000) — and whenever changing pool config, Hyperdrive config, the `withOrganization` / `withUser` transaction wrappers, or the worker bundle's esbuild defines.
---

# Hyperdrive ↔ `pg` ↔ `@dataplan/pg` ↔ RLS in Workers

A reference written after a multi-hour incident where the `donna-api` Cloudflare Worker would hang ~50% of GraphQL requests right after CORE-014 went live, then trade those hangs for `prepared statement does not exist` once the pool was tuned, then finally land on a stable config. Four independent layers had to agree before any tenant-scoped query worked end-to-end.

## The four layers and why they fight

1. **Postgres extended-query protocol.** Every parameterized query goes `PREPARE → BIND → EXECUTE`. The prepared statement lives on the specific Postgres backend connection it was prepared on.
2. **`pg` (node-postgres).** Sends `PREPARE` once per named statement per client. Reuses the name on subsequent `EXECUTE`s. Assumes the underlying socket maps 1:1 to one Postgres backend for the client's lifetime.
3. **`pg.Pool`.** Pools `pg.Client`s in your process. `idleTimeoutMillis` is when an unused client is *torn down* — next acquire opens a fresh TCP socket. `max` caps concurrent clients per pool.
4. **Hyperdrive.** Sits between your TCP socket and the real Postgres in **transaction-mode pooling**: it can hand the same client connection to different upstream Postgres backends *across transactions*. The pool is global across Workers isolates.
5. **(bonus) `@dataplan/pg`.** Caches named prepared statements per `pg.Client` for performance. Default cache size = 100 named statements.
6. **(bonus) RLS via `SET LOCAL`.** Our `withOrganization(clerkId, clerkOrgId, fn)` opens a transaction, runs `SET LOCAL ROLE service_role` → resolves user_id + org_id → `set_config('app.user_id', …, true)` + `set_config('app.organization_id', …, true)` → `SET LOCAL ROLE authenticated`, then runs `fn`. RLS policies read those `current_setting()` values. `SET LOCAL` is transaction-scoped.

The conflict surfaces:

- **Long-lived `pg.Pool` (module scope) + Workers isolates.** Cloudflare's explicit guidance is *"create a new Client on each request, as Hyperdrive manages the underlying pool, so client creation is fast."* A long-lived pool pins TCP sockets across requests; under any concurrency the pool exhausts faster than connections release, and `pool.connect()` queues *forever* (no default `connectionTimeoutMillis`). Symptom: `Workers runtime canceled this request because it detected that your Worker's code had hung`. ([Connect to PostgreSQL · Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/))
- **`pg.Pool` evicts a client mid-request.** A short `idleTimeoutMillis` (e.g. `1`) closes the client between two queries in the same request. The next acquire opens a fresh TCP socket; Hyperdrive routes it to a different upstream backend; any prepared statement created earlier in the request is gone. Symptom: `error: prepared statement "<hash>" does not exist`, SQLSTATE `26000`, in the middle of an otherwise-successful 200.
- **Hyperdrive rotates upstream backends between transactions.** Even when the `pg.Client` socket stays alive across queries, Hyperdrive in transaction-mode pooling can route consecutive transactions on that socket to different upstream backends. `@dataplan/pg`'s prepared-statement cache assumes the backend is stable — so a `PREPARE name=X` in tx 1 and `EXECUTE X` in tx 2 fails with the same 26000.
- **Multi-operation transactions starve Hyperdrive's multiplexer.** From [Connection pooling docs](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/): *"It is not recommended to wrap multiple database operations with a single transaction to maintain the `SET` state. Doing so will affect the performance and scaling of Hyperdrive, as the connection cannot be reused by other Worker isolates for the duration of the transaction."* Our `withOrganization` does exactly this (`SET LOCAL` requires a transaction), but our transactions are sub-millisecond so it's OK *as long as we don't fight Hyperdrive at the pool layer too*.

## The configuration that actually works

This stack — `pg` + Kysely + `@dataplan/pg` (PostGraphile / grafast) + RLS via `SET LOCAL` + Hyperdrive — has exactly four moving parts. Get all four right or you fail intermittently.

### 1. Per-request `pg.Pool` via `AsyncLocalStorage` (`packages/db/src/db.ts`)

A long-lived module pool is wrong. The Cloudflare-recommended pattern is "new Client per request"; we approximate that by creating a `pg.Pool` per request with `max: 1` inside an `AsyncLocalStorage` scope, then explicitly `pool.end()` in a finally block.

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
const requestPoolStore = new AsyncLocalStorage<PgPool>()

export async function withRequestPool<T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString,
    max: 1,                       // one upstream conn per request
    idleTimeoutMillis: 0,         // DO NOT evict mid-request (see #3)
    connectionTimeoutMillis: 15_000,
  })
  try {
    return await requestPoolStore.run(pool, fn)
  } finally {
    pool.end().catch(() => {})    // background cleanup; don't block response
  }
}

// Kysely's lazy proxy reads the per-request pool first, falls back
// to a module-scoped pool for Node dev / tests / scripts.
function getPool(): PgPool {
  return requestPoolStore.getStore() ?? getModulePool()
}
```

In `packages/api/src/worker.ts`, every `fetch` runs inside that scope:

```ts
async fetch(req: Request, env: Env): Promise<Response> {
  boot(env)
  // …
  return withRequestPool(env.HYPERDRIVE.connectionString, async () => app!.fetch(req))
}
```

grafast's preset reads the same pool out of ALS so it shares the request's single connection:

```ts
async context() {
  const pool = getRequestPool()
  if (!pool) throw new Error('grafast context: no per-request pg pool in scope')
  return { …baseCtx, withPgClient: createWithPgClient({ pool }) }
}
```

Result: one TCP socket per request, released to Hyperdrive's edge pool when the request finishes. Kysely and grafast share it.

### 2. **Do not** use `idleTimeoutMillis` as request-end cleanup

It's tempting to set `idleTimeoutMillis: 1` for "per-request semantics without an explicit `pool.end()`." That breaks queries within a single request — the connection closes between two sequential queries and the next one opens a fresh socket onto a *different* upstream Postgres backend. Symptom is the 26000 prepared-statement error.

Use `idleTimeoutMillis: 0` (no idle eviction) + explicit `pool.end()` in the `finally` block.

### 3. Disable `@dataplan/pg`'s named prepared statement cache

Even with a stable `pg.Client`, Hyperdrive can rotate upstream backends between transactions. `@dataplan/pg` caches up to 100 named prepared statements per client and re-references them on later queries; if the underlying backend changed, the second `EXECUTE` fails.

The library has an explicit env-var escape hatch:

```js
// node_modules/@dataplan/pg/dist/adaptors/pg.js
// Set `DATAPLAN_PG_PREPARED_STATEMENT_CACHE_SIZE=0` to disable prepared statements
const PREPARED_STATEMENT_CACHE_SIZE = …
```

In the worker bundle, set it at *build time* (esbuild `define`) so it lands before the module evaluates:

```js
// packages/api/scripts/build-worker.mjs
define: {
  'process.env.NODE_ENV': '"production"',
  'process.env.DATAPLAN_PG_PREPARED_STATEMENT_CACHE_SIZE': '"0"',
},
```

With this set, `@dataplan/pg` sends anonymous parse-bind-execute messages (no `name` on the query object), which Hyperdrive can multiplex across backends freely.

### 4. Keep `withOrganization` transactions short, and **SELECT first** in hot-path provisioners

`SET LOCAL` requires a transaction. That's unavoidable for our RLS model. But Hyperdrive *will* punish long transactions by refusing to reuse the connection for other isolates while ours is open. So:

- Keep the work inside `withOrganization` to a single round-trip's worth of SQL — don't batch unrelated operations into one tx for convenience.
- Provisioner functions on the hot path (`ensureShadowUser`, `ensureShadowOrganization`) must **SELECT first, INSERT only on miss**. Unconditional `INSERT … ON CONFLICT DO UPDATE` opens a write transaction on every request — under any concurrency it serializes on the row lock and starves the pool. We hit this with `ensureShadowOrganization`: see git history in `packages/api/src/auth/shadow-organization.ts`.

## Diagnosing this stack

| Symptom | Layer | Fix |
|---|---|---|
| `Workers runtime canceled this request because it detected that your Worker's code had hung` (no error logged from inside the handler) | `pg.Pool.connect()` queues forever; no `connectionTimeoutMillis`; pool exhausted | Set `connectionTimeoutMillis`; move to per-request pool with `max: 1`; verify `ensureShadow*` aren't opening write tx on every request |
| `Error: timeout exceeded when trying to connect` (from `pg`, masked through `loggingMaskError`) | Pool exhausted under concurrency; max too low for the workload | Confirm per-request pool is set up; if still hot, raise `max` cautiously (Hyperdrive has a per-config soft cap) |
| `error: prepared statement "<hex>" does not exist`, SQLSTATE `26000`, path nests into grafast (`PgExecutor2._executeWithClient`) | Hyperdrive rotated upstream backends between queries that share a named prepared statement | Disable `@dataplan/pg`'s named-statement cache via `DATAPLAN_PG_PREPARED_STATEMENT_CACHE_SIZE=0` at *build* time; also ensure `idleTimeoutMillis=0` within a request |
| 1–2s GraphQL responses that *do* return 200 but feel wrong | Likely `connectionTimeoutMillis` is firing inside grafast and the error is masked; the response carries GraphQL errors but the HTTP envelope is 200 | Check `wrangler tail` for `[graphql]` log entries inside the 200 — the masked error tells you which layer is the actual culprit |
| Healthy: <100ms responses, no `Canceled`/`Exception Thrown` in `wrangler tail`, no `[graphql]` error logs | — | — |

`loggingMaskError` (`packages/api/src/graphql/mask-error.ts`) is your friend — it prints the unmasked error to `console.error` (visible via `wrangler tail`) while still hashing the client response. Always check `wrangler tail` first when something's off; the masked client-side hash alone is useless.

## What you DO NOT need to do

- **Don't drop RLS** and rewrite every query with explicit `WHERE organization_id = $1`. The per-request pool + disabled prepared-statement cache makes the `SET LOCAL` model work fine with Hyperdrive.
- **Don't switch Hyperdrive to session-mode pooling.** Transaction mode is the right default; we just have to avoid named prepared statements that span transactions.
- **Don't use `pg.Client` directly** as a one-off "per-request client." Kysely's `PostgresDialect` and `@dataplan/pg`'s `createWithPgClient` both demand a `Pool`. A `max: 1` Pool *is* a per-request Client wrapped in the right shape.

## When in doubt, instrument first

The whole incident dragged because I kept guessing at fixes (max=1, max=5, max=10, various idle timeouts) without ever looking at what the actual failing await was. The faster path:

1. `wrangler tail donna-api --format=pretty` while reproducing.
2. If you see `Canceled` / `Workers runtime canceled` with no `[graphql]` log → it's hanging *before* `loggingMaskError`. The hang is in `graphqlContextFromRequest` (auth + ensureShadow*) or in `pool.connect()`.
3. If you see `[graphql]` logs with an actual error → masked-error logging is your trace. Read the `path` and `original.message`.
4. If queries reach Postgres but fail (`pg_stat_activity` shows them complete) → it's a serialization/race issue, not a network one. Likely Hyperdrive rotating connections.
5. Only after you know which `await` is the long one, change pool or driver config.

## Files that encode this knowledge

- `packages/db/src/db.ts` — `withRequestPool`, `getRequestPool`, ALS, lazy proxy.
- `packages/api/src/worker.ts` — wraps `fetch` in `withRequestPool`; grafast reads the same pool.
- `packages/api/scripts/build-worker.mjs` — esbuild `define` for `DATAPLAN_PG_PREPARED_STATEMENT_CACHE_SIZE`.
- `packages/api/src/auth/shadow-organization.ts` — SELECT-first hot-path provisioner pattern.
- `packages/api/src/middleware/with-organization.ts` — short `SET LOCAL` transactions; never batch unrelated work.
- `packages/api/src/graphql/mask-error.ts` — `wrangler tail` is your eyes; always check it first.

## References

- [Connect to PostgreSQL · Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/) — "create a new Client on each request"
- [Connection pooling · Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/) — transaction-mode pooling, the "don't wrap multiple ops in one tx" warning
- [How Hyperdrive works · Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/) — connection multiplexing model
- `node_modules/@dataplan/pg/dist/adaptors/pg.js` — the `DATAPLAN_PG_PREPARED_STATEMENT_CACHE_SIZE` knob (see comments inside the file)
