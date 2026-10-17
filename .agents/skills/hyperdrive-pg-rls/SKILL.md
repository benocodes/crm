---
name: hyperdrive-pg-rls
description: How node-postgres (`pg`), Kysely, Cloudflare Hyperdrive (transaction-mode pooling) and session-state RLS (`SET LOCAL`) interact in Cloudflare Workers. Read whenever the API Worker shows intermittent hangs ("Workers runtime canceled this request"), `timeout exceeded when trying to connect`, or `prepared statement "<hash>" does not exist` (SQLSTATE 26000), and whenever changing pool config, Hyperdrive config, the tenancy transaction wrappers, or the Worker bundle's build defines.
---

# Hyperdrive ↔ `pg` ↔ RLS in Workers

Inherited from the predecessor product, where a multi-hour incident taught this: the API Worker hung ~50% of requests right
after org-scoped RLS went live, traded those hangs for `prepared statement does not exist` once the pool
was tuned, and only then settled. Several independent layers had to agree before any tenant-scoped query
worked end to end. The vault uses the same stack minus the GraphQL layer (no PostGraphile, no
`@dataplan/pg`), which removes one of that stack's layers but not the others.

## The layers and why they fight

1. **Postgres extended-query protocol.** A parameterized query goes `PREPARE → BIND → EXECUTE`. A *named*
   prepared statement lives on the specific backend connection it was prepared on.
2. **`pg` (node-postgres).** Sends `PREPARE` once per named statement per client and reuses the name,
   assuming the socket maps 1:1 to one backend for the client's lifetime. `pg` only names a statement if
   the query config has a `name`; **never set `name`** on a query that runs through Hyperdrive.
3. **`pg.Pool`.** `idleTimeoutMillis` is when an unused client is *torn down*, so the next acquire opens a
   fresh TCP socket. `max` caps concurrent clients per pool.
4. **Hyperdrive.** Transaction-mode pooling: it can hand the same client connection to different upstream
   backends *across transactions*. The pool is global across Workers isolates.
5. **RLS via `SET LOCAL`.** A tenancy wrapper opens a transaction, runs `SET LOCAL ROLE`, resolves the
   actor and organisation, `set_config('app.user_id', …, true)` and `set_config('app.organization_id', …,
   true)`, then runs the work. RLS policies read those `current_setting()` values. `SET LOCAL` is
   transaction-scoped.

How they conflict:

- **Long-lived module-scope `pg.Pool` + Workers isolates.** Cloudflare's guidance is to create a new client
  per request. A long-lived pool pins TCP sockets across requests; under concurrency it exhausts, and
  `pool.connect()` queues *forever* with no default `connectionTimeoutMillis`. Symptom: `Workers runtime
  canceled this request because it detected that your Worker's code had hung`.
- **`pg.Pool` evicts a client mid-request.** A short `idleTimeoutMillis` closes the client between two
  queries of one request; the next acquire gets a fresh socket on a different upstream backend. Symptom:
  `prepared statement "<hash>" does not exist`, SQLSTATE `26000`, inside an otherwise successful request.
- **Hyperdrive rotates backends between transactions** even on a live socket, so any named statement
  prepared in transaction 1 can fail in transaction 2 with the same 26000.
- **Long transactions starve the multiplexer.** Hyperdrive's docs warn that wrapping multiple operations in
  one transaction to keep `SET` state stops the connection being reused by other isolates for the
  transaction's duration. `SET LOCAL` needs a transaction, so the RLS model forces this; sub-millisecond
  transactions make it fine *as long as we don't also fight Hyperdrive at the pool layer*.

## The configuration that works

### 1. A per-request pool via `AsyncLocalStorage` (`packages/db/src/db.ts`)

Create a `pg.Pool` per request with `max: 1` inside an `AsyncLocalStorage` scope and `pool.end()` in a
`finally`. That approximates "new client per request" in the shape Kysely's `PostgresDialect` requires
(it needs a `Pool`; a `max: 1` pool *is* a per-request client wrapped in the right shape).

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
const requestPoolStore = new AsyncLocalStorage<PgPool>()

export async function withRequestPool<T>(connectionString: string, fn: () => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString,
    max: 1,                      // one upstream connection per request
    idleTimeoutMillis: 0,        // do NOT evict mid-request (see 2)
    connectionTimeoutMillis: 15_000,
  })
  try {
    return await requestPoolStore.run(pool, fn)
  } finally {
    pool.end().catch(() => {}) // background cleanup; don't block the response
  }
}

