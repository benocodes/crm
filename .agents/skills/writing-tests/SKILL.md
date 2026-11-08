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
  a `pg` import to an open package; erase a type with `any`; drop the writer lock. The same holds for a check over
  fixtures that exist before the code ([[CORE69]]: the zod half of the shape contract passed at once; retyping one
  fixture field turned 14 red). **A vendored copy of a dependency's function** keeps a parity test against the
  original in Node, proven by swapping in a near-miss implementation ([[CORE69]]: `mdast-util-to-string` for
  `toPlainText`, 7 parity tests red).
- **A mutation that stays green is suspect before the test is.** Check `git diff` shows an executable line
  changed: [[CORE38]]'s mutation 7 (`remoteBindings: true`) first replaced the word in a code comment and
  stayed green; applied to the `return` line it turned red. Record which attempt counted.
- **A mutation must reach the behaviour it claims to break.** [[CHN155]]'s first M4 (start `users.stop` before the
  commit) built the stop with a dummy credential, so it failed inside the stop before any HTTP call and the "no stop on a
  failed unit" test stayed green for the wrong reason; the counted M4 moved the real call into the plan phase and three
  tests went red. When a mutation stays green, check that the mutated path actually performs the observed effect (a
  request on the fake, a row) before concluding the test is weak.
  **A safe backstop can hide the guard you mutate:** AGT166's first M13 removed the pending-transition guard and stayed
  green, because the unique request index also refused the duplicate and the test accepted any `409`. Assert the
  specific code (`action_request_not_pending`) and the winner's attribution, so only the guarded path passes.
- **A filtered run that ran nothing is not a result.** `vitest -t` with a pattern that matches no test exits `0` with
  every test `skipped`, which reads like "the mutation stayed green". [[CORE58]]'s first mutation pass prefixed the
  pattern with the `describe` title (`-t "content operations on d1 file bytes and headers"`) and matched nothing for
  M2, M4 and M7; filtering by the test's own title ran both engines and all three went red. Before recording a mutation,
  check the output names the targeted test (`×` or `1 failed`); read the engine from the `describe > test` path.
- **A mutation must keep the file loadable.** [[CORE129]]'s first golden mutation (M7) deleted one line of `tags.json`
  and left invalid JSON. The suite failed at load ("no tests"), which also happens when the replay check itself is broken.
  M7b deleted a whole valid entry, and the named replay test went red. A mutation of a fixture, a migration or a module
  must still parse. Only a failure of the named test counts.
- **A mechanism that is generalised beyond the charter's case takes the obligation with it.** If the charter asks for a
  refusal of a repeated `tag_id` and the code refuses any repeated query parameter ([[CORE129]] D10a), a test that uses only
  `tag_id` stays green when the code is narrowed back. Pin the general claim on a case other than the original (another
  operation, another parameter, another type), and show the narrowing mutation red. Reviewers look for this first.
- **A test that computes its expectation with the function under test cannot catch a fault in it.** [[CORE58]]'s
  "markdown content" case seeded the object at `messageBodyKey(contentKey, 1)` and the reader looked it up with the same
  builder, so breaking the builder (M3) moved both sides and stayed green. Pin at least one case to a literal
  (`` `${contentKey}/v1/body.md` ``) whenever the test and the code share a helper.
- **An exactness check must not filter its expected side by the actual side.** [[API32]]'s placement test first kept
  only the table entries that were registered (`Object.entries(PLACEMENT).filter(([n]) => n in actual)`) and filtered
  its literal meta list by `ops.some(...)`, so an operation that was never registered, or silently dropped, passed both
  `toEqual`s. Write the expected side as a literal; where some names legitimately don't exist (read-only resources have
  no `create`), list them explicitly and assert they are absent too (`NOT_GENERATED`), and pin the count. Prove it by
  misspelling one expected entry: the test must go red (review round 1).
