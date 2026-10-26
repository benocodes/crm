---
name: db-schema-and-migrations
description: Preferences and patterns for database work in packages/db — Kysely migrations, Neon Postgres, UUID v7, RLS in the same migration as the table, generated types, and how to test migrations without destroying data. Use when creating or modifying tables, writing migrations, writing tests that touch the schema, or working with the DB layer.
---

# Database Schema & Migrations

Reference for database work in `packages/db`. Much of it is inherited from the predecessor product, where each rule below
cost a real incident; the vault starts from **one squashed baseline migration** and applies the same
discipline from there.

## Stack

- **Neon Postgres.** Dev, test and prod are separate databases (prod is its own Neon project, not shared
  with any other product).
- **Kysely**: a query builder, not an ORM. Kysely's built-in `Migrator` with `FileMigrationProvider`; no
  `kysely-ctl`, no third-party migration tool.
- **Drivers.** The Worker uses `pg` through Hyperdrive (see `hyperdrive-pg-rls`). Node tooling (migrations,
  scripts, codegen) uses `pg` today against local Postgres ([[CORE1]]). The predecessor needed
  `@neondatabase/serverless`'s `Pool` for Node tooling against Neon, because the native `pg` driver showed
  `read ETIMEDOUT` from Node 22 (dual-stack DNS timing); verify that before pointing tooling at Neon.
- **Raw bodies stay out of Postgres.** Email bodies, attachments and captured payloads go to R2 behind the
  `ObjectStore` interface; Postgres holds metadata and a pointer.

## Primary keys: UUID v7

All tables use **UUID v7** via the `pg_uuidv7` extension:

```ts
.addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuid_generate_v7()`))
```

**Never `gen_random_uuid()`** (v4). v7 is time-ordered: better index locality, and "everything since event
X" cursors over a feed are a plain `id > $cursor`. Caveat: ids minted in the **same millisecond** are not
monotonic (the random bits decide the order). Any test or query that relies on "latest row by id" across
rows inserted in one transaction is flaky; pin explicit ids in fixtures or separate the writes in time.
To assert the order a transaction *emitted* rows in (events), order by `ctid` on a table that is only
ever inserted into and was truncated before the test: one backend appending to a fresh heap gives ctid in
insert order (`packages/api/src/identity/merge.integration.test.ts`, [[CORE2]]). That is a test device,
not a product ordering: no reader can recover intra-transaction order from same-millisecond ids. It holds
**only on a fresh heap**: on a long-lived database (`vault_dev`) inserts reuse freed space, so smoke and
e2e checks there compare the set and count of event types, never ctid order ([[CORE27]] review). [[API6]]
D13 moves `events.id` to PG18's native `uuidv7()` (monotonic within a backend); after it lands, order by
`id` in tests and smokes alike.

## Writing migrations

Files live in `packages/db/migrations/`, TypeScript, date- and number-prefixed (`20261020_001_baseline.ts`).
Each exports `up()` and `down()`. Migrations are **forward-only in practice**: `down()` exists for
completeness but is never run against anything you care about (see "Testing" below).

```ts
import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('example')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuid_generate_v7()`))
    .addColumn('organization_id', 'uuid', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  // RLS in the SAME migration that creates the table. See Conventions.
}
```

**A plan's hardcoded migration number can go stale before you write the file.** Another cycle may land a
same-day migration and claim it first. Right before creating a migration, list `packages/db/migrations/`
and confirm the number is the next free one.

**A free number does not mean `db:migrate` will run.** If a shared dev database has recorded a migration
from a different, unmerged branch whose file was never committed, Kysely refuses to apply *anything*:
`corrupted migrations: previously executed migration <name> is missing`. The error names the *missing*
file, not yours, so grep it for that filename before assuming your number is the problem. Fix by picking a
number free of both the repo listing and the error, or by restoring or removing the other branch's file;
never by editing the `kysely_migration` table by hand. `db:test:reset` rebuilds the test database from
scratch and is immune; use it for automated verification and treat only the live-dev smoke as blocked.

