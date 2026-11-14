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
- **Commit the green implementation before the first mutation.** Restoring a mutant with `git checkout <file>` (or
  `git restore`) resets the whole file to the last commit, so it also deletes any uncommitted real work in that file:
  [[CORE188]]'s mutation session reverted the uncommitted green `executions/definition.ts` this way and the coder had
  to rewrite it (`knowledge/specs/013-CORE188-execution-sort/RETRO.md`). Commit green first and restore from that
  commit. If you cannot, save the green file before mutating (a copy in the scratchpad that you copy back, or
  `git stash push -m <unique tag> -- <file>` followed at once by `git stash apply`, so the tagged stash stays as the
  backup). Never bare-checkout a file that holds uncommitted changes you mean to keep. The rule is not
  mutation-only: [[CORE199]]'s coder lost uncommitted work the same way mid-run, outside a mutation (see
  `execute-cycle` §3, "Setting work aside").
- **A mutation that stays green is suspect before the test is.** Check `git diff` shows an executable line
  changed: [[CORE38]]'s mutation 7 (`remoteBindings: true`) first replaced the word in a code comment and
  stayed green; applied to the `return` line it turned red. Record which attempt counted.
- **A mutation must reach the behaviour it claims to break.** [[CHN155]]'s first M4 (start `users.stop` before the
  commit) built the stop with a dummy credential, so it failed inside the stop before any HTTP call and the "no stop on a
  failed unit" test stayed green for the wrong reason; the counted M4 moved the real call into the plan phase and three
  tests went red. When a mutation stays green, check that the mutated path actually performs the observed effect (a
  request on the fake, a row) before concluding the test is weak.
  **The reverse holds too: a guard that sits behind another guard is never reached end to end**, so removing it
  turns nothing red. Test the inner guard by calling it directly ([[CORE287]]: the `databaseHooks.user.create.before`
  backstop sat behind the endpoint gate; `packages/auth/src/backstop.test.ts` calls the hook, and M5 turns 5 red).
  **Build fixtures only through states the invariants allow.** A fixture the system cannot reach (CORE287's two live
  invitations for one email, one backdated) can pin wrong behaviour and turn a correct fix red.
  **A safe backstop can hide the guard you mutate:** AGT166's first M13 removed the pending-transition guard and stayed
  green, because the unique request index also refused the duplicate and the test accepted any `409`. Assert the
  specific code (`action_request_not_pending`) and the winner's attribution, so only the guarded path passes.
  **When the backstop is a real guard on the same path, the mutated code is the duplicate: delete it.** [[OPS279]]'s
  M7 removed `bootstrap.ts`'s control-marker pre-check and stayed green, because `bootstrapD1` already refused a
  foreign marker before either database was written; no test could tell them apart, so the pre-check was dropped
  (RESULT D-f) rather than kept as untested defence.
  **An atomicity test names its failure the same way:** a bare `rejects.toThrow()` also passes when the unit fails at
  plan or build time, before any batch runs, so "nothing was written" proves no rollback. Assert the in-batch error
  (`rolled back (not_null)`, `packages/api/src/events/feed.integration.d1.test.ts`, [[API105]]).
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
- **A refusal the real producer cannot emit is proven on crafted inputs at the unit.** Better Auth signs with a key
  encrypted by `AUTH_SECRET`, so it cannot mint a token with a wrong `iss` or `aud`; [[CORE244]] proved those refusals
  (and their absence mutations) at the adapter on hand-signed Ed25519 tokens (`packages/api/src/auth/better-auth.test.ts`)
  and kept the composed workerd test for real tokens of each kind. A charter asking for such a mutation "in workerd"
  is asking for the impossible: ask for it at the unit, and for real-producer tokens at the composition.
- **A wiring choice is proven where it is wired.** A reader proven by a unit or route suite does not prove the
  composition picks it: [[CORE244]]'s `membershipRoleReader` was proven in the api callback suite, but nothing tested
  that `packages/server-d1/src/compose.ts` passes it as the mail-sync claim's `roleOf` on `better-auth` (a regression
  there suspends every connection; #284). When code selects an implementation per configuration, add one composed
  case per branch whose absence mutation is "the other branch's implementation".
- **A matrix obligation is the full cross product unless the charter removes cells.** List the cells the RESULT
  covers against rows × columns, and name each omitted cell with its reason; [[CORE244]]'s review found three `cli`
  cells missing from a 3 × 8 matrix that RESULT reported as complete.
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
  assertion clause and the overlapping guard together to prove each clause. A single removal that stays green
  because another guard rejects the same input is an equivalent mutant: record it as such beside the run that
  drops both and turns red (`sort=id` UUID check vs value = id, `knowledge/specs/012-CORE175-list-sort-rollout/RETRO.md`, M15).
