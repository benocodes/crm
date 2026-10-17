---
name: api-routes
description: Preferences and patterns for writing API routes and backend services in packages/api — Hono + Kysely + Clerk/API-key auth on Neon Postgres. Use when adding or modifying any route under packages/api/src/routes/, writing middleware, wiring mutations, or writing integration tests against the backend.
---

# API Routes & Backend Services

Reference for backend work in `packages/api`. The stack is Hono on Node.js (port 3100), Kysely against Neon Postgres (through the org-scoping wrappers in `middleware/with-organization.ts`), Clerk for web sessions, bearer API keys for the extension, and PostGraphile/Grafast for GraphQL reads (mounted separately — don't touch it from route handlers).

## Route file shape

Every route file exports one named `Hono` instance typed with its context variables:

```ts
export const messagesRoute = new Hono<{
  Variables: {
    userId: string; clerkId: string
    clerkOrgId: string | null; organizationId: string | null
    apiKeyId: string
  }
}>()

messagesRoute.post('/', async (c) => { /* ... */ })
```

- Export name: `<name>Route` (camelCase, `Route` suffix).
- Path type: variables declared here match whatever the upstream middleware sets (`userId`, `clerkId`, `clerkOrgId`, `organizationId`, `apiKeyId`). Don't re-declare them inside handlers.
- Mount in **`src/app.ts`**, inside `createApp()`, alongside the existing calls:

```ts
app.use('/messages/*', requireApiKey)   // attach auth BEFORE the route
app.route('/messages', messagesRoute)
```

`src/index.ts` is **not** the mount point — it only calls `createApp()` and bolts GraphQL (grafserv) and the node server onto the result. Every `app.use(...)` / `app.route(...)` for a REST route lives in `app.ts`. The Workers entry builds the same app from the same factory, so a route mounted anywhere else simply doesn't exist in production.

Extension-facing paths get `requireApiKey` as an `app.use('/<path>/*', …)` line in `app.ts` immediately above their `app.route(...)`. Web-facing paths attach their auth *inside the route file* instead — either `apiKeysRoute.use('*', requireClerkUser)` or per-handler (`listingsRoute.post('/:id/off-market', requireClerkUser, …)`). Follow whichever the neighbouring routes use; don't mix the two styles within one route file.

## Auth

Two middlewares, never both:

- **`requireApiKey`** — bearer `Authorization: Bearer donna_sk_...`. Looks up a confirmed, un-revoked, un-expired `api_keys` row (under `service_role`, left-joining `organizations`); sets `userId`, `clerkId`, `clerkOrgId`, `organizationId`, `apiKeyId` on the context — `clerkOrgId`/`organizationId` are **null** for a key not bound to an org, so org-required routes must guard on them (below); fires a fire-and-forget `last_used_at` bump (`.execute().catch(() => {})`). Used by `/captures`, `/messages`, `/scrape-configs`, `/sos-reports`.
- **`requireClerkUser`** — Clerk session via `__session` cookie or `Authorization` bearer. Lazily creates the shadow `users` row on first touch with `onConflict().doUpdateSet(excluded.email)` to defuse thundering-herd double-inserts. Also lazily provisions the shadow `organizations` row via `ensureShadowOrganization` (`packages/api/src/auth/shadow-organization.ts`), which re-runs its "slow path" — insert-or-update-on-profile-drift, then re-seed the org's defaults (`seedPipelineStages`) — on **every** request whose Clerk `org_name`/`org_slug` claims don't match the cached row; test JWTs that omit those claims (most of them, via `signSessionJwt`) hit this on every call. Any per-org default-data seeder called from that path must be idempotent on "has this org been seeded at all", not just "would this exact insert conflict" — a per-key `ON CONFLICT DO NOTHING` lets org-specific custom rows (different keys) coexist with a stale reseed of the defaults instead of blocking it. Sets `userId`, `clerkId`. Used by `/api-keys`, `/users`.

If you need a new route, pick the existing middleware for the caller's identity shape — don't invent a third.

## Transactions: always an org-scoping wrapper

Tenancy is the **organization**, not the user (migrations 026–028, spec `CORE-014`). Every DB mutation in a route runs inside one of the wrappers from `middleware/with-organization.ts` — never a plain `db.transaction()`:

| Wrapper | Use |
|---|---|
| `withOrganization(clerkId, clerkOrgId, fn)` | **The route default.** Resolves `clerk_id → users.id` and `clerk_org_id → organizations.id`, sets `request.jwt.claims.sub`, `app.user_id`, `app.organization_id`, then `SET LOCAL ROLE authenticated`. Throws `MissingOrgError` if `clerkOrgId` is null. |
| `withOrganizationId(userId, organizationId, fn)` | Same tenant context from **internal** ids (no Clerk lookup) — for producers/workers that already hold them (e.g. agent-runs). |
| `withUser(clerkId, fn)` | Sets `app.user_id` only, no `app.organization_id` — org-scoped reads return zero rows by design. Rare. |
| `withServiceRole(fn)` | `SET LOCAL ROLE service_role` (BYPASSRLS), no tenant context — middleware lookups and cross-tenant maintenance only. |

Org-required routes **guard first, then wrap**. The guard's shape depends on **which auth
middleware** the route uses — these are two distinct, both-correct conventions, not drift:

- **`requireApiKey`/`requireOrganization`** routes (`captures`, `documents`, `messages`) —
  `403`, nested code:
  ```ts
  const organizationId = c.get('organizationId')
  const clerkOrgId = c.get('clerkOrgId')
  if (!organizationId || !clerkOrgId) {
    return c.json({ error: { code: 'no_active_organization' } }, 403)
  }
  const result = await withOrganization(clerkId, clerkOrgId, async (trx) => {
    // all trx.insertInto / trx.updateTable / trx.selectFrom calls here
    return { ok: true, ... }
  })
  return c.json(result)
  ```
- **`requireClerkUser`** routes (`contact-merge`, `inquiry-preferences`, `deal-match`, `channels`) —
  `400`, flat string:
  ```ts
  const organizationId = c.var.organizationId
  if (!organizationId) return c.json({ error: 'no_active_org' }, 400)
  ```

Match whichever family the new route's auth middleware belongs to — don't mix the two shapes
within one route, and don't assume there's a single canonical guard to copy.

**Do not** substitute a plain `db.transaction()` because "RLS isn't wired yet" — the role and the `app.organization_id` gate exist (migrations 002, 026–028) and `SET LOCAL ROLE` works with or without policies. Bypasses that rely on future-you remembering to switch back are dead on arrival.

**The "no active organization" 403 guard is not constructible via seeding today.** Migration `20260519_027_organization_id_columns.ts` made `api_keys.organization_id` `NOT NULL` with a cascading FK to `organizations(id)`, and `apiKeysRoute` only ever inserts a key through `requireOrganization`. A `seedUserWithKey`-style helper that omits `organization_id` still resolves to a real org (the session's `app.organization_id` default — the test pool's sentinel org, or whichever org an explicit `SET LOCAL` bound), so `requireApiKey` never actually produces a null `organizationId`/`clerkOrgId` from a seeded key. Keep the guard in new routes anyway (it matches `/captures/recent`'s shape and is genuine defense against a future schema change), but don't write an integration test that assumes you can seed your way into it firing (`DRV-002-e01-RETRO`).

Plain `db` (no wrapper) is reserved for middleware lookups (`auth-api-key`, `auth-clerk` shadow-row check — they set `service_role` themselves) and test fixtures. Route handlers never import `db` directly.

**TS gotcha:** if you re-run a helper closure through a second `withOrganization(...)` call (e.g. re-reading the winner after a unique-violation catch), don't type the callback's `trx` param as `any` to satisfy a loosely-typed helper — that erases `withOrganization`'s own `Transaction<Database>` generic path and its return type `T` collapses to `{}`. Instead cast the callback's *return value*: `(trx) => helper(trx) as Promise<{ id: string } | undefined>`.

## Response shape

- Success: `c.json({ ok: true, ...rest })`. Creates return `201`; `POST /sos-reports` returns `202` because it's fire-and-forget.
- Errors: `c.json({ error: 'short lowercase reason' }, status)`. Common: `400` bad payload/nonce, `401` unauth, `404` not found, `413` payload too large.
- No central error handler — `return` the response on every branch, including the happy path.
- Idempotent replay returns a success code with a status marker (e.g. `POST /api-keys/confirm` returns `200 { status: 'already-confirmed' }` instead of 400) when the caller is expected to retry. Do the same for any new confirm/ack-style endpoint.

## Validation

No zod. Cast `await c.req.json<PayloadType>()` and trust the shape — the API is only called by our own extension and web app. The one exception is `POST /sos-reports`, which has a hand-rolled `isValid(p): p is SosPayload` type guard because the payload is user-scrape-dependent and worth rejecting cleanly. Follow that pattern only when you need to gate on shape (usually not).

## Logging

`console.log` / `console.warn` with `[tag]` prefixes:

- `[api]` for general route stdout.
- Route-specific tags like `[sos]`, `[auth-clerk]` when the volume warrants its own filter.
- Log size deltas and counts, not per-request success lines — Hono's `logger()` already emits one line per request (skipped under `VITEST`).
- Auth failures log method, path, presence of `cookie`/`authorization`, and a truncated token prefix. Never log full tokens.

## File-storage routes (legacy, not the pattern for new work)

`capture.ts` and `sos-reports.ts` still write JSON/JSONL to `DATA_DIR = join(import.meta.dirname, '../../data')`. `scrape-configs.ts` reads a static JSON file at import. These are migrating to Postgres — don't add new `data/` writers. For any new persistence, go through Postgres via an org-scoping wrapper (`withOrganization`).

If you must touch an existing file-writer, filename inputs go through a slug helper (`[^A-Za-z0-9_-]` stripped, length-clamped) before `path.join` — never interpolate raw user input into a path.

## Large bytes and object storage

- **Two stores.** `ObjectStore` (`src/storage/types.ts`: `R2ObjectStore` / `LocalFsStore`) holds capture bodies
  the Worker itself writes. `MediaStore` (`src/storage/media-store.ts`, `S3MediaStore` on R2's S3 API via
  `aws4fetch`) holds anything a **browser** uploads. A Worker request body caps at 100 MB, so those bytes go
  browser ↔ R2 over presigned PUT/GET and never pass through a route. Validation then moves to a separate
  "complete" call that `head`s and sniffs what actually landed; never trust the declared type. Dev uses a real
  `donna-media-dev` bucket, since a presigned URL needs an S3 endpoint. Tests use `test/fake-media-store.ts`.
- **Never hold a DB transaction across a storage call.** Do the DB work in `withOrganization`, close it, then
  call R2. On delete, remove the row first and the object after commit, best-effort: an orphaned object is
  harmless, a row pointing at missing bytes is not.
- **A dependency that throws without env goes on the context as a lazy getter**
  (`middleware/with-media-store.ts`: `c.var.mediaStore()`), so sibling routes under the same mount keep working on
  a box without that env.
- Reference shape: the `/listings/:id/media/*` routes in `routes/listings.ts` (CORE-048-e01-RETRO).

## Integration testing

One integration test file per route, colocated: `routes/<name>.integration.test.ts`. Unit tests only for pure helpers extracted into `src/ingest/` or similar — routes themselves are tested end-to-end.

Boilerplate:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app } from '../index.js'
import { createTestDb, truncateAll } from '../test/db.js'

const db = createTestDb()
afterAll(async () => { await db.destroy() })

describe('POST /messages', () => {
  beforeEach(async () => { await truncateAll(db) })

  it('does the thing', async () => {
    const { userId, rawKey } = await seedUserWithKey()
    const res = await app.fetch(new Request('http://x/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ /* payload */ }),
    }))
    expect(res.status).toBe(200)
    // assert DB rows directly via `db`
  })
})
```

Seeding:

```ts
async function seedUserWithKey(clerkId = 'user_test') {
  const user = await db.insertInto('users')
    .values({ clerk_id: clerkId, email: `${clerkId}@donna.test`, display_name: null })
    .returning(['id']).executeTakeFirstOrThrow()
  const raw = `donna_sk_test_${randomBytes(16).toString('hex')}`
  await db.insertInto('api_keys').values({
    user_id: user.id,
    key_hash: await hashApiKey(raw),
    key_prefix: raw.slice(0, 16),
    install_id: 'inst-test',
    confirmed_at: new Date(),
  }).execute()
  return { userId: user.id, rawKey: raw }
}
```

Note `seedUserWithKey` above never sets `api_keys.organization_id` — it doesn't need to. Tenant
columns default to the session's `app.organization_id` (the test pool's sentinel org), so the
insert still resolves to a real org; see `db-schema-and-migrations`'s "Hard-won gotchas" for the
mechanism. Only bind a specific org explicitly (`asOrganization`, or read back
`.returning('organization_id')`) when the test cares which org it is.

**That sentinel default is exactly why a naive "belongs to another org" test is a false negative.**
Two "different" seeded users (different `clerk_id`, different `seedUserWithKey()` calls) still land
in the SAME sentinel org if neither insert sets `organization_id` explicitly — there is only one
default, connection-wide. A cross-tenant 404 test needs a REAL second `organizations` row and an
explicit `organization_id` override threaded through every fixture on the "other" side, or the
isolation the test claims to verify never actually happens (RLS has nothing to separate) and the
assertion passes for the wrong reason until someone finally runs it and sees `201` where `404` was
expected (DRV-006-e01-RETRO).

**Not every tenant table has that column default.** `suggestions.organization_id` is a bare `NOT
NULL` with no `DEFAULT NULLIF(current_setting(...))` — confirmed via `\d suggestions` — unlike
`listings`/`tracked_scopes`/`api_keys`/most tables added since migration 027. A bare insert into
`suggestions` 500s with a NOT NULL violation regardless of the session default. Check `\d <table>`
before assuming a bare insert resolves tenancy; if it doesn't, read back the resolved org off an
earlier insert (e.g. `api_keys.organization_id`) and pass it explicitly.

Before running API tests: `cd packages/db && pnpm db:test:reset`. `truncateAll` issues one `TRUNCATE ... RESTART IDENTITY CASCADE` across every app table — when you add a new table, add it to the truncate list in `src/test/db.ts`, otherwise leaked rows from prior tests will poison yours.

`beforeEach` is scoped to its enclosing `describe`, not the file. Appending a second top-level `describe('...')` to a file that already has one with `beforeEach(() => truncateAll(db))` does **not** inherit that reset — give the new block its own `beforeEach`, or its first seed (e.g. an `entity_schemas` row with a fixed name) will 23505 against rows a still-committed earlier test left behind (AI-018-e01-RETRO).

Run: `cd packages/api && pnpm test`. The `app` is imported in-process; there is no HTTP server during tests.

**A full-suite run can still fail 1-2 unrelated integration tests** — 100+ integration files share one
Postgres instance, so occasional resource contention is not a regression. If a test fails only in the
full run but passes standalone (`pnpm test <file>`), rerun once before concluding your change broke it.

**But not every full-suite-only failure is contention.** An error that clears on rerun is contention;
an assertion failure that reproduces every time, standalone included, is a real (possibly pre-existing)
bug. To tell "my change broke this" from "this was already broken," revert your diff against the clean
tree — `git stash`, or `git checkout <pre-change-commit> -- <the files you touched>` when the work is
already committed — and rerun the failing test. If it fails identically it predates you, and belongs in
a follow-up rather than blocking the commit. ([[CORE-025-e01-RETRO]])

## Verifying a change against the local dev server

`pnpm -C packages/api dev` runs `scripts/dev-clean.mjs` before `tsx watch`: it kills stale api
watchers and takes port 3100, so **the last `pnpm dev` always wins and always serves current code**.
Expect `[dev] stopping N stale api watcher(s)` on startup; that line is normal, not a warning. A
foreign process on the port is reported and left alone — free it yourself or set `PORT`.

This exists because `tsx watch` does not exit when its child dies. Before the guard, a second
`pnpm dev` lost the port, its child exited on `EADDRINUSE`, and **the watcher stayed alive forever**,
respawning a doomed child on every file save; 12 had accumulated over 12 days. The resulting failure
was silent and badly misleading — the *first* server keeps serving, so the port answers and most
behaviour looks correct, but the code you just edited never runs. That reads as a logic bug and costs
real debugging time ([[EXT-004-e02-RETRO]]). Two things now prevent it: the sweep above, and
`src/index.ts` logging `[api] listening` from the bind callback rather than before it, with an
explicit `EADDRINUSE` handler that exits 1 instead of leaving an unhandled error.

If you ever see stale behaviour anyway — a server started some other way, or a watcher that escaped
the sweep — compare the port holder's start time to the file's mtime before re-reading your diff:

```bash
lsof -nP -iTCP:3100 -sTCP:LISTEN -t | xargs ps -o pid=,lstart=,command=
stat -f "%Sm %N" packages/api/src/routes/<the file you edited>.ts
```

If the process predates the edit, restart — the code is fine. (The extension-side twin of this trap is
in `docs/packages/chrome-ext.mdx`: an unpacked MV3 extension likewise keeps serving the old bundle
until reloaded at `chrome://extensions`, and has no equivalent auto-fix.)

