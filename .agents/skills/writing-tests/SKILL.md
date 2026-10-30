---
name: writing-tests
description: How to write tests for the vault that prove something - red first, absence mutations, contract and golden suites, tests that run on both storage engines, type-level negative tests, no leaked state, flake handling. Use whenever you write or change a test, write a cycle charter's test obligations, review a coder's tests, or investigate a flaky or order-dependent test.
---

# Writing tests

The rule behind everything here: **a test only counts once you have seen it fail for the right reason.**
Tenancy itself (per-engine rules, the open/enterprise import boundary) is in `api-routes`. Migration tests are in `db-schema-and-migrations`
("Testing migrations"). The charter (`tdd-cycle-generator`) names *what* must be proven and the
evidence kind; this skill is how the coder proves it, and `execute-cycle` is the procedure around it.

## 1. Prove the test can fail

- **Red first, per file.** Run each new test file alone before the code it tests exists and record the run
  (N failed, and why) in the completion report's `Red runs` line. A file never seen failing is the same gap
  as an absence test never seen failing ([[CORE27]] review). A missing-module error is not a useful red:
  stub the module so the assertion itself fails. **Paste the red run into the cycle's RESULT.md when you
  make the red commit**, not only into the final report: a report can be lost with its agent, and
  [[CORE38]] then had red commits but no red output, so review had to accept the commit order plus the
  absence mutations instead.
- **A suite that needs the whole vertical (contract, parity, atomicity, concurrency, golden replay) cannot
  fail meaningfully first.** Prove its strength with **absence mutations**: inject one fault into the
  implementation, see the named test turn red, restore it, and keep the raw output in RESULT.md. Examples
  from [[CORE35]]: replace the D1 batch with autocommit statements (7 atomicity tests fail); put the event in
  its own Postgres transaction (6 fail); emit `after` values as `before` (8 fail); hard-code the set cap; add
  a `pg` import to an open package; erase a type with `any`; drop the writer lock.
- **A mutation that stays green is suspect before the test is.** Check `git diff` shows an executable line
  changed: [[CORE38]]'s mutation 7 (`remoteBindings: true`) first replaced the word in a code comment and
  stayed green; applied to the `return` line it turned red. Record which attempt counted.
- **A filtered run that ran nothing is not a result.** `vitest -t` with a pattern that matches no test exits `0` with
  every test `skipped`, which reads like "the mutation stayed green". [[CORE58]]'s first mutation pass prefixed the
  pattern with the `describe` title (`-t "content operations on d1 file bytes and headers"`) and matched nothing for
  M2, M4 and M7; filtering by the test's own title ran both engines and all three went red. Before recording a mutation,
  check the output names the targeted test (`×` or `1 failed`); read the engine from the `describe > test` path.
- **A test that computes its expectation with the function under test cannot catch a fault in it.** [[CORE58]]'s
  "markdown content" case seeded the object at `messageBodyKey(contentKey, 1)` and the reader looked it up with the same
  builder, so breaking the builder (M3) moved both sides and stayed green. Pin at least one case to a literal
  (`` `${contentKey}/v1/body.md` ``) whenever the test and the code share a helper.
- **An absence mutation is per engine: drop every guard that engine has for the property.** The same property can be
  held by different guards on each engine. Removing one guard proves nothing on an engine where another still holds.
  [[CORE41]]: dropping first sight's `assertStep` turns the D1 drift case red (D1 decodes after the batch commits, so
  the assertion is the only guard). The Postgres trial stays green, because decode runs **before** commit there and
  the empty `result` select throws `UnitDriftError`, rolling the unit back. On Postgres that mutation must drop both
  guards. When you record a mutation, name the engine each row turns red on, and list each engine's guards
  for the property.
- **An ordering mutation must defeat the index order too.** SQLite returns an unordered aggregate in the order of the
  index it scanned, so dropping `ORDER BY` from an embed stayed green on D1: the unique index on `(message_id, position)`
  already sorted the rows, however the seed inserted them ([[CORE25]] M7). Postgres turned red. To prove an `ORDER BY`
  on D1, order by a column no index covers, or pin the generated SQL in a unit test (`embed.test.ts`).