- **Pick negative examples that stay negative.** A test proving "a list without X keeps the old behaviour" must
  use a case excluded by design (an exempt list, an impossible value such as `sort=no_such_field`), not one merely
  not yet adopted. When a later cycle makes X universal, the second kind fails for intended reasons and must be
  rewritten ([[CORE175]]: about 9 assertions across MCP, REST, CLI and unit tests).
- **An ordering mutation must defeat the index order too.** SQLite returns an unordered aggregate in the order of the
  index it scanned, so dropping `ORDER BY` from an embed stayed green on D1: the unique index on `(message_id, position)`
  already sorted the rows, however the seed inserted them ([[CORE25]] M7). Postgres turned red. To prove an `ORDER BY`
  on D1, order by a column no index covers, or pin the generated SQL in a unit test (`embed.test.ts`).
  An explicit collation needs a fixture with a conflicting stored default: a BINARY-default column stays green when
  `COLLATE BINARY` is removed. Use a real `NOCASE` column with `Z`/`a`, walk both directions one row at a time, and
  remove the override to prove both ordering and continuation comparisons (`knowledge/specs/012-CORE170-message-sort/RETRO.md`, M7).
  The same holds for equality: a "case-sensitive" lookup needs a differently-cased live row in the fixture. A spec or charter
  that states a column's case behaviour is a premise to test: [[CORE199]] D7 said tag names compare case-sensitively "as the
  unique index is", but `tags.name` is `NOCASE`, and only the `Consultancy`/`consultancy` fixture showed it
  (`knowledge/specs/013-CORE200-deal-filter-grammar/RETRO.md`, M5).
- **Checked-in prose that states a fact about the system needs a mechanical check.** A contract that checks the *set* of
  stated entries exactly (from real plans) but not their *reasons* leaves the reasons as unverified claims. [[CORE201]]'s
  `STATED_FILTER_COSTS` reasons named indexes and index shapes; two review rounds went to false ones (an audit of 142
  entries rewrote 30) and two were still wrong after it (#205). When a reason, description or note names a column,
  index, collation or nullability, derive it from the catalog (`pragma index_list`, `pragma index_info`, `sqlite_master`
  on D1) or test it against the catalog, both ways, as [[CORE201]] does for the collation sentence (`collation-text`).
  Prefer structured data (`{ kind, index }`) with the prose generated from it, so the text cannot drift from the check
  (`knowledge/specs/013-CORE201-filter-rollout/RETRO.md`).
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
- **A polling loop is tested through its injected clock, never real time.** The CLI's `--follow` sleeps through
  `deps.sleep` and stops on an optional `deps.signal` (`AbortSignal`, checked after each drain and each sleep); the
  test's `sleep` callback adds events to the fake feed and aborts on the nth call, then asserts the sleeps
  (`r.sleeps`) and every request's `after`. The absence mutation that matters is "poll from the original start"
  (duplicates → red) ([[API215]], `packages/cli/src/events-tail.test.ts`). For a file that must survive a crash, persist
  per item and prove it with a run that fails mid-way and a resume that reprints nothing.
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
- **A test that passes in the red run is vacuous until proven otherwise.** List every one in RESULT.md, then tighten it
  so it fails under the stub (assert the success status, `201`/`200`, before the absence it claims) or name the mutation
  that reddens it. [[CORE245]]'s "no CRM event" test passed in red on a `404`: it proved nothing until it asserted the
  create succeeded first.
- **Append-only tables in an emptied-between-tests database.** A `BEFORE DELETE ... RAISE` trigger (`control_audit`,
  [[CORE245]]) makes a plain `DELETE FROM` fail. `clearD1` (`packages/storage-d1/src/test/index.ts`) drops exactly the
  `BEFORE DELETE` triggers, empties, and recreates them from their stored `sqlite_master.sql`, all in one batch, so the
  schema after is the migrated one. Never disable a guard trigger in a fixture any other way; the trigger's own refusal
  test runs on the migrated schema.
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
- **A content scan over a built artifact is proven clean on a real build, not only on a fixture.** Fixture
  files hold none of the literals that bundled libraries carry: a literal `-----BEGIN` rule passed every
  fixture but would have refused every real Worker bundle, whose key parser contains `"-----BEGIN PUBLIC
  KEY-----"`; the rule became "header followed by a key body" with a test for the bare header ([[OPS210]],
  `packages/release/src/forbidden.ts`). Match the secret's shape (header plus body, prefix plus value), and keep
  the clean-pass case on the real output in the charter's run.
  The scan covers **source too, once a module is bundled**: when `vibase instance setup` pulled
  `scripts/setup/clerk-keys.ts` into `cli/instance.js` (now `cli/server.js`, [[OPS240]]), its error message `neither sk_test_… nor sk_live_…`
  failed `release:build`. The prose now assembles the prefixes at run time (`sk_${'test'}_`), with a comment
  naming the scan. A cycle that adds an import to a shipped bundle runs `release:build` in its gate ([[OPS232]]).
- **A bundle loaded at run time is proven by running the installed artifact.** Unit tests import the
  TypeScript source, so they cannot see a broken bundle. `cli/instance.js` (now `cli/server.js`) passed every suite. It then failed when installed,
  with "Dynamic require of ./impl/format": esbuild took `jsonc-parser`'s UMD `main` into an ESM bundle. The fix is
  `mainFields: ['module', 'main']`. Only `release:check`'s step that runs the installed `vibase instance` (now
  `vibase-server`) caught it ([[OPS231]], `packages/server-d1/scripts/instance/build.ts`). For every new bundle a
  release ships, run it from the install.