**If the port holder's start time is recent but you didn't start it, don't assume it's yours to
restart.** In a shared (non-worktree) checkout, another session can be actively working in the same
directory — signs include a dev-server process whose start time falls inside your own session, or
new untracked files appearing that you didn't create. Restarting `:3100` would serve your code but
could kill a server the other session depends on. Verify your own change without touching it instead:
`PORT=3101 npx tsx --env-file-if-exists=.env.local --env-file-if-exists=.env src/index.ts` runs an
isolated second instance against the same `donna_dev`. Scope every fixture row you seed to explicit
UUIDs you generate (not an existing user/org you found by browsing the table) so the smoke test is
fully reversible — delete them and kill the isolated process when done (CORE-031-e01-RETRO).

## Concurrency patterns

- Upserts over `SELECT`-then-`INSERT`: use `.onConflict((oc) => oc.columns([...]).doUpdateSet({...}))` or `.doNothing()`. Matches `excluded.<col>` via `sql\`excluded.col\`` when the new value depends on the incoming row.
- When a unique index is partial (e.g. `contacts_uniq_platform WHERE kind='platform'`), the `onConflict` clause must include `.where('kind', '=', 'platform')` so Postgres can pick the right index.
- `sql.ref(alias)` emits a quoted identifier. If the surrounding raw SQL declares an unquoted alias,
  pass its exact folded spelling (prefer lowercase throughout); `FROM listings L` plus
  `sql.ref('L.id')` becomes `FROM listings L ... "L"."id"` and fails with `42P01` because Postgres
  folded the declaration to `l` (CORE-037-e04-RETRO).