- **Deleting tests needs a title-by-title map, not a count.** When a cycle deletes a suite with the code it tested, list
  every deleted test title in RESULT.md beside its surviving counterpart (file and test name), or the reason it was
  only about the deleted mechanism. A falling test count hides lost coverage. [[CORE44]]'s map found three live
  behaviours that only the legacy suite had ever tested, and they got tests of their own.
- **An absence test ("never reveals X") only counts once seen failing** with the leak deliberately injected,
  on every code path that renders the value.
- **An absence test is only red-then-green if the fixture triggers the producer under the old code.** A
  conditional producer makes a bare-minimum fixture pass trivially. Check the injected fault can actually
  turn the named test red: `set_config(..., false)` inside a transaction that rolls back is rolled back too,
  so it cannot redden an "after rollback" leak test ([[CORE1]]). Run each target test alone (`-t`): on a
  shared `max: 1` pool, one test's leak reddens the next for the wrong reason.
- **No assertion that only keeps a binding used.** `expect(u.id).toBeTruthy()` on a freshly seeded row passes
  whatever the code under test does ([[CORE29]] review). If the seeded id is not needed, drop the `const`
  (`await seedUser(...)`); if it is, assert something the code decides.
- **Assert the exact thing the spec attributes.** An event's `actor_id` equals the calling principal's id,
  never `not.toBe(someoneElse)`, which passes for almost any value ([[CORE15]] review). When a spec
  attributes a write to a principal, *every* path that writes it asserts the attribution on each event, not
  only one ([[CORE29]]: repair tests checked `actor_id`, reconcile tests checked only event types).
- **A refusal titled "writes nothing" snapshots after every refusal it makes**, not only the last one. A
  check of the state from before the call proves nothing ([[CORE40]] review).
- **A rule that compares against stored state gets a test for "no stored state"**: a guard that is silent
  when there is no row to compare is where it leaks ([[CORE29]]).
- **A pinned behaviour is a spec decision.** Tests assert the contract the spec writes down (statuses,
  codes, messages, event order). Where a spec keeps a rule, the shipped code is a reference for reading it,
  never an oracle to compare against: there is no legacy-oracle fixture ([[CORE36]] D12, no backward
  compatibility). Where the spec is silent and a cycle pins existing behaviour, record that as a decision
  ([[CORE35]] D22).

## 2. Type-level tests

When the contract is a compile-time one (a typed storage or definition API), test the compile errors.

- Put `@ts-expect-error` negatives with a **positive sibling** each in a `*.typecheck.ts` file that
  `pnpm -r typecheck` covers. Write them **at the call site a user writes** (a resource definition: unknown,
  secret or mistyped record column; unknown or mistyped computed column; unknown filter or reference; a
  guard on another table), not only on standalone helpers ([[CORE35]] review F1).
- Show each negative red: against a permissive type it reports an unused directive (TS2578); with the
  directive removed it reports the real diagnostic (TS2322, TS2353, TS2345). Keep both outputs.
- A cast that erases the check (`as never`, `any`) defeats the test; a cast needs one commented, reviewed
  boundary.
- **Tightening a type can leave an old negative red for the wrong reason.** `@ts-expect-error` only asserts that
  *some* error occurs. When [[CORE58]] made `messages.content_key` a secret column, fixture 9 (`content_key: z.number()`,
  "wrong type") kept compiling red, now because the column is secret, and stopped testing the type mismatch it named.
  A cycle that tightens a type rule greps the existing negatives for the affected columns and re-targets each one whose
  error reason changed (fixture 9 moved to the public `version` column); review caught this, the gate could not.
- **Type a column by its decoded value, not by the union of engine representations.** With
  `string[] | string` (Postgres array or D1 JSON text), `scopes: z.string()` is assignable and the negative can
  never go red. `StringArrayColumn` is `string[]`, because only `toRecord` sees the raw text ([[CORE40]]).

## 3. Tests across storage engines