Commands:

```bash
pnpm db:migrate        # apply pending to the dev database
pnpm db:test:reset     # rebuild the test database (refuses names without "test")
pnpm db:test:worktree  # private per-worktree test database; `--drop` removes it
pnpm db:codegen        # regenerate src/types.generated.ts
```

Staging and prod (Neon) migrations go through the deploy flow (`ship-branch`) or the Neon tooling; never
point a local migrate run at a shared database casually. A **per-worktree test database** is the default:
a shared test database plus a concurrent reset produces fake deadlocks and "column does not exist".

## Types

Types are **generated** from the live schema: after migrating, `pnpm db:codegen` regenerates
`src/types.generated.ts`. **Never edit the generated file.** Narrowing (string-literal unions for
status-like columns, JSONB shapes) goes in `src/types.ts`, which re-exports the refined `Database` type.

- **Narrowing a column that has a DB default needs `Generated<>` inside the override**, or every insert
  that relied on the default stops compiling. Codegen types a defaulted column `Generated<string>`; a bare
  `Override<Gen, { col: Narrow }>` makes it required. Use `Override<Gen, { col: Generated<Narrow> }>`. Check
  `\d <table>` for a `column_default` first.
- **Narrowing can break functions that return the row type without an annotation** (`TS2742: inferred type
  cannot be named`). Add the explicit return type (`Promise<Selectable<Table> | null>`). Run
  `pnpm -r typecheck` right after adding an override.
- **A new Postgres column type can introduce an undeclared codegen dependency.** `kysely-codegen` maps some
  types to an npm package (`interval` → `postgres-interval`) and emits an import for it. If it's only
  transitively installed, typecheck fails on the generated file with `Cannot find module`. Add it as a real
  dependency.
- **A column type that `pg` decodes into a class instance is a production hazard, not a typing problem.**
  `interval` becomes a `PostgresInterval` object, and a Cloudflare Workflow cannot serialize a class
  instance across a `step.do` checkpoint, so any step that `selectAll()`s the table throws `DataCloneError`
  the moment a row has a value. This took down the predecessor's whole extraction pipeline for ~10 hours with green
  tests, because Node's `structuredClone` is more lenient than workerd. Register a type parser in
  `packages/db/src/pg-types.ts` that keeps such types as text, mirror the shape in `types.ts`, and read
  `cloudflare-workflows`. `bigint` is *not* a hazard: pg decodes it as a plain string.

## Conventions

- **Tenancy.** Every tenant table gets `organization_id` (the RLS gate) **and** `user_id` or an actor
  reference (attribution), with RLS policies **enabled and forced**, in the same migration. The boundary is
  the organisation, not the user. A consultant is a principal with memberships in many organisations.
- **Timestamps.** `created_at timestamptz NOT NULL DEFAULT now()` everywhere; `updated_at` with the shared
  `set_updated_at()` trigger on mutable tables.
- **CITEXT** for email addresses (`CREATE EXTENSION IF NOT EXISTS "citext"`).
- **A lifetime is a fixed duration, written in hours.** `now() + interval '14 days'` adds calendar days in
  the session's `TimeZone`, so across a DST change the result is 13 days 23 hours or 14 days 1 hour. Write
  an expiry as `interval '336 hours'` (absolute), and compute it in SQL so it equals `created_at + lifetime`
  exactly ([[CORE27]] review).
- **JSONB defaults** are `DEFAULT '{}'::jsonb`, not `DEFAULT '{}'`.
- **A bare scalar into a jsonb column needs `JSON.stringify`.** `pg` auto-serializes plain objects and
  arrays but not bare numbers, strings or booleans; those go over the wire as raw text and Postgres's
  text→jsonb cast accepts only values that happen to be valid JSON. Event payload `before`/`after` values
  that can be scalars must be stringified explicitly.