- **A release of several packages installs each into its own empty directory**, with `npm_config_cache` pointed at
  a temporary directory. One shared directory hides a client that pulls the server in; a shared cache can serve a
  stale copy. The absence mutations of `release:check` run on **repacked copies** of the tarballs, never on the
  recorded `dist/` pair, so the recorded run's artifacts and `SHA256SUMS` stay what RESULT.md cites ([[OPS240]],
  `packages/release/scripts/check.ts`).
- **"A secret is never printed" is tested with a fake child that fails and echoes its whole environment.**
  Assert that no value appears in stdout, stderr, any refusal or the generated files. The mutation that
  proves the test is one that writes a secret into the generated config ([[OPS231]],
  `packages/server-d1/scripts/instance/status.test.ts`).
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
    `.postgres.` infix must not import `@vibase/db`, `@vibase/storage-postgres` or `pg` directly; a boundary test fails it.
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
    lines ([[CORE25]]). `schema.json` records the whole `GET /meta/v1/schema` document ([[CORE187]]), so any migration,
    catalog text, registered resource, sort or stated sort cost regenerates it. Before claiming "golden unchanged",
    check for such derived values.
    Event payloads in a transcript are written in Postgres `jsonb` key order (shorter key first, then bytewise,
    `jsonbOrder` in `d1-backend.ts`), so a regeneration does not churn when a program builds a payload in a different
    order ([[CORE69]] D21 ruling).
    Tests that pin derived lists (the declared scopes in `identity-definitions.test.ts` and
    `messaging-definitions.test.ts`) also change when a scope is declared; fix them in the same change.
    The generator (`packages/api/scripts/golden.ts`) is open code under the import-boundary rule for `api/scripts`;
    the fixture list, scenarios and both backends are exported through `@vibase/api/test/golden` ([[CORE44]] P12).
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
  (`@vibase/api/test/messaging`) and `Engine.insert` (storage suites) or `kit.insert` (contract fixtures' `make`/`input`),
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
  to it and fails the rule that forbids `@vibase/db` in `api/src`. Vitest setup files are not in the package: the
  `postgres` project loads `packages/db/src/test-setup.ts` from `vitest.projects.ts`.
- **The root vitest config collects from the directory it starts in.** Its include globs are relative, and
  `configDefaults.exclude` does not cover `vendor/` (2000+ vendored test files), `.claude/` (other worktrees) or
  `knowledge/`; `EXCLUDE` in `vitest.projects.ts` lists them. When you add a project or glob, check it with
  planted files: put a `x.test.ts` under each of those trees and confirm `pnpm exec vitest list --filesOnly` at the
  root doesn't list it (OPS92 review; the normal file count proved nothing). Packages have no vitest config of their own:
  run a full package suite with `pnpm -C packages/<pkg> test` (the script passes `--config ../../vitest.config.ts`), never a
  bare `vitest run` in the package, which also collects `*.postgres.test.ts` and fails them (32 false failures in the
  [[CORE202]] review; `execute-cycle` §5).
- **Don't assert on a repo value that a routine change moves.** [[OPS237]]'s scratch `changeset version` test read
  the start version from the workspace `package.json`s and expected `0.1.0 → 0.1.1`. The first merged Version
  Packages PR would have turned it red on `main`. Before asserting on anything read from the live tree (the product
  version, a lockfile entry, the migration count, today's date), name the routine change that moves it. Then pin the
  value in the fixture (write `START` into the scratch copy) or assert the relation (`bumped = start + patch`). Prove
  it by setting the real value to something else and rerunning (`knowledge/specs/014-OPS237-release-ci-docs/RETRO.md`).
  The same goes for a third-party name that drifts by major version: `changesets/action` v2 calls its publish input
  `publish-script`, so the shape test matches `/publish/i` rather than one exact key.
  The same holds for a scratch copy of a repo directory: copy only the inputs the test means to exercise. The scratch
  `changeset version` test copies all of `.changeset/`, so a branch's own changeset changed its outcome in [[OPS265]]
  (fix: copy `config.json` only, #271).
- **Synthetic Google recordings redact by length** (`xxxxx@xxxxx.xxxx`). Renaming a test host or address changes the
  recorded fixtures: rerun `recordings:generate` and update the expected redacted strings; the diff should be
  email-shaped hunks only (`knowledge/specs/015-OPS265-remaining-vibase-names/RETRO.md`).
- **A boundary comment needs a boundary fixture.** A test that says "exactly the limit is allowed" must seed values that
  reach the limit exactly; [[CORE202]]'s summed a single `0` (#208). And a guard against a numeric limit computed in the
  engine runs after the engine's own arithmetic: `abs(sum(x)) > 2^53−1` never sees an int64 overflow, because `sum()`
  raises first (`knowledge/specs/013-CORE202-deal-aggregate/RETRO.md`).
- **A refactor that moves or splits tests proves it kept them with a test-name manifest**: the full
  `package + test name` list before and after (`vitest run --reporter=json`; not `vitest list`, which errors on
  the D1 suites, [[CORE199]]), diffed as a multiset, with every
  difference explained (OPS92: 2750 → 2761, each delta named). A green run alone can't show a test went missing.
- **A scripted rename also rewrites the tests that guard it.** Three things follow ([[OPS262]],
  `knowledge/specs/015-OPS262-vibase-rename/RETRO.md`). First, a red test that names the old string on purpose
  (`d.startsWith('@vibase/') || d.startsWith('@vault/')`) comes out of the rewrite as `X || X`: green, and no longer
  checking the old name. Leave red-test files out of the rewrite, and grep the diff for duplicated operands. Second, a
  guard keyed on the old name (`config.name === 'vault'`) whose test fixtures were renamed with it passes only if
  both changed. One absence mutation per guard (put the old string back) is the only proof the guard still
  bites. Third, a mutation can show the guard has no test at all: in OPS262, `scripts/instance/config.ts`'s
  resources-only refusal left 91 instance tests green. Add the missing case in the same cycle.
- **Verify from a fresh database, and run the suite twice in a row.** A suite that passes only on the second
  run depends on leaked state.
- **A test never spawns a real external tool** (wrangler, npm, a CLI that talks to a provider). Inject the runner
  (`InstanceDeps.runWrangler`, `fetch`) and use the fake. A test of the *real* deps path (`realDeps`, `runInstance`
  with no runner override) must stop before the spawn for a reason the test itself sets up, and must not hand the
  child anything that would let it write: no `CONFIRM_REMOTE=1` unless the case needs it. Do not assume a package
  directory in a temp dir has no tool. `pnpm test` exports `NODE_PATH` (`node_modules/.pnpm/node_modules`), so
  `createRequire(<tmp>/package.json).resolve('wrangler/…')` falls through to the repo's real wrangler. In [[OPS234]] a
  "wrangler cannot be resolved" test did that and spawned a real `wrangler d1 execute --remote` with the kit's fake
  token. It failed auth and wrote nothing, but it reached Cloudflare. To make resolution fail, plant a nearer
  `node_modules/<tool>/package.json` with no `bin` (`packages/server-d1/scripts/instance/main.test.ts`), and check
  the red run's output for a real child's stderr before you trust it.
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
- **`@vibase/api` runs its files in parallel ([[OPS223]]).** The `engine-neutral` and `d1` projects allow file parallelism (each file
  has a private in-memory D1 in its own forked process) and `packages/api`'s `test` script sets 4 workers; every other package stays
  at the root's `maxWorkers: 1`. The `postgres` project stays serial (`fileParallelism: false`, `vitest.postgres.config.ts` has
  `maxWorkers: 1`; `packages/storage/src/test-config.test.ts` asserts both). The api suite takes about 4.5 to 6 minutes (276 to 339 s; 971 s serial) and
  must be alone on the machine; on a loaded one run `VITEST_MAX_WORKERS=N pnpm -C packages/api test` with a lower N and name N in
  RESULT.md. Vitest rejects a second `--maxWorkers` flag, so use the variable. A new test file must not rely on running
  alone: no fixed ports, no files under the repo, no `process.env` another file reads.
- **Run the heavy suites one package at a time.** `packages/api` (the `contract.integration.d1` file especially), `packages/cli`
  and `packages/server-d1` interfere when they run side by side on the development machine. You get hook timeouts at
  10000 ms, `ECONNRESET`, a `deployment.singleton` collision and off-by-one query counts in `measured-limits.test.ts`, and
  a different test fails on each rerun ([[CORE133]] gate). For the gate, run `pnpm -C packages/<pkg> test` serially. A
  failure seen only in a parallel run is contention: rerun that package alone before you treat it as a regression.
- **Other sessions load the machine too.** Check `uptime` before a gate: AGT166's R1 gate ran at load average 20–36 on
  8 cores (parallel agent sessions), and full suites hit 10000 ms hook timeouts that never reproduced. Record the load
  in RESULT.md, don't raise a timeout, and settle the gate with one clean serial run on a quieter machine (in a sprint,
  a fresh verify-only agent); only that run counts. Under load the golden replays also fail with Miniflare `fetch failed`
  ([[CORE187]] review: load ~16 failed, ~9 passed with no code change); treat it the same way.
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
test and reads or writes zero rows in production. The vault's pool (`createTestDb()` from `@vibase/db/test`)
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
  from `src/test/contract.ts`). There are **two runs**: Postgres over `createVibaseRegistry()`, and D1 over a
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

  To add a resource, register its definition in `createVibaseRegistry` and add one entry in
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

