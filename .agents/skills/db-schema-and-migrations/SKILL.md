---
name: db-schema-and-migrations
description: Preferences and patterns for database work in packages/db — Kysely migrations, Neon Postgres, UUID v7, @neondatabase/serverless driver. Use when creating or modifying tables, writing migrations, or working with the DB layer.
---

# Database Schema & Migrations

Reference for database work in `packages/db`.

## Stack

- **Neon Postgres** (managed) — connection string in `.env.production`
- **`@neondatabase/serverless`** driver — NOT `pg`. The native `pg` driver has `read ETIMEDOUT` issues connecting to Neon from Node.js 22 (happy eyeballs / dual-stack DNS timing). Use `@neondatabase/serverless`'s `Pool` as a drop-in replacement with Kysely's `PostgresDialect`.
- **Kysely** query builder (not an ORM) — full TypeScript inference, no magic
- **Kysely built-in `Migrator`** with `FileMigrationProvider` — no `kysely-ctl`, no third-party migration tools

## Primary Keys: UUID v7

All tables use **UUID v7** via the `pg_uuidv7` Postgres extension:

```sql
CREATE EXTENSION IF NOT EXISTS "pg_uuidv7";
```

```typescript
.addColumn('id', 'uuid', (col) =>
  col.primaryKey().defaultTo(sql`uuid_generate_v7()`)
)
```

**Never use `gen_random_uuid()`** (UUID v4). UUID v7 is time-ordered, giving better index locality and natural chronological sorting by PK.

## Writing Migrations

Migration files live in `packages/db/migrations/`, TypeScript, timestamp-prefixed:

```
migrations/
  20260416_001_initial_schema.ts
  20260417_001_add_foo_column.ts
```

Each file exports `up()` and `down()`:

```typescript
import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('example')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`uuid_generate_v7()`)
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade')
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('example').ifExists().execute()
}
```

**A spec/plan's hardcoded migration number can go stale before you write the file.** A plan authored
today naming migration `055` is only correct if `055` is still free when you actually implement it —
another epic can land a same-day migration and claim it first (AI-008-e01 was planned for
`055`/`056`; `055` was taken by an unrelated fix, `20260719_055_messages_fidx_c_collation.ts`, that
merged first, so the epic shipped as `056`/`057` instead). Run `pnpm -C packages/db db:test:reset` (or
`ls packages/db/migrations/`) right before creating a new migration file to confirm the number you're
about to use is actually the next free one — don't trust a pre-written number blindly.