- **A fixture whose order agrees with a tie-break hides the rule under test.** Where code resolves a choice by a rule
  and falls back to "first declared wins", a fixture that already declares the right answer first passes with the rule
  deleted. [[API63]]'s D13 primary-key rule (`interactions.thread_id` → `threads.id`, not `messages.thread_id`) survived
  its absence mutation until the fixture declared the decoy (`messages`) key first. Put the decoy first so only the
  rule gives the expected answer, and confirm with the mutation.
- **A case behind an earlier layer cannot be red.** A test that a new route answers `503` while a gate is closed passes
  before the route exists when the gate runs before routing ([[API63]]: the [[CORE61]] `migrations_pending` gate). Keep
  it as a regression guard and pair it with a case that needs the new code (gate open → `200`); a charter should not
  ask for a red run on the first one.
- **A term that today's configuration makes vacuous cannot be proven with today's configuration.** [[CORE77]]'s
  delegated scopes are token ∩ cap ∩ role ∩ grantable, but under the real `SCOPE_POLICY` every agent-grantable scope
  is also a member scope, so dropping the role term changed nothing. Inject the configuration (an optional `policy`
  option on the authenticator) with a case where only that term removes a scope, and prove it with the mutation.
  Give each term of an intersection its own case.
- **A schema-equality suite does not go red on a new field.** The contract suite compares a response with the
  record schema, and both gain the field together, so a charter asking for its red run on a record-shape change
  cannot be met ([[CORE77]]). Pin a new field with a test that names it (the resource's record-shape test, a
  Worker test reading it, the golden), and ask for those red runs instead.
- **A missing format is only half a schema contract.** For opaque cursors, assert the positive type as well as
  the absent UUID format in REST and MCP. Inspect the emitted nullable shape: `next_cursor` uses
  `type: ['string', 'null']`, while `after` uses `type: 'string'`. A serialized search for `"type":"string"` rejects
  the valid nullable array (`knowledge/specs/012-CORE174-mail-sort/RETRO.md`).
- **Registering already-passing cases cannot be red.** Adding resources to a suite's registry (the D1 contract
  fixture map, [[CORE72]] D17) runs cases that pass on the first run; a charter asks for the absence mutation (drop
  one entry, see its named cases and the "every definition has a fixture" check fail), not a red run.
- **A smoke script's assertions are untested code.** `packages/server-d1/scripts/smoke-remote.ts`'s `before`/`after`
  phase functions are reached by no test (only `afterHealthOk` is), so [[API32]]'s `before` phase asserted
  `GET /openapi.json` → `404` on an uninitialised deployment, where the cold app answers `503 not_initialised`; only
  review caught it. When a cycle changes what a smoke phase expects, check each expectation against the state that
  phase runs in (uninitialised, behind, current) and name the test or the compose case that pins the same answer.
- **An absence mutation is per engine: drop every guard that engine has for the property.** The same property can be
  held by different guards on each engine. Removing one guard proves nothing on an engine where another still holds.
  [[CORE41]]: dropping first sight's `assertStep` turns the D1 drift case red (D1 decodes after the batch commits, so
  the assertion is the only guard). The Postgres trial stays green, because decode runs **before** commit there and
  the empty `result` select throws `UnitDriftError`, rolling the unit back. On Postgres that mutation must drop both
  guards. When you record a mutation, name the engine each row turns red on, and list each engine's guards
  for the property. Count the **write's own guards** too: an `exactly(n)` around an INSERT…SELECT and a unique index
  are drift guards as well as the assertion. [[CORE68]]'s "remove the commit-time assertion" turned 7 of 10 race cases
  red; a copy committed meanwhile stayed `409` through `exactly` on messages, a removed identity through `exactly(m)`
  on participants, a created identity through the unique index. Predict each case per guard, and drop the
  assertion clause and the overlapping guard together to prove each clause.
- **An ordering mutation must defeat the index order too.** SQLite returns an unordered aggregate in the order of the
  index it scanned, so dropping `ORDER BY` from an embed stayed green on D1: the unique index on `(message_id, position)`
  already sorted the rows, however the seed inserted them ([[CORE25]] M7). Postgres turned red. To prove an `ORDER BY`
  on D1, order by a column no index covers, or pin the generated SQL in a unit test (`embed.test.ts`).
  An explicit collation needs a fixture with a conflicting stored default: a BINARY-default column stays green when
  `COLLATE BINARY` is removed. Use a real `NOCASE` column with `Z`/`a`, walk both directions one row at a time, and
  remove the override to prove both ordering and continuation comparisons (`knowledge/specs/012-CORE170-message-sort/RETRO.md`, M7).