One program, two engines: the same assertions run on Postgres and D1.
  - `src/test/engines.ts` opens Postgres (`vault_app`, no presets) and a Miniflare D1, with injected
    clock and ids.
  - `runContractSuite({ backend: d1Backend() })` runs the same assertions on D1, with one binding per
    tenant, never two tenants in one D1.
  - Golden fixtures (`packages/api/fixtures/golden/`) come from the Postgres path. After an intended
    behaviour change, run `pnpm -C packages/server-postgres golden:generate`; `golden:check` fails on drift.
    Some golden values derive from the registry: the owner's scopes in `auth.json` are
    `grantableScopes(declaredScopes())`, so a cycle that declares a scope regenerates `auth.json` by exactly those
    lines ([[CORE25]]). Before claiming "golden unchanged", check for such derived values.
    The generator lives in the enterprise package and reads the open fixture list, scenarios and Postgres
    backend through `@vault/api/test/golden` ([[CORE44]] P12).
  - Apps that must run no unit (openapi, CORS, option checks) pass `coldStorage()`; probe operations in routing and
    auth suites return their value through `probeUnit(value)` (`src/test/storage.ts`). There is no legacy
    `withContext`, `asUser`/`asAgent` or contract `kit.ctx`: fixtures make prerequisite rows through `kit.post`
    or `kit.seedMember` ([[CORE44]] P9).
  - Suites written after the vertical exists prove their strength with absence mutations (break the
    runtime, see the target test fail), recorded in RESULT.md.
- **Read-only resources have no writer to seed through.** Seed them with `seedConversation(insert, opts)`
  (`@vault/api/test/messaging`) and `Engine.insert` (storage suites) or `kit.insert` (contract fixtures' `make`/`input`),
  direct inserts that satisfy the table CHECKs. `Engine.insert` encodes json (JSON text) and booleans (0/1) per
  `COLUMN_KINDS` on D1. Replace them with the real capture helper when `recordMessages` exists.
- Assert engine differences explicitly, never hide them. Since [[CORE36]] D2 there is no timestamp
  difference: every stamp a unit writes equals its injected `now` on both engines. Assert the response, the
  stored row and every event's `created_at`/`after` against the clock exactly, with no engine branch (the
  clock-parity case in `src/storage/identity-model.storage.integration.test.ts`).
- Golden fixtures pin behaviour across engines and across refactors. Name every deliberate difference in the
  fixture (`named_differences`, filtered per file from `NAMED_DIFFERENCES` in `packages/api/src/test/golden/fixtures.ts`). The one entry
  is D1 fixed-organisation admission (scenario `foreign-organisation-claim`, [[CORE41]] P15). For a named scenario,
  the D1 replay asserts the D1 outcome (every step `403 organization_forbidden`, no events, row counts unchanged)
  instead of equality. Ids come from `goldenId(n)`, a
  four-digit counter that throws above 9999. Every seeded row a read can return gets a fixed id and the
  fixed `GOLDEN_SEED_AT` stamp on both engines, never a database default. A unit that mints a secret takes
  `env.randomBytes`, which golden backends inject as `goldenRandomBytes` (the n-th call fills with n)
  ([[CORE40]] P12). One file per area (`tasks.json`, `identity-model.json`, `administration.json`, `auth.json`,
  `directory.json`, listed in `packages/api/src/test/golden/fixtures.ts` `FIXTURES`).
  - Golden actors ([[CORE41]] P15): `'agent-key'` (a fixed seeded key), `{ clerk: subject, claim? }` (a real
    Clerk-signed token for the scenario's `clerk` fixtures) and `'webhook'` (a Svix-signed delivery of `body`). An
    `alg: none` token still goes to the fake authenticator, so older scenarios keep their actors and fixtures.
- **Every list of named exceptions is exact in both directions.** An unlisted difference fails, and so does a
  listed one that no longer holds (stale), so an exception can never quietly keep a looser bound. This covers
  golden `NAMED_DIFFERENCES`, the engine schema audit's `ENGINE_DIFFERENCES`
  (`packages/storage-postgres/src/test/schema-audit.ts`: Postgres `pg_catalog` against D1 pragmas, so a D1
  migration that drifts a key, FK action or partial predicate fails) and `FREE_PLAN_EXCEPTIONS` in
  `packages/server-d1/src/measured-limits.test.ts`, whose stale check came only in review ([[CORE47]]).
- **Auth and directory suites run on both engines through `openAuthKit(engine)`** (`src/test/auth-kit.ts`): the real
  authenticator and webhook over the fake Clerk, on the engine's binding. `kit.ran` records each unit (name,
  identity, stats), so you can assert "no unit ran" or `stats.writes`. `kit.armOn(name, hook)` arms D1 drift for one
  named unit. Both engines link the organisation (`clerk`, `org_engine`) and the two users (`user_engine_1`/`_2`) on
  `reset`. `engine.runAs(identity, op)` runs an `account` or `internal` unit.