**A migration number being free in `git ls migrations/` does not mean `db:migrate:dev` will run at
all.** `donna_dev` is a single shared database across every branch/worktree on the machine — if a
different, unmerged branch ran `db:migrate:dev` there and its migration file was never committed,
Kysely's migrator refuses to apply ANYTHING, categorically: `corrupted migrations: previously
executed migration <name> is missing`. This is not the same failure as a number collision — it names
the *missing* file (from the other branch), not your new one, so grep the error for that filename
before assuming your number is the problem (CORE-037-e03-RETRO hit this with a phantom
`084_deals_origin` from an unmerged `worktree-feat+inquiry-genesis-deal` branch). Fix by picking a
number free of both the repo listing and this error, or by restoring/removing the other branch's
migration file — never by editing `donna_dev`'s `kysely_migration` table directly. `db:test:reset`
rebuilds `donna_test` from scratch every time and is immune to this; use it for all automated
verification when `donna_dev` is stuck this way, and treat only the live-`donna_dev` smoke test as
blocked.

**Run migrations:**

```bash
pnpm -C packages/db db:migrate:dev    # apply all pending to donna_dev
pnpm -C packages/db db:test:reset     # rebuild the test DB (refuses non-"test" DB names)
```

Staging/prod (Neon) migrations go through the deploy flow / Neon MCP tools — never point a local migrate run at a shared database casually.

## Type Definitions

Types are **generated** from the live schema: after migrating, run `pnpm -C packages/db db:codegen:dev` to regenerate `src/types.generated.ts`. **Never edit the generated file.** Narrowing (string-literal unions for status/enum-ish columns, JSONB shapes) goes in `src/types.ts`, which re-exports the refined `Database` type.

**A new-to-the-schema Postgres column type can introduce an undeclared codegen dependency.**
`kysely-codegen` maps certain Postgres types to a specific npm package and emits an import for it
into the generated file — e.g. `interval` → `import type { IPostgresInterval } from
"postgres-interval"`. If nothing in the schema used that Postgres type before, the package may only
be present transitively (via `kysely-codegen`'s or `pg`'s own deps), and `pnpm -C packages/db
compile` fails on the generated file with a plain `Cannot find module '<pkg>'` — not a type-shape
error, so it doesn't belong in `types.ts`. Fix with a normal `pnpm --filter @donna/db add <pkg>`.
(Evidence: `packages/db/migrations/20260721_065_inquiry_expiry.ts` — first `interval` column in the
schema — CORE-029-e01-RETRO.md.)

**That same mapping has a far worse runtime consequence: a column type pg decodes into a class
instance can silently kill the extraction pipeline.** node-postgres turns `interval` into a
`PostgresInterval` object, and Cloudflare Workflows cannot serialize a class instance across a
`step.do` checkpoint — so any code path that `selectAll()`s the table into a workflow step starts
throwing `DataCloneError` the moment a row has a non-null value. Migration 065 took down every
extraction run in production for ~10 hours this way, with green tests throughout (workerd is stricter
than Node's `structuredClone`, so nothing local reproduces it).

Guard rails, in order:
1. `packages/db/src/pg-types.ts` registers type parsers that keep such types as plain text —
   `interval` is handled there. **Add to it whenever you introduce a column type pg decodes into an
   object**, and mirror the shape in `src/types.ts` (codegen introspects the column, not the parser,
   so the generated select type will be wrong).
2. Check who reads the table. `grep` for `selectFrom('<table>').selectAll()` and ask whether any hit
   sits inside a `step.do`.

Read `cloudflare-workflows` before adding an exotic column type to a table the agent-runs pipeline
touches (`entity_schemas`, `agent_runs`, `threads`, `messages`, `captures`).

**Not every non-default Postgres type is a hazard — the hazard is specifically decoding into a class
instance, not merely "not a plain scalar."** `bigint`/`int8` is the clean counter-example: it codegens
to `Int8 = ColumnType<string, bigint | number | string, bigint | number | string>` — node-postgres
decodes it as a plain **string** (to avoid precision loss), never an object — so a `bigint` column is
already `step.do`-serializable with zero guard-rail work, no `pg-types.ts` entry needed. Confirmed for
`telegram_links.chat_id` (CORE-036-e01). Before adding a defensive `pg-types.ts` parser for a new
column type, check what it actually codegens to in `types.generated.ts` first — only a type wrapping
something with a constructor (`PostgresInterval`, and anything similar) needs one.

## Conventions

- **Tenancy**: every tenant table gets **both** `organization_id` (the RLS gate) and `user_id` (actor attribution), with RLS policies, in the same migration. The tenancy boundary is the organization, not the user (migrations 026–028, spec CORE-014).
- **Timestamps**: `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` on every table. Add `updated_at` with a trigger for mutable tables.
- **`updated_at` trigger**: use the shared `set_updated_at()` function (created in initial migration)
- **CITEXT**: use for email columns (`CREATE EXTENSION IF NOT EXISTS "citext"`)
- **JSONB defaults**: `DEFAULT '{}'::jsonb` not `DEFAULT '{}'`
- **Writing a bare scalar into a jsonb column via Kysely/`pg`**: node-postgres auto-`JSON.stringify`s plain JS objects/arrays passed as bind parameters, but NOT bare scalars (`number`/`string`/`boolean`/`null`) — those go over the wire as their raw text form, and Postgres's implicit text→jsonb cast only accepts values that already happen to be valid JSON (a number or `null` works by luck; an unquoted string like `Nice flat` does not and throws). Any jsonb column that stores ad-hoc scalars (an audit log's `previous_value`/`new_value`, an event payload) needs an explicit `JSON.stringify(v)` wrapper before the insert — don't rely on driver auto-serialization for anything but plain objects (CORE-027-e01-RETRO).
- **Index naming**: `idx_{table}_{columns}` (e.g., `idx_messages_conversation_hash`)
- **Unique constraint naming**: `idx_{table}_{purpose}_unique` or inline `.unique()` on column

## Testing migrations — and why you never round-trip `down()`

Every consequential migration gets a paired integration test (`migration-0NN.integration.test.ts`). The test **asserts the resulting schema** by inspecting `information_schema` / `pg_catalog` on the already-migrated test DB — the schema is set up once by `pnpm -C packages/db db:test:reset` (→ `migrateToLatest()` on `donna_test`, which refuses any DB whose name lacks "test").

**A migration test lives until its migration is applied in prod, then it is deleted.** It asserts against the *latest* schema, not a snapshot (see below), so once shipped it can only ever fail for a later migration's legitimate change — and "fixing" it to the new shape makes migration N's test describe migration M's change under the wrong name. Its backfill helpers ran once in prod and never run again; the `up()` chain itself is still exercised by every `db:test:reset` / `db:test:worktree`. Everything through 106 was deleted on 2026-10-06 for this reason. Two rules follow:

- **A later migration that breaks an earlier migration's test deletes the broken assertion** (or the file, if that migration is in prod) in the same change. Never rewrite it to the new shape — assert the new shape in the new migration's own test.
- **Invariants that must hold forever go in `packages/db/src/schema-invariants.integration.test.ts`**, written against the current schema across *every* matching table (today: every table with `organization_id` has `user_id`, RLS enabled + forced, and at least one policy). If a per-migration assertion is really a permanent invariant, generalise it there instead of keeping the migration test.

**This test lives in `packages/db/src/migration-0NN.integration.test.ts` — not in `packages/api`.** It uses a raw `pg.Pool` against `TEST_DATABASE_URL`, not the `@donna/api` kysely test harness (`createTestDb`) — there's no reason to pull in the whole API test setup just to assert a constraint/index exists. See `packages/db/src/schema-invariants.integration.test.ts` for the pool setup, and `git show 'de1e186:packages/db/src/migration-097.integration.test.ts'` for a full deleted example (schema assertions + an exported backfill helper + id-scoped `afterEach` cleanup). A plan drafted without re-opening that file will guess a `packages/api/src/db/...` path using kysely instead — check the actual prior file, don't trust a remembered path. (Evidence: `knowledge/specs/046-AI-014-mandate-extraction-from-transcripts/epics/01-transcript-structuring/AI-014-e01-RETRO.md`.)

A migration test must **never**:

- call `migrator.migrateTo(...)` / `migrateDown()` itself, or
- point its `pg` connection at `donna_dev` or any real/shared DB.

**Down-migration chains are destructive by design.** E.g. the org-tenancy chain: `027` `up()` backfills `organization_id = 'personal:' || clerk_id`, and its `down()` deletes organizations — a single full down→up round-trip silently rewrites tenancy and collapses all real data into per-user personal orgs (this actually happened; it nuked dev). Kysely's `migrateTo(target)` runs **every** `down()` from latest back to the target, so "testing one migration's down" drags the whole chain through the destructive ones.

If you genuinely must exercise a `down()` (reversibility is the thing under test), create a **uniquely-named ephemeral scratch database inside the test** (e.g. `donna_test_mig_<rand>`), run the round-trip there, and drop it in `afterAll`. Default to schema-assertion tests.

**Never assert a literal for a value the migration copies from a live source.** Some migrations are content refreshes, not schema changes — migration 042 writes the *current* master-schema body onto every clone matching `origin_master_slug`+`origin_master_version`. Its test asserted `rooms['x-match'] === 'floor'`, pinning a value that tracks `packages/db/src/master-schemas/`, so it broke the first time anyone changed the master (AI-019 moved `rooms` to `band`) even though the sync itself was fine. Assert against the source (`master.schema.properties.rooms['x-match']`) and leave the value's correctness to the test that owns it (`src/x-match.test.ts`). Evidence: `knowledge/specs/052-AI-019-banded-preference-seeding/epics/01-banded-seeding/AI-019-e01-RETRO.md`.

**Clean up in `afterEach`, not on the success path.** These tests insert real `users`/`organizations` rows against a shared `donna_test` and several delete them in the last lines of the `it`. A single failure skips those deletes, and the *next* run fails on `duplicate key value violates unique constraint "users_clerk_id_key"` in an unrelated assertion — you get two failures reported and only one is real. Same epic.

**Cleanup must delete only the exact rows THIS test seeded, addressed by their own ids — never a "nothing currently references it" query against shared/global reference data.** A migration-093 test's `afterEach` deleted the sentinel system user (`00000000-…-000000000000`, seeded unconditionally by migration 026) whenever no `pipeline_stages` row referenced it — true in isolation, since the test had just deleted its own seeded orgs' rows in the same `afterEach`. Run alongside the rest of the suite against the shared `donna_test`, this silently deleted durable infra mid-run and broke an unrelated `packages/api` test with an FK error (`pipeline_stages_user_id_fkey`) that read like a real regression in a file the epic never touched. Worse, this reproduced even *within one agent's own work* — running `packages/api test` in the background while `packages/db test` ran in the foreground, both against the same `donna_test`, is the identical concurrency hazard this skill already warns about for separate sessions. Run the two packages' suites serially. (CORE-042-e02-RETRO.md)

**A migration test asserts against the fully-migrated (latest) schema, not a point-in-time snapshot** — `db:test:reset` runs every migration in order and no test calls `migrateTo`, so migration N's test still runs after migration N+5 has changed things. A later migration that renames a table or column silently orphans the earlier migration's test: it keeps asserting a name that no longer exists, and fails with "table does not exist" / an empty `rows[0]` rather than anything that points at the rename. When writing a migration that renames or reshapes anything, `grep` every remaining `migration-0NN.integration.test.ts` (only not-yet-shipped ones should exist) for the old name and delete those assertions in the same change, per the lifetime rule above — don't wait for the suite to tell you (migration 082 renaming `listing_group_shares` → `listing_shares` broke `migration-081.integration.test.ts` this way, DRV-006-e01-RETRO.md; CORE-047-e03 changing the `telegram_deliveries` unique index broke 097's the same way, and was the trigger for the deletion rule).

## Hard-won gotchas

- **Narrowing a table's type via the `Override` pattern can break unrelated functions that return
  that table's row type without an explicit annotation** — `tsc` starts failing them with `TS2742:
  The inferred type of '<fn>' cannot be named without a reference to '.../types'`. This isn't a bug
  in the narrowing; it's TS declining to infer a return type through the now more-complex `Database`
  generic. Narrowing `agent_runs.kind` (`AgentRunKind`, AI-010-e01) broke `claimRun` (`claim.ts`) and
  `scanForRecovery` (`recover.ts`) this way — both previously relied on inference from
  `.returningAll()`/`.selectAll()`. Fix by adding the return type explicitly:
  `Promise<Selectable<AgentRuns> | null>` / `Promise<Selectable<AgentRuns>[]>` (`Selectable` from
  `kysely`). Expect this whenever narrowing a table that already has functions returning its full
  row shape — `pnpm -C packages/db compile && pnpm -C packages/api compile` right after adding an
  `Override` catches it immediately.
- **Narrowing a column that also carries a DB default needs `Generated<>` INSIDE the override, or
  every pre-existing insert that relies on the default breaks at compile time.** Codegen types a
  defaulted column `Generated<string>` (optional on insert, plain `string` on select). A bare
  `Override<GenTable, { col: NarrowType }>` replaces `Generated<string>` outright with a required
  `NarrowType`, so `tsc` fails every `insertInto(...)` call site that omits the column with
  `Property 'col' is missing in type '...' but required in type 'InsertObject<...>'` — immediately,
  not lazily on an unannotated helper like the `TS2742` case above. Narrowing `deals.origin`
  (`DealOrigin`, AI-008-e03) broke 8 files this way. Fix: narrow **inside** `Generated<>` —
  `Override<GenTable, { col: Generated<NarrowType> }>`, importing `Generated` from
  `types.generated.js`. Check whether the column has a DB default (`\d <table>` shows a
  `column_default`) before choosing which form to write.
- **`organization_id` (and other tenant-column) inserts that omit the value still get one — from
  a session-scoped `DEFAULT`.** Migration 027 gave every tenant table's `organization_id` column
  `DEFAULT NULLIF(current_setting('app.organization_id', true), '')::uuid` — so a test (or any
  code) that inserts a row without an explicit `organization_id` doesn't get `NULL`, it silently
  picks up whatever `app.organization_id` is bound in that connection/transaction. `packages/api`'s
  test pool (`src/test/db.ts` `createTestDb()`) sets `app.organization_id` to a sentinel default
  org on every new connection, and `truncateAll` reseeds that org row — which is why several
  existing tests (`seedUserKeyAndSchema`-style helpers) insert `api_keys`/`entity_schemas` rows
  with no `organization_id` at all and still resolve to a real, joinable org. This is convenient
  but easy to misread as "tenancy isn't enforced here" — it's enforced, you're just seeing the
  column default do its job. When a test needs a *specific* org (not the shared sentinel), bind
  `app.organization_id` yourself (`asOrganization`, or read back `.returning('organization_id')`
  from the insert) rather than assuming a bare insert produces `NULL`. (Evidence:
  `packages/db/migrations/20260519_027_organization_id_columns.ts`,
  `packages/api/src/routes/capture.document.outcome.integration.test.ts`, API-013-e01.)
  **Not every tenant table has that default** — `suggestions.organization_id` has none (and
  `suggestions.confidence` is NOT NULL), so a test seeding a suggestion with a bare `db.insertInto`
  fails `23502` before it reaches the behaviour under test. Read the org back from a parent row
  (`.returning(['id', 'organization_id'])`) and set both. Check `\d <table>` rather than assuming
  (`packages/api/src/routes/capture.device.integration.test.ts`, AI-010-e02.)
- **A migration that re-scopes a unique constraint/index breaks any test's `onConflict` target
  silently at runtime, not at typecheck.** `entity_schemas`' name+version uniqueness moved from
  `(user_id, name, version)` to `(organization_id, name, version)` (migration
  `20260713_051_entity_schemas_org_scoped_name_uniq.ts`) to fix a real cross-org collision — but a
  test seeding helper's `.onConflict((oc) => oc.columns(['user_id','name','version'])...)` still
  targeted the old column set. Kysely/`tsc` can't catch this (the columns are all real columns,
  just not backed by *that* index anymore) — it only surfaces as a Postgres runtime error, `there
  is no unique or exclusion constraint matching the ON CONFLICT specification`, the next time the
  conflict path actually fires. After writing any migration that adds/drops/re-scopes a unique
  constraint or index, `grep` the test suite for `.onConflict` (or raw `ON CONFLICT`) targeting
  the old column set and update it in the same change — don't rely on CI to catch it, since a test
  whose `onConflict` branch never actually collides in that run won't fail. (Evidence:
  `packages/api/src/agent-runs/listing-board.integration.test.ts`, API-013-e01.)
- **That same `entity_schemas_org_name_version_uniq` index bites test fixture *helpers*, not just
  `onConflict` targets.** A test that calls a fixture helper more than once per org — e.g. seeding
  three inquiries in a loop, each via a helper that inserts its own `entity_schemas` row — will
  23505 on the second call if the helper hard-codes the same `name`/`version` every time. There's no
  `onConflict` to catch it because it's a fresh insert, not a resolvable conflict. Suffix the name
  with a per-call sequence number (`` `rental-listing-${n}` ``) whenever a fixture helper that clones
  a schema might be called more than once in the same org within one test. (Evidence:
  `packages/api/src/routes/deal-match.integration.test.ts`, AI-008-e01-RETRO.md.)
- **UUIDv7 ids minted in the same millisecond are not monotonic** — the rand bits decide the order. Any test (or query) that relies on "latest row by id" across rows inserted in one transaction is flaky; pin explicit ids in fixtures or separate the writes in time. Prod is usually fine because real events arrive milliseconds apart. (Evidence: `knowledge/specs/041-AI-009-inquiry-preference-extraction/epics/05-cross-conversation-lead-context/AI-009-e05-RETRO.md`.)
- **A column ordered by `fractional-indexing` keys MUST be `COLLATE "C"` — do not mistake its failures for the UUIDv7 flake above.** `messages.f_idx` holds `fractional-indexing` keys, which assume **bytewise** ordering: a message back-inserted before the first anchor gets a key like `Zz`, and correctness needs `'Zz' < 'a0'` (uppercase `0x5A` < lowercase `0x61`). A bare `text` column inherits the DB default locale collation (`en_US.UTF-8` on Neon/dev), under which `'Zz' > 'a0'` — so `ORDER BY f_idx` (and any covering index like `idx_messages_conversation_fidx`) sorts a back-inserted message to the **end** instead of the start. This is **deterministic, not a flake**: the `messages.integration.test.ts` "straddle the anchor" test failed the same way every run, and stayed red on `main`/prod until caught during a deploy — because its symptom (a mis-ordered message batch) *looks* like the same-millisecond ordering flake and invites the wrong diagnosis. The fix is the column collation, not the id scheme: create any fractional-index column `COLLATE "C"` (migration `20260719_055` retrofitted `messages.f_idx`, which also rebuilds the covering index). (Evidence: `packages/db/migrations/20260719_055_messages_fidx_c_collation.ts`, `packages/api/src/routes/messages.integration.test.ts`.)
- **Adding a second FK from a table to one it already references triggers a PostGraphile naming collision that only surfaces at schema-build time — no migration test or `tsc` catches it.** `deals` already had `user_id → users.id`; migration `20260720_060_deals_working_view_columns.ts` added `assigned_to → users.id` for the assignee column. `postgraphile-plugin-connection-filter` tried to name both forward-relation filter fields `user` and threw `A naming conflict has occurred — two entities have tried to define the same key 'user'` the first time anything built the schema (an unrelated-looking integration test, since the API boots the schema lazily on first GraphQL-adjacent call). Whenever a migration adds an FK column pointing at a table another column on the *same* table already references, immediately `pnpm -C packages/api schema:export` (or run any test that triggers a schema build) and expect this error; fix with a `constraint`-scoped smart tag disambiguating the new relation, e.g. in `packages/api/src/graphql/plugins/smart-tags.ts`: `'public.deals': { constraint: { deals_assigned_to_fkey: { tags: { fieldName: 'assignee', foreignFieldName: 'assignedDeals' } } } }`. (Evidence: `packages/db/migrations/20260720_060_deals_working_view_columns.ts`, CORE-026-e01-RETRO.md.) **When one migration creates multiple new tables, check every one for this, not just the one that throws first** — `build:schema` reports only the first collision it hits and aborts, so fixing that one and rebuilding can *look* clean while a second collision on a different table is still waiting. Migration `20260818_075_outbound_send_rail.ts` created both `autonomy_policies` (double FK to `users`: `user_id` + `updated_by`) and `outbound_intents` (double FK to `messages`: `reply_to_message_id` + `observed_message_id`) — the first build only reported the `users` collision. Find every double-FK-to-the-same-table pair by reading the migration (grep its `.references(...)` calls for repeated targets) before running `build:schema` at all, and tag all of them in one edit. (Evidence: `packages/db/migrations/20260818_075_outbound_send_rail.ts`, CORE-019-e01-RETRO.md.)
- **Same failure mode, one layer over: a computed column named `<table>_<column>` collides with a real column `<column>` on that table** (e.g. a function `inquiries_expires_at` and a real `inquiries.expires_at` column both resolve to GraphQL field `expiresAt`). See `custom-graphql-mutations-and-queries`'s "Sortable computed columns" section for the mechanism and the `fieldName` fix — this is a legitimate shape (override column + effective-value function), not a mistake, so tag it pre-emptively rather than waiting for the build error. (Evidence: CORE-029-e01-RETRO.md.)
- **Master schema field `type` is conventionally a bare JSON-Schema string** (`type: 'string'`) across every existing master (`packages/db/src/master-schemas/rental/`, `whatsapp-merge-signal.ts`) — nullability is expressed by the field being *omittable* (not `required`), not by a `['string', 'null']` union. If a new master genuinely needs the LLM to emit an explicit `null` (e.g. to distinguish "checked, not stated" from "never checked" — AI-013's CRE schema, so its arithmetic/provenance validators can null-and-flag a specific field), a nullable-type union is fine, but it's the **first** of its kind: the `masterSchemas` GraphQL query (`packages/api/src/graphql/plugins/entity-schemas.ts`) maps each field's JSON-Schema `type` straight into a `String!` GraphQL field, and blows up (`String cannot represent value: [...]`) on an array-valued type. Fixed there by joining array types with `'|'` — check that mapping (and anything else that reads `MasterSchema.schema.properties[x].type`) whenever a new master uses nullable-union types. (Evidence: `knowledge/specs/045-AI-013-om-listing-extraction/epics/01-om-extraction/AI-013-e01-RETRO.md`.)

- **Retiring what produces a `CHECK (col IN (...))` value does NOT mean removing that value from the
  CHECK.** `ALTER TABLE ... ADD CONSTRAINT` (the only way to narrow a `CHECK`, since Postgres has no
  `ALTER CONSTRAINT` for the expression) validates every existing row — a producer retired after
  thousands of historical rows exist (`agent_runs.kind = 'deal_match'`, 1,895 rows) makes the
  narrowed CHECK fail immediately on migrate. Only stop *producing* the value (delete the code
  paths, `agent_runs`/`suggestions` inserts); leave the CHECK's vocabulary alone so history stays
  readable. Only remove a vocabulary value once its migration reads zero live rows for it, and even
  then that's a separate migration from the retirement itself. (Evidence:
  `packages/db/migrations/20260919_092_retire_deal_suggestions.ts`, CORE-042-e01-RETRO.)

- **A migration's backfill must be self-contained, and exported so its test can call it.** `db:test:reset` migrates an EMPTY database, so an in-migration backfill touches nothing and ships untested. Snapshot any constants it needs inside the migration (never import `src/master-schemas`: a later move would break every replay), export the backfill function, and let the migration test call it against fixture rows inside a rolled-back transaction, plus one test asserting the snapshot equals the live source **restricted to the snapshot's own keys** — the live registry keeps growing, and an unrestricted equality breaks on the first unrelated addition (a new listing master broke 098's test this way in `CORE-010-e06-RETRO`). (Evidence: `packages/db/migrations/20260928_098_viewings.ts`, `CORE-047-e01-RETRO`.)
- **`packages/api/schema.graphql` is gitignored**, so a "diff the exported schema" check has nothing to diff: verify new type/field names by grep plus `build:schema` and `build:schema:check`.
- **A candidate on a WhatsApp conversation comes from `conversation_participants`, never `messages.sender_contact_id`** (WhatsApp ingest leaves it NULL). Fixtures for anything keyed on the candidate must build the conversation through `ingestWhatsappMessage`. And an **absence test ("never reveals X") only counts once seen failing** with the leak deliberately injected, on every code path that renders the block (`CORE-047-e01-RETRO`).

- **A partial UNIQUE index on an FK column can make PostGraphile drop the referenced table's backward relation** (`Inquiry.deals` vanished when `deals(inquiry_id) WHERE closed_at IS NULL` became unique). Re-tag the FK in `smart-tags.ts` (`foreignFieldName` + `behavior: '+connection'`; `+list` adds a second `…List` field) and diff `schema.graphql` against main's after any index change. Also: replacing `UNIQUE(a,b)` ("once ever") with a partial "once while open" loses the never-resurrect-a-closed-row guarantee, so re-state it in code (`CORE-050-e01-RETRO`).

## Neon-Specific Notes

- Extensions available: `pgcrypto`, `citext`, `pg_uuidv7`
- Compute may be suspended (cold start) — the serverless driver handles wake-up gracefully
- Capture bodies go to object storage (R2/S3), NOT Postgres — they're 400-700KB each

- **Use a UNIQUE constraint for a permanent one-to-one relation that PostGraphile must expose as singular.** A standalone `CREATE UNIQUE INDEX prospects(asset_id)` enforced dedup but generated an `Asset.prospects` connection; a column/table `UNIQUE` constraint generated `Asset.prospect`. Both support the same `ON CONFLICT (asset_id)` upsert, but GraphQL introspection distinguished them. Verify the exported relation as well as the SQL index. New business-owned tables can carry `COMMENT ON TABLE ... IS '@behavior -insert -update -delete'` to keep auto-generated GraphQL writes disabled. Evidence: CORE-052-e01-RETRO.