- **Backfill order needs a separate capture clock.** Seed mail through `recordMessagesOperation` with an advancing
  injected `now`, then capture the oldest `occurred_at` last. Keep same-thread ties and another thread, so chronological
  walks differ from capture/id order and page breaks exercise the tie-break. Take the read-event baseline after capture
  (`knowledge/specs/012-CORE174-mail-sort/RETRO.md`, M1).
- **Deleting tests needs a title-by-title map, not a count.** When a cycle deletes a suite with the code it tested, list
  every deleted test title in RESULT.md beside its surviving counterpart (file and test name), or the reason it was
  only about the deleted mechanism. A falling test count hides lost coverage. [[CORE44]]'s map found three live
  behaviours that only the legacy suite had ever tested, and they got tests of their own.
- **A fake transport must do what the code opts out of, or the opt-out is untested.** A fake `fetch` that never
  follows redirects makes "does not follow a redirect carrying the credential" pass with or without
  `redirect: 'error'` ([[API6]] review). Make the fake behave like the real thing for the property under test
  (follow a 3xx unless `redirect === 'error'`, keeping headers as a hostile server would hope), record the
  option on every request and assert it, and show the mutation (drop the option → red) per call site
  (`packages/cli/src/test/harness.ts`).
  The same holds for input streams: the harness's `readStdin` returns the content on the first read of a run and `''`
  after, like `process.stdin` at its end. A fake that hands back the full input on every read hid a double read in the
  CLI's stale-cache retry ([[CORE136]] review); the test that caught it runs the same bad `--data -` fresh, then on the
  cached state, and asserts identical stderr and no request sent.
- **An absence test ("never reveals X") only counts once seen failing** with the leak deliberately injected,
  on every code path that renders the value.
- **A redaction canary suite needs structure-injection canaries**, not only content canaries. For every parser in the
  redactor that keeps some structure (a `;` split, a `name=` prefix, a quoted string, an escape, an RFC 2047 frame, a JSON
  key path), plant a canary *shaped like that structure inside the content*: `filename="Invoice; CANARY=Q3.pdf"`,
  `name="a\"; CANARY=1"`. A suite of plain-word canaries passed while a quoted `;` let content out as a "parameter name"
  ([[CHN153]] review). Then run one absence mutation per branch of each parser (drop the quote tracking, drop the escape
  handling): a branch whose mutation leaves the suite green is unproven, however correct it reads.
  **Once a second defence covers the same leak, the canary cannot see the first.** After [[CHN153b]] masked every unknown
  parameter name, dropping the escape branch still wrote no `CANARY` (the mis-split name was masked anyway). Prove each
  defence with a case only it decides (there: a *known* name after `\"`, `filename="a\"; boundary=Z1"`, must stay one
  parameter), and record the canary's red run from before the second defence landed.
- **A fixed-point honesty check over recorded fixtures cannot tell an id-shaped word from a pseudonym.** A pseudonym keeps
  the original's length and character class, so `MariaGarcia` in an `id`, a path segment or a `pageToken` passes
  (`packages/api/src/test/recorded-honesty.ts`, [[CHN153b]] review). The check catches content in prose, header and error
  fields; for ids, the protection is the recorder's pseudonymisation, so a reviewer compares each committed recorded file
  verbatim (deep-equal) against the pulled object it came from.
- **A read-modify-write must not treat a failed read as absent.** `read().catch(() => [])` before a write overwrites good
  state after one transient error. Absent (the store answers null) is empty; a throw, timeout or unparsable value skips the
  write. Test all three ([[CHN153]] review, `packages/api/src/channels/gmail/recorder.ts`).