- **D1 drift is tested deterministically, not by racing.** `engine.betweenPlanAndCommit(hook)` (D1 only) runs
  `hook` after the next unit's read batch and before its commit batch, so a test can delete, merge, insert or
  swap rows between plan and commit and assert `409 conflict` with nothing changed. For every set write, cover
  a row added, a row removed and **a swap that keeps the count** (the swap case caught a real gap in the
  [[CORE36]] review). **When a write carries two guards and one subsumes the other on the common path**
  (a revoke guarded on `revoked_at IS NULL` and on the `updated_at` stamp, where every real revoke also moves
  the stamp), give each guard a drift case of its own. Use `engine.update(table, id, patch)` to move only the
  column that guard reads (`revoked_at` without `updated_at`). Otherwise dropping that guard leaves every test
  green ([[CORE40]] absence mutation 1). On Postgres, cover races with coordinated trials instead. A tenant unit's plan
  and commit share one locked transaction. An internal unit with no organisation takes **no** lock, and its plan reads
  are separate READ COMMITTED statements: a trial is the only test of its read order ([[CORE41]]: two same-subject
  first sights misreported as `account_conflict` until the email was read first).
- Atomicity, isolation and concurrency suites run on both engines. On D1 a double submit lets exactly one
  write land and the loser gets `409 conflict`; on Postgres run enough trials (20) to see a race, and report
  trial counts.

## 4. Tests leave nothing behind

- **Never leave schema or settings changed on the shared test DB.** `ALTER TABLE ... DISABLE TRIGGER` and
  similar changes persist across runs and files. The golden backend's leaked `set_updated_at` disable hid
  production `updated_at` from every later suite, and a test passed or failed depending on file order
  ([[CORE35]] F5). Restore the state in `close()`/`afterAll`/`finally`. When a suite must alter production
  state, make the harness assert that state before every suite (CORE35's `tgenabled` guard did this; it went
  with the trigger in [[CORE36]]). If such a guard trips, run `pnpm db:test:worktree`.
- **Test support lives under `src/test/`.** The import-boundary checker treats a file as test code only by its
  `*.test.ts` suffix or a `/test/` path segment. A setup file such as `src/test-setup.ts` is production code to it,
  and fails the rule that forbids `@vault/db` in `api/src` ([[CORE44]] P13: it moved to `src/test/setup.ts`).
- **Verify from a fresh database, and run the suite twice in a row.** A suite that passes only on the second
  run depends on leaked state.
- Clean up in `afterEach`, delete only the exact rows this test seeded by their own ids, never a "nothing
  references it" query against shared reference data (`db-schema-and-migrations`).

## 5. Flakes are defects

A test that fails once and then passes is a bug until its cause is found. Do not rerun and move on.

- **Read the failure for what it says.** CORE35's flake expected the injected clock and received wall-clock
  time: that named the cause (a trigger stamping `updated_at`, enabled on a fresh DB and disabled by a leak
  on reruns) directly.
- A full-suite failure that reproduces standalone is a real bug, not contention. If it only fails in the
  full run, rerun once; to tell "my change broke it" from "it was already broken", revert your diff against
  the clean tree and rerun. A pre-existing failure belongs in a follow-up, not in your commit.