- For hot counters (`message_count + N`, `last_message_at = greatest(...)`) use a raw-SQL update, not read-modify-write, to stay race-safe.
- Fire-and-forget updates that don't block the response: `.execute().catch(() => {})`. Use only for observability columns like `last_used_at` where a lost write is acceptable.
- **Kysely 0.27's `JoinBuilder` has no `orOn`.** Only `on`, `onRef`, and `onTrue` exist (check
  `join-builder.d.ts` in `node_modules/.pnpm/kysely@0.27.6` if unsure) — code written as
  `.innerJoin('t as x', (j) => j.onRef('a.id', '=', 'x.id').orOn('a.canonical_id', '=', 'x.id'))`
  does not compile. An OR-across-a-merged-alias condition (the `contacts.canonical_contact_id`
  pattern CORE-026's identity graph uses everywhere) needs either `.on((eb) => eb.or([...]))` inside
  the join, or — often simpler and already tested — resolving the join in JS with a small helper
  query first. `packages/api/src/inquiries/lead-conversations.ts`'s `leadIdForConversation` already
  does exactly this for conversation→lead (merge-aware, RLS-scoped); check for an existing resolver
  like it before hand-rolling a fresh multi-table identity-graph join (CORE-031-e01-RETRO).

## Things to avoid

- Importing `db` directly in a route handler instead of going through an org-scoping wrapper (`withOrganization`).
- Adding new file-based persistence under `data/`.
- Re-declaring middleware-set context vars on the `Hono<{ Variables: ... }>` of a route when they're already set upstream (causes TS narrowing to lie).
- Wrapping the whole handler in try/catch and returning `500 { error: 'internal' }`. Let Hono propagate — the error middleware and logs are more useful than a flattened 500.
- Logging request success lines on top of Hono's `logger()` — double noise.
- Writing unit tests that mock the Hono context. If a route needs testing, it's an integration test against the real DB.
- Normalizing a stored string value (an error code, a status, any freeform column a route currently writes verbatim) without first `git grep`-ing the OLD spelling across **every** package, not just the one being touched. `packages/api`'s door-normalization of `device_tasks.error_code`/`outbound_intents.error_code` onto a closed vocabulary (`work/error-codes.ts`) nearly collapsed a literal string `packages/web/src/components/share-to-groups.tsx` already branched on into a generic fallback code — a search scoped to `packages/api` alone would have missed that cross-package dependency entirely (CORE-040-e01-RETRO).

## Listing fixtures (CORE-051)

Tests never `insertInto('listings')` directly: use `seedListing(exec, values)` (`packages/api/src/test/seed.ts`; creates the listing's asset, `status: 'off_market'` → off_market asset) and, in db migration tests, `insertListing(q, cols)` (`packages/db/src/test-listing.ts`). Neither calls `listingService` (its side effects would leak). To assert availability, read `assets.status`, not `listings.status`.

## CSV response checks

For downloads, assert a UTF-8 BOM on `response.arrayBuffer()` (`EF BB BF`), not `response.text()`: Fetch's UTF-8 decoder strips the BOM. Use `new TextDecoder('utf-8', { ignoreBOM: true })` when the test also needs the leading U+FEFF in its decoded string. Expose `Content-Disposition` in credentialed CORS when the web client reads a filename from that header. Evidence: CORE-052-e01-RETRO.

## Joined preview/export reads (CORE-052-e02)

When a joined preview and CSV need filters/order absent from the generated GraphQL schema, share
one Hono request parser and Kysely selection instead of adding an extendSchema plugin or filtering
an entire population in the browser. Preview count must count the exported rows (ads, not parent
prospects); export omits pagination, and option lists still run under the same tenancy wrapper.
Use deterministic order with explicit NULLS LAST and a unique tie-breaker. Postgres NUMERIC comes
back as a string from pg even when a sql<number> annotation says otherwise: convert at the DTO
boundary and assert actual JSON value types in route tests. Evidence: CORE-052-e02-RETRO.