- **Assemble secret-shaped canaries at runtime** (`['sk', 'live', 'canary'].join('_')`), never as a literal.
  GitHub push protection scans every pushed commit and rejects a literal that looks like a provider key (an
  `sk_live_…` sentinel was taken for a Stripe key), so the red commit cannot be pushed ([[OPS87]]).
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
- **An assertion that must hold "in every test" runs on its own, not by a call each test remembers.** Have
  the harness record what each test produced (every run's stdout and stderr, every request) and check it in
  `afterEach`. For example: no issued secret appears in any output. A per-test helper reached 11 of 47 tests;
  the automatic one caught a planted leak in 34 ([[API104]] review, `packages/cli/src/device-login.test.ts`).
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
  - **The engine is in the file name (OPS92).** `*.postgres.test.ts` runs in the `postgres` vitest project (off by
    default, needs a database), `*.d1.test.ts` and engine-neutral `*.test.ts` in the default projects. A file with no
    `.postgres.` infix must not import `@vault/db`, `@vault/storage-postgres` or `pg` directly; a boundary test fails it.
    That check sees direct imports only (most `.postgres.` files reach Postgres through relative helpers). The runtime
    is the backstop: the default projects load no Postgres env, so `createTestDb` throws `TEST_APP_DATABASE_URL is not
    set`. Its one hole is a shell that already exports `TEST_APP_DATABASE_URL`.
    There is no flag, no per-package exclude list and no `skipIf` guard: a Postgres-only test goes in a `.postgres.` file.
    The infix goes last (`tasks.integration.postgres.test.ts`) so `.integration` stays the database-backed marker.
  - **A both-engine suite is a shared body plus two entry files.** The body is `x.integration.suite.ts` (not matched
    by the test glob) exporting `engineSuite(engineName)`; `x.integration.d1.test.ts` and
    `x.integration.postgres.test.ts` each call it with their engine. Write each assertion once; an engine branch
    stays in the body (`if (name === 'postgres')`). Break a shared assertion and both entry files go red.
  - `src/test/engines.ts` opens Postgres (`vault_app`, no presets) and a Miniflare D1, with injected
    clock and ids.
  - `runContractSuite({ ..., backend })` runs the same assertions on the backend it is given (`d1Backend()`,
    `postgresBackend()` from `src/test/postgres-backend.ts`); `backend` is required, there is no default. D1 has one
    binding per tenant, never two tenants in one D1.
  - Golden fixtures (`packages/api/fixtures/golden/`) are generated on D1 ([[CORE69]] D19, [[CORE72]]): after an
    intended behaviour change, run `pnpm -C packages/api golden:generate` (`d1GoldenBackend`, Miniflare, no database
    URL) and commit the diff; `golden:check` exits non-zero on drift. Review the regenerated diff line by line: every
    changed line is explained by the change, or it is a finding. Never hand-edit a fixture (the old workaround for the
    Postgres-side generator is gone). Some golden values derive from the registry: the owner's scopes in `auth.json`
    are `grantableScopes(declaredScopes())`, so a cycle that declares a scope regenerates `auth.json` by exactly those
    lines ([[CORE25]]). Before claiming "golden unchanged", check for such derived values.
    Event payloads in a transcript are written in Postgres `jsonb` key order (shorter key first, then bytewise,
    `jsonbOrder` in `d1-backend.ts`), so a regeneration does not churn when a program builds a payload in a different
    order ([[CORE69]] D21 ruling).
    Tests that pin derived lists (the declared scopes in `identity-definitions.test.ts` and
    `messaging-definitions.test.ts`) also change when a scope is declared; fix them in the same change.
    The generator (`packages/api/scripts/golden.ts`) is open code under the import-boundary rule for `api/scripts`;
    the fixture list, scenarios and both backends are exported through `@vault/api/test/golden` ([[CORE44]] P12).
    `messaging.json` is seeded through `captureMessages` with `FakeChannel` into the memory `ObjectStore` the app reads
    (a scenario declares `seed: 'messaging'`, seeded in `load()`, not `reset()`); it replays on D1 only. A transcript
    records a non-`application/json` response as `{ binary: { headers, sha256, size } }` ([[CORE69]] D23); read ids out
    of list responses with a step's `pick`, never hard-code minted ids.
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
  clock-parity case in `src/storage/identity-model.storage.integration.suite.ts`).