- Never run two suites against one database at once (`pgrep -f vitest`); run the `db` and `api` suites
  serially. Inside a package, Vitest 4+ has no `poolOptions.forks.singleFork`: use `pool: 'forks'` with
  `fileParallelism: false`.
- **Event order.** See "Assert emit order" in section 6; never order by `id` in a test.

## 6. Backend (`packages/api`) tests

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

**D1 harness.** Each test organisation gets its own disposable binding (in-memory Miniflare), never two
organisations in one D1. A foreign organisation's identity must be refused, not filtered: test the refusal,
and test that a second organisation fails on a foreign key ([[CORE35]] D18).

- **A cross-tenant test needs a REAL second organisation** with an explicit `organization_id` threaded
  through every fixture on the other side. Two "different" users that land in one default org prove nothing;
  RLS has nothing to separate and the assertion passes for the wrong reason.
- **The contract suite runs over every resource definition automatically**
  (`src/contract.integration.test.ts`, which calls `runContractSuite` from `src/test/contract.ts`). It
  runs over REST, as both an agent (a real API key) and a user (`fakeUserAuthenticator`), checking:
  - create, get, list, update and delete, with exact events and `actor_id`;
  - cross-tenant 404s;
  - unknown fields;
  - missing scope, and read is not write;
  - no credential;
  - routes that should not be generated;
  - the OpenAPI document.

  To add a resource, register its definition in `createVaultRegistry` and add one entry in
  `src/test/fixtures.ts`:
  - `input` and `patch` builders, each producing unique values per call;
  - `make` for read-only definitions.

  An `input` may create prerequisite rows through the kit (a link resource needs a contact and a file). The suite
  takes its event-count baseline **after** `input` runs, so those rows' events are not counted against the
  operation under test ([[CORE25]]).

  A catalog test fails if a definition has no fixture or a fixture has no definition. A `ContractCheck`
  passed in `checks` runs once per definition and registers its own `it` blocks; `env` is a getter
  because tenants are re-seeded for each test. The generic machinery (tenancy isolation, scope enforcement, an event on every write,
  webhook delivery and retries, the cursor) is tested once, in depth. Bespoke tests are for real logic:
  commands (merge, send, suggestion lifecycle) and channel adapters.
- **Assert emit order with `orderBy(sql\`ctid\`)`** on `events` after a per-test truncate, never by
  `id`: same-millisecond UUIDv7s are not monotonic and an id-ordered assertion flaked 2 runs in 4
  ([[CORE2]]). ctid order is valid **only on a fresh heap in a test** (truncated, one backend appending).
  On a long-lived database (`vault_dev`), the heap reuses freed space, so a smoke or e2e check there
  asserts the **set and count** of event types for its organisation, never their ctid order ([[CORE27]]
  review). Once [[API6]] D13 lands (`events.id` defaulting to PG18 `uuidv7()`, monotonic per backend),
  switch both to `ORDER BY id`.
- **A service function exported for another spec's in-process caller gets no adapter parsing.** The REST
  body schema trims and bounds input; a channel calling the function directly does not pass through it.
  Clean free text from external sources inside the function (`cleanName` in `src/identity/resolve.ts`:
  trim, blank is absent, cap at the column limit), or one odd display name fails a whole capture batch.
- `truncateAll(owner)` lists every `public` base table from the catalog at call time (except Kysely's two), so a new table needs no harness edit.
- `beforeEach` is scoped to its enclosing `describe`. A second top-level `describe` in a file does not
  inherit the first one's reset; give it its own.
- Before API tests: `pnpm db:test:reset` (or `db:test:worktree`). Run: `pnpm -C packages/api test [file]`.
- For file downloads, assert a UTF-8 BOM on `response.arrayBuffer()` (`EF BB BF`), not `response.text()`:
  Fetch's decoder strips the BOM.
- Postgres `NUMERIC` comes back from `pg` as a string even when a `sql<number>` annotation says otherwise.
  Convert at the DTO boundary and assert actual JSON value types in route tests.