- **Intra-tenant references are composite foreign keys.** Postgres checks a foreign key without RLS, so
  a plain `company_id → companies(id)` accepts another organisation's id. Give the target
  `UNIQUE (organization_id, id)` and reference `(organization_id, <col>) → <target>(organization_id, id)`
  (`packages/db/migrations/20261018_003_identity_model.ts`, [[CORE2]]). A self-reference
  (`contacts.merged_into_id`) is added with `ALTER TABLE` after the unique constraint exists.
- **A new foreign key to `contacts(id)` must join merge's re-point list** (`CONTACT_REFERENCES` in
  `packages/api/src/identity/merge.ts`) or its exemptions; `merge-catalog.integration.test.ts` fails
  otherwise ([[CORE2]] D11).
- **Index names** `idx_{table}_{columns}`; unique `idx_{table}_{purpose}_unique` or inline `.unique()`.
- **Conflicts: `ON CONFLICT`, not catch-and-retry.** A caught `23505` inside a transaction does not save it;
  the transaction is already aborted. When the unique index is partial, the `onConflict` clause must repeat
  the predicate (`.where('kind', '=', 'email')`).
- **A column ordered by `fractional-indexing` keys must be `COLLATE "C"`.** Those keys assume bytewise
  ordering (`'Zz' < 'a0'`); the default locale collation sorts them wrongly and *deterministically*, which
  looks like the same-millisecond UUID flake and invites the wrong diagnosis.
- **Retiring what produces a `CHECK (col IN (...))` value does not mean removing it from the CHECK.**
  Narrowing a CHECK validates every existing row. Stop producing the value in code; remove it from the CHECK
  only once no live row carries it, in a separate migration.
- **A migration's backfill must be self-contained and exported** so its test can call it: `db:test:reset`
  migrates an empty database, so an in-migration backfill touches nothing and ships untested. Snapshot any
  constants it needs inside the migration (never import from `src/`; a later move would break every replay),
  and test it against fixture rows inside a rolled-back transaction.
- **Re-scoping a unique index silently breaks every `onConflict` target that named the old columns.**
  Nothing fails at typecheck; Postgres says `there is no unique or exclusion constraint matching the ON
  CONFLICT specification` the first time the conflict path fires. After adding, dropping or re-scoping a
  unique index, grep tests and code for `.onConflict` / `ON CONFLICT` on the old column set.
- **Tenant-column defaults hide missing tenancy.** If a table's `organization_id` has a session-scoped
  `DEFAULT`, a test insert that omits it silently picks up the session's organisation. The vault's test pool
  presets nothing (see `api-routes`), so every fixture insert names its organisation explicitly.

## Roles, grants and policies

Established by the baseline ([[CORE1]], `packages/db/migrations/20261017_001_baseline.ts`).

- **Roles are namespaced and cluster-wide:** `vault_authenticated` (NOLOGIN, RLS applies),
  `vault_service` (NOLOGIN, BYPASSRLS), `vault_app` (LOGIN NOINHERIT, member of both, no privileges of its
  own). They are created idempotently in a `DO` block that also `ALTER`s all three, so attributes converge
  on a cluster where they already exist. The migration grants both group roles to `CURRENT_USER` too.
  Every vault database on a cluster (dev, test, each worktree) shares them, so **`down()` never drops
  roles**. Never touch other products' roles (`anon`, `authenticated`, `service_role`) on a shared cluster.
- **Grants are minimal, per table, in the migration that creates the table.** `vault_service` gets
  `SELECT, INSERT, UPDATE` (narrowed from `ALL` by `20261017_002_service_role_grants.ts`, [[CORE12]]): no
  `DELETE`/`TRUNCATE` (soft delete; a spec that truly hard-deletes machinery rows grants `DELETE` on those
  tables only), `events` exactly `SELECT, INSERT`, and nothing on `kysely_migration*`.
  `vault_authenticated` gets only what tenants need (no `DELETE`/`TRUNCATE` anywhere, `events` exactly
  `SELECT, INSERT`); `vault_app` gets nothing directly.