- Golden fixtures pin behaviour across engines and across refactors. Name every deliberate difference in the
  fixture (`named_differences`, filtered per file from `NAMED_DIFFERENCES` in `packages/api/src/test/golden/fixtures.ts`). The one entry
  is `engine: 'postgres'` multi-organisation admission (scenario `foreign-organisation-claim`, [[CORE41]] P15,
  flipped by [[CORE69]] D20): D1 generates the fixture, so the D1 replay asserts equality on every scenario (plus row
  counts unchanged for that one), and the Postgres replay asserts Postgres's own outcome (the claim admitted) instead
  of equality. Ids come from `goldenId(n)`, a
  four-digit counter that throws above 9999. Every seeded row a read can return gets a fixed id and the
  fixed `GOLDEN_SEED_AT` stamp on both engines, never a database default. A unit that mints a secret takes
  `env.randomBytes`, which golden backends inject as `goldenRandomBytes` (the n-th call fills with n)
  ([[CORE40]] P12). One file per area (`tasks.json`, `identity-model.json`, `administration.json`, `auth.json`,
  `directory.json`, `messaging.json`, `tags.json`, listed in `packages/api/src/test/golden/fixtures.ts` `FIXTURES`).
  A scenario whose token needs more than `GOLDEN_SCOPES` declares `scopes` (D1 backend only, the Postgres backend throws),
  so the seeded agent of older fixtures never changes ([[CORE129]] D16a).
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
  swap rows between plan and commit and assert `409 conflict` with nothing changed. The hook fires on the **next unit of
  any kind**, so a helper that lazily writes a prerequisite (CHN140's `ensureConnection`) consumes it: seed every
  prerequisite before arming. For every set write, cover
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
  `*.test.ts` or `*.suite.ts` suffix or a `/test/` path segment. A support file elsewhere in `src` is production code
  to it and fails the rule that forbids `@vault/db` in `api/src`. Vitest setup files are not in the package: the
  `postgres` project loads `packages/db/src/test-setup.ts` from `vitest.projects.ts`.
- **The root vitest config collects from the directory it starts in.** Its include globs are relative, and
  `configDefaults.exclude` does not cover `vendor/` (2000+ vendored test files), `.claude/` (other worktrees) or
  `knowledge/`; `EXCLUDE` in `vitest.projects.ts` lists them. When you add a project or glob, check it with
  planted files: put a `x.test.ts` under each of those trees and confirm `pnpm exec vitest list --filesOnly` at the
  root doesn't list it (OPS92 review; the normal file count proved nothing).
- **A refactor that moves or splits tests proves it kept them with a test-name manifest**: the full
  `package + test name` list before and after (`vitest run --reporter=json`), diffed as a multiset, with every
  difference explained (OPS92: 2750 → 2761, each delta named). A green run alone can't show a test went missing.
- **Verify from a fresh database, and run the suite twice in a row.** A suite that passes only on the second
  run depends on leaked state.
- Clean up in `afterEach`, delete only the exact rows this test seeded by their own ids, never a "nothing
  references it" query against shared reference data (`db-schema-and-migrations`).

## 5. Flakes are defects

A test that fails once and then passes is a bug until its cause is found. Do not rerun and move on.

- **Capture it at first sight.** Before any rerun, save the failing test's name and its raw failure (keep the
  run's output, or rerun only that file with the same seed). A flake reported without a name can't be followed
  up ([[CORE61]]: "1 failed | 160 passed" after a mutation series, never identified). After a mutation series,
  check `git status` first: a mutation that wasn't restored looks exactly like a flake.

- **Read the failure for what it says.** CORE35's flake expected the injected clock and received wall-clock
  time: that named the cause (a trigger stamping `updated_at`, enabled on a fresh DB and disabled by a leak
  on reruns) directly.
- A full-suite failure that reproduces standalone is a real bug, not contention. If it only fails in the
  full run, rerun once; to tell "my change broke it" from "it was already broken", revert your diff against
  the clean tree and rerun. A pre-existing failure belongs in a follow-up, not in your commit.
- Never run two suites against one database at once (`pgrep -f vitest`); run the `db` and `api` suites
  serially. Inside a package, Vitest 4+ has no `poolOptions.forks.singleFork`: use `pool: 'forks'` with
  `fileParallelism: false`.
- **Run the heavy suites one package at a time.** `packages/api` (the `contract.integration.d1` file especially), `packages/cli`
  and `packages/server-d1` interfere when they run side by side on the development machine. You get hook timeouts at
  10000 ms, `ECONNRESET`, a `deployment.singleton` collision and off-by-one query counts in `measured-limits.test.ts`, and
  a different test fails on each rerun ([[CORE133]] gate). For the gate, run `pnpm -C packages/<pkg> test` serially. A
  failure seen only in a parallel run is contention: rerun that package alone before you treat it as a regression.
- **Other sessions load the machine too.** Check `uptime` before a gate: AGT166's R1 gate ran at load average 20–36 on
  8 cores (parallel agent sessions), and full suites hit 10000 ms hook timeouts that never reproduced. Record the load
  in RESULT.md, don't raise a timeout, and settle the gate with one clean serial run on a quieter machine (in a sprint,
  a fresh verify-only agent); only that run counts.