// Kysely's lazy proxy reads the per-request pool first, then falls back to a module-scoped
// pool for Node dev, tests and scripts.
function getPool(): PgPool { return requestPoolStore.getStore() ?? getModulePool() }
```

Every Worker `fetch` (and every queue or workflow step that touches the DB) runs inside that scope:

```ts
return withRequestPool(env.HYPERDRIVE.connectionString, async () => app.fetch(req, env, ctx))
```

### 2. Do not use `idleTimeoutMillis` as request-end cleanup

It's tempting to set `idleTimeoutMillis: 1` for per-request semantics without an explicit `pool.end()`. That
closes the connection between two sequential queries and the next one lands on a different backend. Use
`idleTimeoutMillis: 0` plus the explicit `pool.end()` in the `finally`.

### 3. Keep tenancy transactions short; SELECT first in hot-path provisioners

- Keep the work inside a tenancy wrapper to a single round trip's worth of SQL. Don't batch unrelated
  operations into one transaction for convenience.
- Hot-path provisioners (find-or-create the user or organisation row on first sight) must **SELECT first,
  INSERT only on miss**. An unconditional `INSERT … ON CONFLICT DO UPDATE` opens a write transaction on
  every request; under concurrency it serializes on the row lock and starves the pool.

### 4. Don't go the other way

- **Don't drop RLS** and rewrite every query with `WHERE organization_id = $1`. A per-request pool and no
  named statements make the `SET LOCAL` model work with Hyperdrive.
- **Don't switch Hyperdrive to session-mode pooling.** Transaction mode is the right default; avoid named
  prepared statements instead.
- **Don't use `pg.Client` directly** as a one-off per-request client; Kysely wants a `Pool`.

## Diagnosing

| Symptom | Layer | Fix |
|---|---|---|
| `Workers runtime canceled this request because it detected that your Worker's code had hung`, nothing logged from the handler | `pool.connect()` queues forever: no `connectionTimeoutMillis`, or pool exhausted | Set `connectionTimeoutMillis`; use the per-request `max: 1` pool; check provisioners aren't opening write transactions on every request |
| `timeout exceeded when trying to connect` | Pool exhausted under concurrency | Confirm the per-request pool; only then raise `max`, cautiously (Hyperdrive has a per-config soft cap) |
| `prepared statement "<hex>" does not exist`, SQLSTATE `26000` | A named statement spanned a backend change | Make sure no query sets `name`; `idleTimeoutMillis: 0` within a request |
| 200 responses that take 1–2s | `connectionTimeoutMillis` firing and being swallowed by a caller | Look for the swallowed error in `wrangler tail` |
| Healthy: <100ms, no `Canceled` or `Exception Thrown` in `wrangler tail` | — | — |

Always log the unmasked error to `console.error` where the response masks it; `wrangler tail` is only
useful if the error reaches it.

## When in doubt, instrument first

The original incident dragged because fixes were guessed (`max` 1, 5, 10, various idle timeouts) without
ever looking at which await was actually stuck. The faster path:

1. `wrangler tail <worker> --format=pretty` while reproducing.
2. `Canceled` with no error log means the hang is *before* your error handling: in auth and provisioning,
   or in `pool.connect()`.
3. An actual error in the log is the trace; read its path and message.
4. If queries reach Postgres and complete (`pg_stat_activity`) but the request fails, it's a serialization
   or race problem, likely Hyperdrive rotating connections.
5. Only once you know which `await` is long, change pool or driver config.

## Where this lives in the vault

These files arrive with the CORE cycles that build the tenancy layer; keep this list current when they do.

- `packages/db/src/db.ts`: today only `createDb(url, { max })`, a plain factory (Node pool,
  `connectionTimeoutMillis: 2_000`); no module-level instance. `withRequestPool`, the ALS store and the
  per-request pool arrive with the Worker in [[CORE12]].
- `packages/api/src/worker.ts` ([[CORE12]]): wraps `fetch` in `withRequestPool`.
- `packages/db/src/tenancy.ts`: the tenancy wrappers `withOrganization(db, { principalId, organizationId }, fn)`
  and `withServiceRole(db, fn)`; one `set_config(..., true)` statement plus `SET LOCAL ROLE`, then `fn`.
- `packages/api/src/auth/`: SELECT-first provisioners.

## References

- [Connect to PostgreSQL · Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/): "create a new Client on each request"
- [Connection pooling · Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/): transaction mode and the "don't wrap multiple operations in one transaction" warning
- [How Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/): the multiplexing model