- **Tenant grants are column-level where a table mixes tenant-writable and machinery columns**
  (`packages/db/migrations/20261020_005_directory.ts`, [[CORE27]] P3, [[CORE29]]): `memberships`
  has no tenant `INSERT` or `UPDATE` (the directory sync writes under the service role); `agents` `UPDATE (name, scopes, disabled_at)`; `api_keys` `SELECT` on every column except
  `key_hash`, plus `UPDATE (revoked_at)`. Start narrow: widening later is a one-line grant, narrowing
  breaks callers. `SELECT … FOR UPDATE` needs `UPDATE` on at least one column of the table, so a
  column-level `UPDATE` grant also covers the row lock. A column left out of the `SELECT` grant must also
  be left out of the definition's `record` (`api-routes`: generic reads name their columns). A new table needs its own
  `GRANT`s **to both group roles**: there are no default privileges, and a table without a `vault_service`
  `SELECT` fails the invariants suite. `schema-invariants.integration.test.ts` enforces these rules
  across every table.
- **`REVOKE ALL ON ALL TABLES` also hits Kysely's tables.** The Migrator creates `kysely_migration*` before
  running `up()`, so a schema-wide `GRANT`/`REVOKE` in a migration covers them; name tables explicitly.
- **RLS is enabled and forced on every table** (identity tables too), with policies `TO vault_authenticated`
  named `<table>_tenant`. Policies call **`app.current_organization_id()`**, never `current_setting(...)`
  directly; the invariants test checks every policy expression.
- **An `INSERT` policy on a table whose `SELECT` policy cannot see the new row yet means no `RETURNING`.**
  `RETURNING` applies the `SELECT` policies to the inserted row and fails the insert if they reject it.
  A tenant creating an agent inserts its `principals` row under `principals_insert_agent`
  (`WITH CHECK (kind = 'agent' AND app.current_organization_id() IS NOT NULL)`), but `principals_tenant`
  admits a principal only once its `agents` row exists. So mint the id first
  (`SELECT uuid_generate_v7()`), insert the principal without `RETURNING`, then the child row with that id
  (`packages/api/src/resources/agents.ts`, [[CORE27]] P4).

## Environment

| Variable | Connects as | Used by | Default |
|---|---|---|---|
| `MIGRATION_DATABASE_URL` | database owner | `db:migrate`, `db:codegen` | `postgresql://localhost/vault_dev` |
| `DATABASE_URL` | `vault_app` | the app ([[CORE12]]) | none |
| `TEST_DATABASE_URL` | database owner | reset script, migration/invariant tests, `createOwnerTestDb` | `postgresql://localhost/vault_test` |
| `TEST_APP_DATABASE_URL` | `vault_app` | `createTestDb` | `TEST_DATABASE_URL` with user `vault_app` |

`pnpm db:test:worktree` writes both test URLs to `packages/db/.env.test.local`, which `src/test-setup.ts`
loads (a value already set in the shell wins). Codegen must run as the owner: `vault_app` can't read the
schema. Every helper that truncates or drops calls `assertTestDatabaseName` first.

## Testing migrations, and why you never round-trip `down()`

General test-writing rules (red first, no leaked state, flakes) are in `writing-tests`; this section is the migration-specific part.

Every consequential migration gets a paired integration test, `packages/db/src/migration-NNN.integration.test.ts`,
using a raw `pg.Pool` against `TEST_DATABASE_URL` (not the API test harness). It **asserts the resulting
schema** by inspecting `information_schema` and `pg_catalog` on the already-migrated test database
(`db:test:reset` migrates to latest and refuses any name without "test").

A migration test must **never**:

- call `migrator.migrateTo(...)` or `migrateDown()`, or
- point its connection at the dev database or any real or shared one.

**Down-migration chains are destructive by design.** Kysely's `migrateTo(target)` runs *every* `down()` from
latest back to the target, so "testing one migration's down" drags the whole chain through the destructive
ones; a single round-trip of a tenancy backfill once collapsed all real dev data into per-user orgs. If
reversibility is genuinely the thing under test, create a uniquely named ephemeral scratch database inside
the test (`vault_test_mig_<rand>`), round-trip there, and drop it in `afterAll`. Default to schema-assertion
tests.