- **Event order.** See "Assert emit order" in section 6; never order by `id` in a test.
- **Known flake: `packages/server-d1/src/measured-limits.test.ts`** is intermittently off by one on pinned query counts,
  on clean `main` too ([[CORE62]], [[API32]], [[API63]], [[CORE69]] on `merge-100-links`; issue #79). Until #79 lands, when it fails, record the scenario
  names and counts in RESULT.md and rerun once; don't loosen `EXPECTED_QUERIES`.


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
  (`src/contract.integration.d1.test.ts` and `src/contract.integration.postgres.test.ts`, which call `runContractSuite`
  from `src/test/contract.ts`). There are **two runs**: Postgres over `createVaultRegistry()`, and D1 over a
  hand-built registry and fixture map. A resource missing from the D1 run's registry is contract-tested only on
  Postgres, which is off by default (`pnpm test:postgres`): the default run exercises only the D1 registry, so a
  resource missing from it has no contract coverage at all ([[CORE68]]: the messaging fixtures went to `kit.capture`
  but ran only on Postgres until [[CORE69]]). It
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

## 7. Browser E2E scripts (Playwright, Clerk)

`packages/server-d1/e2e/*.e2e.ts` run Playwright + `@clerk/testing` against a local Worker and the Clerk dev
instance (`.env.dev` only), outside the gate. They fail on browser and provider timing, not on vault logic, so
write them against these mechanisms ([[API115]], `packages/server-d1/e2e/mcp-oauth.e2e.ts`):

- **`page.route` does not see the target of a server redirect.** An OAuth authorize endpoint answers `302` to
  the client's `redirect_uri`; a route handler on that URL never fires. Capture a loopback callback with
  `page.on('request')` or `page.waitForRequest`, which see every hop of a redirect chain.
- **A navigation carrying `__clerk_ticket` can abort** (Clerk's dev-browser handshake redirects the page).
  Catch the `goto` rejection, wait for the page to settle, and if the flow did not move on, retry with a fresh
  BAPI sign-in token: they are single use.
- **`window.Clerk.session` is not ready when `goto` resolves**, even after `clerk.signIn`. Wait for it
  (`page.waitForFunction(() => window.Clerk?.session)`) before `session.getToken()`.
- **A hosted provider screen's labels are not ours** (Clerk's consent button): match tolerantly and treat the
  click as optional while waiting for the outcome you actually assert (the callback, a URL).
- **Local setup:** `wrangler d1 migrations apply DB --local` before `bootstrap`; in `.dev.vars` write the
  `CLERK_JWT_KEY` PEM on one line with `\n` escapes. Delete every DCR client the run creates through BAPI by
  its application id (`DELETE /v1/oauth_applications/oa_…`), not its client id.