**Preact components: prove rendered attributes in a real browser.** Preact removes an attribute whose JSX value is
boolean `false`, which happy-dom suites asserting the prop shape miss. Enumerated attributes (`spellCheck`,
`draggable`, `contentEditable`) are written as `"true"`/`"false"` strings (spec [[UI254]] D2). The gallery E2E
(`packages/ui/e2e/gallery.e2e.ts`) asserts the browser *property* (`input.spellcheck === false`). An identity
case that tells Preact from React cannot inspect elements: `preact/compat` stamps `$$typeof` on vnodes. Check the
`react` module's React-only exports instead (`packages/ui/src/runtime.ui.test.tsx`).

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
- **A scenario that carries a session across steps shares one browser context.** Playwright gives each `test()` a
  fresh context, which drops the cookie the previous step signed in with: create one `browser.newContext()` in
  `beforeAll` and run the file serially (`test.describe.configure({ mode: 'serial' })`;
  `packages/server-d1/e2e/auth-pages.e2e.ts`, [[UI246]]).
- **`page.goto` to a URL that differs only in its `#fragment` does not reload the page**, so a page that reads the
  fragment on load never sees the new value. Go through `about:blank` first (that spec's `visit()`).
- **Use `getByLabel(text, { exact: true })`**: the default substring match also hits a section whose accessible
  name contains the label (`New password` matched "Set a new password").
- **A scenario that runs the real `vibase login` runs the Worker over HTTPS.** The CLI refuses a non-https issuer
  (`insecure_issuer`) and has no local override. Use:
  - `wrangler dev --local --local-protocol https` and `PUBLIC_BASE_URL=https://localhost:<port>`;
  - the CLI with `NODE_TLS_REJECT_UNAUTHORIZED=0` and private `HOME`/`XDG_*` directories (reuse them for a
    follow-up `vibase me get`);
  - `browser.newContext({ ignoreHTTPSErrors: true })`.
  (`packages/server-d1/e2e/oauth-pages.e2e.ts`, [[UI247]].)
- **Better Auth trusts only `PUBLIC_BASE_URL` as an origin.**
  - Open the pages at exactly that origin.
  - Give server-side `request` calls to `/auth/oauth2/register` and `/auth/oauth2/token` an `Origin` header.
  - A live session makes `/auth/oauth2/authorize` skip `/sign-in`, so a signed-out leg signs out same-origin
    first, never from the client's callback page.
  - Mind its per-IP limits: 5 `GET /auth/device` per 30 minutes, and a short sign-in window. Count calls or use
    a fresh Worker.
- **Local setup:** `wrangler d1 migrations apply DB --local` and `... apply CONTROL_DB --local` before `bootstrap` (it writes the control marker, CORE259); in `.dev.vars` write the
  `CLERK_JWT_KEY` PEM on one line with `\n` escapes. Delete every DCR client the run creates through BAPI by
  its application id (`DELETE /v1/oauth_applications/oa_…`), not its client id.