- **See the migration test fail before writing the migration.** Run it alone on the test DB, at the old
  schema, and check that it fails on the missing column or table. Then write the migration, run codegen
  and update the seeds. If the migration and the generated types come first, nothing proves the test
  asserts the change rather than the baseline ([[CORE3]] cycle 1; `tdd-cycle-generator` rule 11).
- **A migration test lives until its migration is applied in prod, then it is deleted.** It asserts against
  the *latest* schema, so afterwards it can only fail for a later migration's legitimate change, and "fixing"
  it makes migration N's test describe migration M's change. A later migration that breaks an earlier test
  deletes the broken assertion in the same change; it never rewrites it to the new shape.
- **Invariants that must hold forever** go in `packages/db/src/schema-invariants.integration.test.ts`,
  written against the current schema across *every* matching table (today's intent: every table with
  `organization_id` also has an actor column, RLS enabled and forced, and at least one policy).
- **Never assert a literal for a value the migration copies from a live source**; assert against the source.
- **Clean up in `afterEach`, not on the success path**, and delete only the exact rows *this* test seeded,
  addressed by their own ids; never a "nothing references it" query against shared reference data. A single
  failure otherwise leaves rows behind and the next run fails on an unrelated unique violation.
- **Run the `db` and `api` suites serially** against one database; two at once is the same concurrency
  hazard as two sessions. Inside a package, Vitest 4+ has no `poolOptions.forks.singleFork`: use
  `pool: 'forks'` with `fileParallelism: false`.
- **`now()` is the transaction's start time.** An `updated_at > created_at` check inside one rolled-back
  transaction can never pass, however long it sleeps. Use separate committed statements and clean up in
  `finally`, or compare against `clock_timestamp()`.
- Constraint checks (`23514`, `23505`) run inside a transaction on the owner pool that the test rolls back,
  and assert the SQLSTATE.
- Kysely 0.29 exports `Migrator` and `FileMigrationProvider` from `kysely/migration`, not the root.

## D1 migrations ([[CORE35]])

`packages/db` is the Postgres package. D1's schema lives in the open `@vault/storage-d1`, as
`packages/storage-d1/migrations/NNNN_<name>.sql`: forward-only and wrangler-compatible. Each cycle that
migrates a resource appends a file. Local tests apply the files to disposable Miniflare bindings
(`@vault/storage-d1/test`); never point tooling at a remote database id.

- **Tenancy is the database** (spec D18). A singleton `deployment` row fixes the organisation id,
  `organizations.id` references it, and every tenant table's `organization_id` references
  `organizations`. A second organisation cannot be stored; `isolation.integration.test.ts` proves it.
  D1 always enforces foreign keys, and `pragma foreign_keys = off` has no effect.
- **Value conventions:**
  - `STRICT` tables;
  - canonical lowercase UUID text;
  - timestamps as ISO-8601 UTC with milliseconds, checked with
    `coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', c) = c, 0)`;
  - booleans as checked 0/1;
  - JSON as `json_valid` text;
  - emails lowercase ASCII.
- **Measured D1 limits:**
  - LIKE/GLOB patterns are capped at **50 bytes**, so a long `GLOB` check fails at insert time;
  - a statement binds at most **100 parameters**;
  - a statement is at most 100 KB.
- **The D1 migration test is red before the migration exists.** `packages/storage-d1/src/schema.integration.test.ts`
  inspects `sqlite_master`/PRAGMA. `schema-parity.integration.test.ts` on each engine ties the
  physical columns to `COLUMN_KINDS` in `@vault/storage`, so a new column changes all three together.
- **Postgres `set_updated_at` overrides any `updated_at` the application writes.** The prepared path
  writes it, but on Postgres the stored value is the transaction's `now()` ([[CORE35]]; whether the app
  should own it is a [[CORE36]] decision).

## Neon notes

- Extensions available: `pgcrypto`, `citext`, `pg_uuidv7`.
- Compute may be suspended (cold start); the serverless driver wakes it gracefully.
