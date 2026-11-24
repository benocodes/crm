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
  stub the module so the assertion itself fails. A stub that throws `not implemented` is the same non-red in
  disguise: every row fails on the throw, not on what it asserts; called at module scope (a definition built at
  import), it fails the whole file at load ([[CORE315]]). A fixture built at import by today's validator, which refuses
  the input the cycle adds, fails the file at load the same way ([[CORE541]]): build it in `beforeAll` or behind a
  function the tests call, so each test goes red on its own. Make the stub return a plausible wrong answer
  (exit 0, no runner calls) so each row's own assertion turns red ([[OPS487]]'s `runRedeploy` stub threw, and
  only the absence mutations showed its rows could fail). **Paste the red run into the cycle's RESULT.md when you
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
- **A constant that both the code and the test derive from gives a vacuous mutation.** Mutating it moves both sides together
  and stays green ([[CORE549]] M6). Mutate the function that uses the constant (drop one mention), or assert against a
  literal in one place, so only one side moves.
- **Some sites have no observable absence mutation, and the reason is the construction.** A site that applies a rule
  can be one whose only consumer reads something the rule never produces. [[API518]]'s scope closure at dispatch
  eligibility fed only an `events:read` check, and the closure never adds `events:read`. Removing that closure
  changes nothing a test can see. Run the mutation, record it green in `RESULT.md` with that reason, and point to the
  sibling site whose mutation does turn red. Do not build a test that cannot fail. A reviewer accepts the record. A
  site whose mutation stays green **without** such a reason is still unproven.
- **A "this is gone" test is red only if it is committed before the removal.** When the red commit also `git rm`s the
  file, the test never fails on its own; prove it instead by restoring the file from `main` and seeing it turn red
  ([[UI448]]: restoring `src/test/subset.ts` turned `the old Preact subset scan is gone` red). Likewise a "something
  unused is absent" check needs a sentinel nothing will ever use: [[UI448]]'s components started using cycle 1's
  "unused" classes (`bg-primary`, `bg-destructive`), and two reused bundle tests had to be repointed
  (`packages/ui/scripts/react-build.test.ts`, `gallery-react-bundle.test.ts`).
- **Commit the green implementation before the first mutation.** Restoring a mutant with `git checkout <file>` (or
  `git restore`) resets the whole file to the last commit, so it also deletes any uncommitted real work in that file:
  [[CORE188]]'s mutation session reverted the uncommitted green `executions/definition.ts` this way and the coder had
  to rewrite it (`knowledge/specs/013-CORE188-execution-sort/RETRO.md`). Commit green first and restore from that
  commit. If you cannot, save the green file before mutating (a copy in the scratchpad that you copy back, or
  `git stash push -m <unique tag> -- <file>` followed at once by `git stash apply`, so the tagged stash stays as the
  backup). Never bare-checkout a file that holds uncommitted changes you mean to keep. The rule is not
  mutation-only: [[CORE199]]'s coder lost uncommitted work the same way mid-run, outside a mutation (see
  `execute-cycle` §3, "Setting work aside").
- **A mutation is an edit of the code or the page under test, never a test case.** A test that matches a pattern
  against a string literal (`expect('verify retries inside a five minute bound').toMatch(/five minute/)`) passes
  whatever the product says and proves nothing; [[OPS496]] lost a review round to one standing in for its docs group.
  Edit the real file (there `self-hosting.md`), run the suite, paste the red lines, restore. A test that reads the
  knowledge repo (a recipe) must `skipIf` the path is missing: worktrees have no `knowledge/` clone ([[OPS494]]'s
  `docs.test.ts` recipe check).
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
- **A red run counts only when each test is red for the reason under test.** Read the failure messages, not the
  count: [[UI504]]'s red run had the clerk rows of `packages/server-d1/src/assets-serving.test.ts` red because the
  test's Worker env lacked `CONTROL_DB`, not because the asset path was served; the helper was fixed in the green
  commit. A test that is red for a harness reason would pass for the wrong reason once the harness is fixed, so fix
  the harness before recording the red run, and say so in `RESULT.md`.
- **A refusal the real producer cannot emit is proven on crafted inputs at the unit.** Better Auth signs with a key
  encrypted by `AUTH_SECRET`, so it cannot mint a token with a wrong `iss` or `aud`; [[CORE244]] proved those refusals
  (and their absence mutations) at the adapter on hand-signed Ed25519 tokens (`packages/api/src/auth/better-auth.test.ts`)
  and kept the composed workerd test for real tokens of each kind. A charter asking for such a mutation "in workerd"
  is asking for the impossible: ask for it at the unit, and for real-producer tokens at the composition.
- **A premise about a pinned library is proven green-first, with a control case as its teeth.** Library code cannot be
  mutated, so a test of what the library does (Better Auth's consent `scope` narrows the grant and re-prompts) is
  green on its first run by design. Pair each assertion with a control that takes the other branch through the same
  harness (consent without `scope`: the full set granted, the second authorize skips `/consent`), so the assertion
  cannot pass for the wrong reason; say "green on first run, control is the discriminator" in `RESULT.md`. Prove such
  a premise in a cycle before any page code depends on it ([[UI449]] cycle 1, group 3 of
  `packages/server-d1/src/oauth-default-scope-workerd.test.ts`).
- **An accept/refuse pair differs only in the field under test.** Both halves send a request the route would accept
  in full, and only the checked value changes; otherwise a later check (body validation, a missing header) can refuse
  the "refused" half for another reason, or keep the "accepted" half from reaching success. Assert the success answer
  exactly (`204`), not "not 401". [[API503]]'s audience pair first posted a body the push route would not accept with
  any token; the fix posts a valid `pushBody()` in both, `<base>/inbound/gmail` → `204`, `<base>/gmail/push` → `401`
  (`packages/api/src/rest/machine-paths.integration.d1.test.ts`).
- **A fake external provider sits at the network edge, never in shipped configuration** ([[CORE294]], [[UI246]] D9).
  In workerd, Miniflare's outbound service (`startWorkerd({ outbound })` in `packages/auth/src/test/harness.ts`)
  answers every subrequest, so the test also proves nothing else was called; the default throws. In Node, Better
  Auth's `betterFetch` reads the global `fetch` at call time: stub it for the one call and restore it after. Miniflare's
  `dispatchFetch` follows redirects, so a test asserting a `302` and its `Location` passes `redirect: 'manual'`
  (`Workerd.call(..., { manual: true })`). Read the provider library's source for every endpoint the flow calls
  before writing the fake; Google's redirect flow needs only the token endpoint.
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
  The same holds for `release:check`: its installed instance is uninitialised, so an unknown path there is the router
  gate's `503`, not the ready Worker's `404`. [[UI507]]'s charter asked it for the old app paths' `404`; it asserts
  "not served" (`404` or `503`, no `Location`) and `src/app-serving.test.ts` (now `src/static-serving.test.ts`, [[UI510]]) pins the `404` on a ready Worker (507.12).
  A charter that names an answer from `release:check` or a smoke states the phase it runs in.
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
- **A refusal order is proven only where two refusals' conditions hold at once.** One case per refusal shows each
  exists; a swapped order stays green. Add inputs that fail two checks (an agent on an unknown id, another member's
  disconnected row) and a mutation that swaps two checks and turns the test red. A charter obligation for an order
  names those overlaps ([[CHN409]] review round 1, `knowledge/specs/015-CHN409-connections-update/RETRO.md`).
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
- **An external write comes after every refusal, and each refusal proves it.** When a run can make a call with an outside
  side effect (registering a Cloudflare subdomain, a `PUT`), test one case per refusal that can still fire after the value
  is known (a later flag check, a preflight failure) and assert the fake's write log is empty, not only the dry-run case.
  A test of "the flag registers" alone passed while the `PUT` ran before the Gmail refusal and the preflight ([[OPS308]]
  review, `packages/server-d1/scripts/setup/workers-dev.test.ts`, `instance/setup-workers-dev.test.ts`). Resolution reads
  and derives from the planned value; the write is its own step.
- **A fake that answers for a real component is tied to it by a test.** When a kit fakes what the Worker answers
  (discovery, metadata), build the fake from one module of answer builders and add one test that composes the real
  Worker in-process (`composeD1Worker`) and compares its answers with the builders. Every kit then uses those builders.
  The fake cannot drift, and no E2E is needed for that seam ([[OPS306]],
  `packages/server-d1/scripts/setup/better-auth-answers.test.ts`).
- **When a mode change makes every harness need new setup, change the kit's default, not each test.** [[CORE326]] made a
  paired control database mandatory for every Worker; instead of editing ~25 suites, `openWorkerD1()` in
  `packages/server-d1/src/test/kit.ts` opens a migrated control database that pairs itself from the CRM deployment row,
  and the kit's `composeD1Worker` fills `CONTROL_DB` unless the env names it (even as `undefined`, which is how a test
  asks for the missing-binding case). The behaviour the default hides is then proven once with no auto-pairing
  (`openWorkerPair` in `src/control-plane.test.ts`) and once on the real `wrangler.jsonc` (`better-auth-wrangler.test.ts`).
  The instance kit does the same (`validSettings` carries `control_d1`, `noControlSettings` does not). Import from the kit;
  composing straight from `src/compose.ts` in a test now fails closed.
  [[CORE356]] did the same for keys: the kit's `bootstrapD1` wraps the real one and defaults `control` to the pair of an
  `openWorkerD1` binding, so a bootstrapped key lands in control; import `bootstrapD1` from the kit in server-d1 suites,
  not from `src/bootstrap-d1.ts`. `control_audit` is append-only, so a bootstrap now adds an `api_key.created` row to
  every log: a suite that pins an exact audit log bootstraps with `unauditedControl` (its audit inserts do nothing)
  rather than filtering the row out.
- **Docs that quote program text are checked against the program's constant.** The docs test imports the constant,
  never retypes it, so editing the constant turns the docs check red. A check that the docs "do not promise X yet" can
  only search for names (`owner-reset`, `workers.dev`). A paraphrase ("the owner recovery tools need it") passes it, so
  the reviewer reads the prose too ([[OPS306]] review, `packages/server-d1/scripts/instance/docs.test.ts`).
- **A same-second pin anchors to a whole second, on every run.** When a bound compares timestamps that may be stored
  at different precisions (ISO ms, SQLite seconds), the test that proves millisecond comparison puts all its instants
  inside one second by construction: `T = (Math.floor(anchor / 1000) + 1) * 1000 + 100`, then `T + 300`, `T + 600`.
  An offset from an arbitrary instant (`anchor + 10`) straddles a second boundary in about a third of runs, so a
  second-precision mutation goes red only by luck. Prove it with the mutation (compare at `slice(0, 19)`) turning the
  test red. A strict "created after" bound also gets a tie pin: same millisecond ignored, +1 ms accepted ([[CORE302]],
  `packages/server-d1/src/readmit-removed-member.test.ts`).
- **A polling loop is tested through its injected clock, never real time.** The CLI's `--follow` sleeps through
  `deps.sleep` and stops on an optional `deps.signal` (`AbortSignal`, checked after each drain and each sleep); the
  test's `sleep` callback adds events to the fake feed and aborts on the nth call, then asserts the sleeps
  (`r.sleeps`) and every request's `after`. The absence mutation that matters is "poll from the original start"
  (duplicates → red) ([[API215]], `packages/cli/src/events-tail.test.ts`). For a file that must survive a crash, persist
  per item and prove it with a run that fails mid-way and a resume that reprints nothing.
- **A Miniflare D1 test cannot park one query to race a second request.** Kysely's D1 dialect holds one connection
  mutex, so a query held mid-flight (a stubbed insert awaiting a promise) blocks every other query on that database:
  the test times out at 30 s instead of failing an assertion. Race the real entry point against state set up by hand
  (CORE304 registers the waiter the in-process caller would register, then sends the real HTTP request) and prove the
  test with an absence mutation (`packages/server-d1/src/self-service-reset.test.ts`, [[CORE304]]).
- **A rate-limit window is pinned with a clock, not a burst.** N+1 requests in a row prove the count, not the window: a
  mutation from one hour to one minute stays green. Fake `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`), move past the
  library default and assert still refused, then past the window and assert served again. Better Auth's window slides
  from the last allowed request, not the first ([[CORE304]]).
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
- **A recording shows only states the provider lets you create.** Clerk's Backend API creates every admin-added email
  address already verified, so an unverified primary cannot be recorded on the dev instance. Derive such a case from a
  recorded body by changing only the one field (`verification.status: 'unverified'`), and say in RESULT.md which cases
  are recorded and which are derived ([[OPS365]], `packages/server-d1/scripts/fixtures/clerk-users.json`).
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
- **A guarded assertion (`if (cond) expect(...)`) can pass with no assertion at all.** In a table over several
  subjects, a subject whose fixture never reaches the guarded state passes silently. Assert the precondition
  (`expect(asked).toHaveLength(1)`), or prove each subject in its own suite with a fixture that reaches it ([[OPS493]]
  review: two of four commands refused before the question and passed).
- **A hand-off round trip runs the next command with the words the first one printed**, never a hand-written argv. A
  command that ends by printing the next command (`init` → `setup ... --dry-run`) is proven by splitting that printed line
  and running it: a hand-written argv supplies what the printed one omits and hides it ([[OPS494]] review: the printed
  `setup` command lacked `--auth`, so a `clerk` file would have been set up as Better Auth, while the test passed
  `--auth clerk` itself).
- **An `it.each` row whose body `return`s early is a green case that asserts nothing.** Filter the row out of the list
  and say in a comment where its property is proven instead ([[CORE565]] review: deals in the per-table refusal matrix,
  `packages/api/src/custom/adversarial-guards.integration.d1.test.ts`).
- **A test that passes in the red run is vacuous until proven otherwise.** List every one in RESULT.md, then tighten it
  so it fails under the stub (assert the success status, `201`/`200`, before the absence it claims) or name the mutation
  that reddens it. [[CORE245]]'s "no CRM event" test passed in red on a `404`: it proved nothing until it asserted the
  create succeeded first.
  A refusal regex that the *old* refusal or usage text also matches passes in the red run for the same reason: assert
  a phrase only the new guard prints (`provider switch is not committed`, never `apply`/`--dry-run`), and a negative
  match on the old text ([[OPS392]], [[OPS393]]).
- **A check inside a loop over returned records passes on an empty answer.** Assert what came back (the seeded ids,
  or a count) before looping over the records to check their fields: [[API516]]'s matrix checked `preview` was
  absent in every listed message and would have passed on an empty page (review round 1).
  The same holds for a static scan over files (migrations, sources): "no file breaks the rule" passes when the
  matcher stops matching. Assert the scan saw the known targets first ([[CORE555]] review: the D10 migration rule
  now asserts it found the four `CREATE TABLE`s and the `organizations` cascade target).
- **Append-only tables in an emptied-between-tests database.** A `BEFORE DELETE ... RAISE` trigger (`control_audit`,
  [[CORE245]]) makes a plain `DELETE FROM` fail. `clearD1` (`packages/storage-d1/src/test/index.ts`) drops exactly the
  `BEFORE DELETE` triggers, empties, and recreates them from their stored `sqlite_master.sql`, all in one batch, so the
  schema after is the migrated one. Never disable a guard trigger in a fixture any other way; the trigger's own refusal
  test runs on the migrated schema. Its table order comes from the migrations, so it cannot know a `__c` reference
  column an applied `extend` adds between built-ins: a fixture that applies one nulls those columns before `clearD1`
  (`packages/api/src/test/extension-kit.ts`, `resetKit`; [[CORE559]]).
- **No assertion that only keeps a binding used.** `expect(u.id).toBeTruthy()` on a freshly seeded row passes
  whatever the code under test does ([[CORE29]] review). If the seeded id is not needed, drop the `const`
  (`await seedUser(...)`); if it is, assert something the code decides.
- **Assert the exact thing the spec attributes.** An event's `actor_id` equals the calling principal's id,
  never `not.toBe(someoneElse)`, which passes for almost any value ([[CORE15]] review). When a spec
  attributes a write to a principal, *every* path that writes it asserts the attribution on each event, not
  only one ([[CORE29]]: repair tests checked `actor_id`, reconcile tests checked only event types).
- **A refusal titled "writes nothing" snapshots after every refusal it makes**, not only the last one. A
  check of the state from before the call proves nothing ([[CORE40]] review).
- **A test titled "accepts", "validates" or "parses" runs the validator on the input**, and on one input it must
  refuse. Comparing a generated schema with its checked-in copy proves the file is current, not what it admits: a
  [[CORE561]] test said the JSON Schema "accepts the sample `extend` file" and only checked equality. The fix
  `safeParse`s the sample (true) and an out-of-set key (false); dropping `extend` from the schema then turned 3
  tests red (`packages/server-d1/src/schema-file-json.test.ts`).
- **A token ban proves a renamed name is gone, not a renamed key.** A rename guard (a source scan with a literal
  allow-list, `packages/storage/src/schema-file-name.test.ts`) cannot ban an ordinary word such as `objects`. Prove the
  docs stopped teaching an old key by parsing their samples with the shipped parser: in [[CORE569]] review,
  `self-hosting.md` still showed `{"version":1,"objects":{}}`, and the guard was green. The check that caught it is in
  `packages/server-d1/scripts/instance/docs.test.ts`. A test proving the old name is *refused* must contain the
  banned token: give that line an allow-list entry with its reason, never build the string by concatenation to dodge
  the guard.
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
- **A source scan for a path literal matches the path, not the substring.** UI476's no-`/connect` scan
  (`packages/server-d1/src/ui/no-connect-default.test.ts`) matches `/connect` as a whole segment and skips a
  regex literal and an escaped slash (`/connect an agent/`, `\/connect`), and counts a host-qualified `https://h/connect`;
  it carries an explicit allow-list that pins how many mentions each file has (a new mention, or a stale entry, turns it red),
  and the absence mutations restore the old default and add a link in an app file. From UI479 it also reads `e2e/`, the
  README, `clerk-setup.md`, `.dev.vars.example`, `wrangler.jsonc`, the docs content and the release templates, and matches a
  host-qualified `https://h/connect`; skills and AGENTS.md get a dead-artefact check instead (no citation of a deleted file).
  **The same rule holds when you rewrite a path with a search, not only when you scan for it.** Moving the app pages
  ([[UI507]]) by a quoted-literal pattern over the tests was wrong in two kinds of place: a regex literal (`/\/home$/`)
  that the pattern missed, and an API URL that merely ends in the segment (`/meta/v1/agents` checked with
  `url.includes('/agents')`), which it would have rewritten. Match the whole quoted path, then read each hit; the
  suites caught both, but only because every touched file was run. Moving the auth pages ([[UI510]]) added a third
  kind: the path URL-encoded inside a query (`return_to=%2Fdevice`) or with an escaped slash (`\/device`); five tests
  went red on the first full run. Grep for `%2F<segment>` and `\/<segment>` too.
- **A build that stops producing an asset directory deletes it.** `dist/assets/` is gitignored and survives
  between builds, so `wrangler dev` and a deploy would keep serving the removed page from a stale copy; UI476's
  `pnpm build` starts with `rm -rf dist/assets/connect`, pinned in `packages/server-d1/scripts/build.test.ts`.
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
- **An idempotence test re-runs after a first run that altered existing state, not only from empty.** A second run
  over freshly created tables reads back exactly what the first run wrote; a second run after `ADD COLUMN` reads a
  catalog the first run reshaped (SQLite appends the added column's text to the table's `sqlite_master.sql`), and
  that is where a parser of live state misreads and re-plans. CORE542's review round 1 added "additions to an existing
  table, then re-apply plans nothing" and "a kind change on an added column is still refused"
  (`packages/api/src/custom/apply.integration.d1.test.ts`).
- **A pinned behaviour is a spec decision.** Tests assert the contract the spec writes down (statuses,
  codes, messages, event order). Where a spec keeps a rule, the shipped code is a reference for reading it,
  never an oracle to compare against: there is no legacy-oracle fixture ([[CORE36]] D12, no backward
  compatibility). Where the spec is silent and a cycle pins existing behaviour, record that as a decision
  ([[CORE35]] D22).
- **A rule JSON cannot carry is proven on the validator, not over REST.** A value no JSON body can hold intact (a
  non-finite number: `1e999` parses to `Infinity` and re-serialises as `null`) never reaches the handler as itself, so
  a REST matrix row for it tests the `null` rule instead. Prove it with a unit test on the shared zod schema and say so
  in RESULT.md ([[CORE318]], `packages/api/src/storage/additional-props.test.ts`).
- **A "no content in the log" test forbids the error's own message too.** A hand-written forbidden list misses text the
  runtime supplies: [[CORE571]]'s list held the seeded subject, sender and body but not the `DOMException` message
  (`Invalid character`), so the mutation "append `err.message` to the line" stayed green until it was added. Seed
  distinctive content, add the thrown error's `message` to the forbidden list, spy every console method, and run the
  mutation that leaks the message (`packages/api/src/channels/gmail/channel.test.ts`).
- **Untrusted nesting is tested at 5,000 and 50,000 levels**, with the bound pinned on both sides (exactly at it keeps
  structure, one past it flattens or ignores). Node's stack overflows between 1,000 and 2,000 levels of recursion, so
  a test at a few hundred proves nothing; run the deep case in workerd too (`smoke:worker`), because its stack differs
  ([[CORE571]], `packages/api/src/channels/gmail/mapper.test.ts`, smoke checks X1 to X4).

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
    The same shape serves two front-ends of one rule (`scripts/owner-reset.suite.ts`, [[OPS307]]). A case that only
    one entry has is registered conditionally from an argument the entry passes at collection time
    (`if (opts.dryRun) it(...)`), never an early `return` inside the test body, which reports a pass for a test that never ran.
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
    catalog text, registered resource, sort or stated sort cost regenerates it. Operation descriptions are not in any
    golden (the fixtures are scenario transcripts), so a description-only change regenerates nothing ([[CHN423]] 423.11).
    The OpenAPI record schemas are in no golden either. A record-schema change (a field made optional) regenerates
    `schema.json` only if the schema document itself changes ([[API514]]).
    Before claiming "golden unchanged",
    check for such derived values. To prove a change leaves the default registry identical, hash its derived surfaces
    (both OpenAPI documents, the MCP tool list, declared scopes, operation and event-type names) in a throwaway test
    before the first change and again at the end, and quote both hashes in RESULT.md ([[CORE315]] P3). Until #323 is fixed, `golden:check` fails on a clean `main` (committed fixtures are
    Biome-formatted, the generator's output is not): judge drift by `golden:generate`, then `pnpm format`, then
    `git diff -- packages/api/fixtures/golden`, and say so in RESULT.md (CORE347).
    The **wire snapshot** (`packages/api/fixtures/wire-core554/`, `src/resources/wire-snapshot.rest.integration.d1.test.ts`,
    [[CORE554]]) holds SHA-256 digests of both OpenAPI documents, the MCP tool list, `schema.get` and the golden text, plus
    error bodies for contacts, companies, deals and tasks. Any deliberate change to a schema on those surfaces (a merge
    response gaining a key) turns it red, and a grep for the operation's name does not find it. Re-pin with
    `WIRE_SNAPSHOT=write pnpm -C packages/api test src/resources/wire-snapshot.rest.integration.d1.test.ts`, explain each
    moved digest by diffing `WIRE_DUMP_DIR=<dir>` dumps from `main` and the branch, keep `errors.json` as committed unless an
    error body changed (the writer emits it unformatted: 3,000 lines of churn), then `pnpm format` ([[CORE556]] gate-fix).
  - A **dormant general mechanism** (kept with no production caller, e.g. the per-type `owner` predicate in the
    event-type map after CORE347) is proven through a test-only registration on the test kit's registry, plus one
    assertion against the real registry that no production entry uses it, so a later caller is a deliberate choice
    (`packages/api/src/events/owner-predicate.integration.d1.test.ts`).
  - A **caller below a level no scope grants yet** can be tested on the real paths. Raise the real definition's reveal
    scope inside the test (for example to `messages:write`) and restore it in `afterEach`. A caller with the read scope
    but not the raised one is then below the level, and no production file needs a test hook
    (`packages/api/src/storage/content-projection.integration.d1.test.ts`, [[API514]] 514.24).
  - A **no-caller test** (a dormant cycle's "no non-test module calls X") matches a use, never the bare name: an import
    specifier or a call (`/\bX\s*\(/`, `/import[^;]*\bX\b/`), or the sources with comments stripped. A substring grep is
    turned red by a comment naming X, and the only fix that keeps it green is rewording the comment ([[CHN428]]: a header
    comment naming `formIngressRead` failed the gate, `packages/api/src/forms/ingress-read.integration.d1.test.ts`).
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
- A "concurrent callers share one X" test must make the callers **really overlap**: a stub that resolves at once
  plus per-call async setup (signing a token) serialises them, and the test passes with the sharing removed. Do the
  setup before `Promise.all` and make the stubbed dependency slow (a short `setTimeout`), then prove it with the
  absence mutation of the sharing ([[CORE577]] M8 survived the first version).

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
- **A refusal test that aims a write at the checkout removes that path in `afterEach`**, even though the code under
  test should refuse it. Its own absence mutation (or a regression) does write the file, and the stray file then fails
  every later run for an unrelated reason: [[OPS365]]'s M2 (drop the "inside the repo and not git-ignored" check) left
  `packages/auth-plan-ops365-test.json` behind and the rest of the first mutation pass was void
  (`packages/server-d1/scripts/auth-migrate-remote.test.ts`). Run `git status --short` after a mutation pass.
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
- **Dates and times in tests are relative to now, never literal.** A test, fixture or E2E script that carries a
  fixed date ("2026-10-22", `Date.parse(...)`) rots the day it falls outside a window the product measures from
  the real clock (the Gmail backfill's 30 days, token and invitation expiry, "recent" filters, retention).
  It then fails with no code change, and the failure looks like a product bug: `e2e:webhook-example` and
  `e2e:gmail-send` timed out waiting for a capture because their fixture message had aged past the backfill
  window (#520). Derive every date from `Date.now()` (a day before, an hour after) at call time. Pin a literal
  date only when the test is about that exact value (a parser, a formatter, a golden); say why in a comment,
  and prefer an injected clock where the code takes one. Fixture helpers must default to now-relative dates.
- A full-suite failure that reproduces standalone is a real bug, not contention. If it only fails in the
  full run, rerun once; to tell "my change broke it" from "it was already broken", revert your diff against
  the clean tree and rerun. A pre-existing failure belongs in a follow-up, not in your commit.
- Never run two suites against one database at once (`pgrep -f vitest`); run the `db` and `api` suites
  serially. Inside a package, Vitest 4+ has no `poolOptions.forks.singleFork`: use `pool: 'forks'` with
  `fileParallelism: false`.
- **D1 tests reach D1 through the request transport ([[OPS338]], OPS340).** `openLocalD1` (`packages/storage-d1/src/test/`) returns handles that send one HTTP
  request per statement or batch to a harness Worker in the same Miniflare, instead of Miniflare's `mf.getD1Database` handle (one workerd round trip per method
  call, blocking). Values and errors cross unchanged (parity test `transport-parity.test.ts`); the connection is the harness's own bounded keep-alive `node:http`
  agent (16 sockets, never the global `fetch`, so a test may stub `fetch`). Consequences: a `Promise.all` over statements **really overlaps** now, so a race the
  old handle hid can surface (diagnose it: never serialise, retry or loosen the test; a product race is a bug issue; pin it with a **deterministic** test beside the repeated one, which forces the losing interleaving and asserts the outcome, as OPS340's #343 calls `acceptInvitation` and `revokeInvitation` twice with the same `now` in `packages/storage-d1/src/control-invitations.integration.test.ts`: a race that fails 6 runs in 25 is evidence it exists, not an absence mutation a reviewer can rerun once), and a test must not assume two un-awaited
  statements run in the order written. When a failure might be the transport's, rerun the file with `VIBASE_TEST_D1_TRANSPORT=binding pnpm -C packages/<pkg> test <file>`
  (today's handle); an unset variable or `request` is the default, any other value throws; `openLocalD1(names, { transport })` overrides the variable. Harnesses that call
  `mf.getD1Database` themselves (`@vibase/auth`'s, the release check, the smoke and E2E scripts) stay on the binding transport.
- **Every D1 package runs its files in parallel ([[OPS223]], [[OPS338]]).** The `engine-neutral` and `d1` projects allow file parallelism (each file
  has a private in-memory D1 in its own forked process) and the `test` scripts of `packages/api`, `server-d1`, `storage-d1` and `cli` set 4 workers; the
  root default stays `maxWorkers: 1`. The `postgres` project stays serial (`fileParallelism: false`, `vitest.postgres.config.ts` has
  `maxWorkers: 1`; `packages/storage/src/test-config.test.ts` asserts both, and each package's worker count). Alone on the machine, on the request transport (below), api takes about
  105 s, server-d1 about 130 s, storage-d1 about 13 s and cli about 10 s (OPS340 runs; on the binding transport 382, 376, 24 and 15 s; 971 and 973 s serial for api
  and server-d1), the whole gate about 5 minutes (OPS340's two green gates: server-d1 122 to 132 s, api 87 to 100 s, the other packages about 30 s, typecheck, build and lint about 35 s), and each must be alone; on a loaded one run `VITEST_MAX_WORKERS=N pnpm -C packages/<pkg> test` with a lower N and name N in
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
  ([[CORE187]] review: load ~16 failed, ~9 passed with no code change); treat it the same way. At still higher load
  the gate **hangs instead of failing**: [[CORE350]]'s first two gates, at load 40–65 from macOS system processes
  (StorageManagement, contactsd, fseventsd; no agent sessions), churned in the `packages` step (server-d1) for 80+
  minutes; the same sha was green in about 5 minutes at load about 18. Don't start a gate above load ~30; a gate past
  20 minutes is a hang to kill and rerun once the load drops, never evidence about the code.
- **Event order.** See "Assert emit order" in section 6; never order by `id` in a test.
- **Known flake: `packages/server-d1/src/measured-limits.test.ts`** is intermittently off by one on pinned query counts,
  on clean `main` too ([[CORE62]], [[API32]], [[API63]], [[CORE69]] on `merge-100-links`; issue #79). Until #79 lands, when it fails, record the scenario
  names and counts in RESULT.md and rerun once; don't loosen `EXPECTED_QUERIES`.


## 6. Backend (`packages/api`) tests

**Real Postgres, no mocking the context.** Integration tests call the app in-process
(`app.fetch(new Request(…))`), seed through the same helpers production code uses, and assert DB rows
directly. Unit tests only for pure helpers.

**A lying header needs a Proxy.** A `Request` computes and guards `Content-Length`, so a body over a cap with an
understated length cannot be built directly; wrap the request in a `Proxy` whose `headers` getter returns the lying
`Headers` and forwards everything else (`body` stays the real stream). A body with no length at all is a
`ReadableStream` body (`duplex: 'half'`). Both prove a cap enforced while reading, not only from the header
(`packages/api/src/forms/ingress.integration.d1.test.ts`, [[CHN429]]).

**A value another module queries is asserted through that module's read, not by selecting the column just
written.** [[CHN428]]'s tests checked the tag links' stored `a_type = 'contact'`, `b_type = 'tag'` and passed, while
every association read matches table names (`contacts`, `tags`); only [[CHN432]]'s E2E (`contacts?tag_id=` empty)
caught it. When a write produces an association type, status, channel or key that a read path filters on, at least
one test reads it back through the public surface (`GET /contacts?tag_id=…`). A row-level assertion may stay beside it,
but it pins the literal, it does not prove the contract (`packages/api/src/forms/submission.integration.d1.test.ts`).

**`startWorkerd`'s `extra` options are a shallow spread** (`packages/auth/src/test/harness.ts`, [[CHN432]]): a key given
there (`bindings`, `d1Databases`) replaces the harness's own instead of merging with it. Pass keys the harness does not
set (`ratelimits`, `r2Buckets`), or repeat its values in full.

**The test pool behaves like production: nothing is preset.** The predecessor's test pool presets
`app.organization_id` and `service_role` globally, so a query that skips its tenancy wrapper passes every
test and reads or writes zero rows in production. The vault's pool (`createTestDb()` from `@vibase/db/test`)
connects as `vault_app` and presets nothing, every fixture names its organisation, and a query without a
wrapper fails in tests. Seeds (`seedOrganization`, `seedUser`, `seedAgent`) run under `withServiceRole`;
there is deliberately no task or event seed: create those through the service layer. `createOwnerTestDb()`
is for `truncateAll` and catalog inspection only, never fixtures. Both factories refuse a database whose
name doesn't match `/(^|_)test(_|$)/`.

**Moving data to another store: the kit guards the old tables.** When a cycle moves reads and writes off a table
that stays in the schema (dropped later), make the test kit itself throw on `reset()`/`close()` if the old table
holds a row, rather than adding an "old table empty" assertion per test: every suite on the kit then proves "nothing
writes there any more", including suites nobody remembered to touch ([[CORE337]] D10, `openWebhookKit` in
`packages/api/src/test/webhook-kit.ts`; its red run turned 136 tests red on the old code at once).

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

  A create that also writes another resource's row **on the same id** in its unit (a form's agent principal) sets
  `createAlsoEmits` on its fixture (the extra event types, in order, before `<name>.created`); the suite asserts the
  exact type list, so never loosen the one-event check instead ([[CHN420]] 420.29). An update or delete that also
  writes that row sets `updateAlsoEmits` / `deleteAlsoEmits` the same way (the exact tail of the id's events before
  `<name>.updated` / `<name>.deleted`; [[CHN423]] 423.10).

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
- **Prove a browser-side client against the real handler without a browser** ([[UI297]],
  `packages/server-d1/src/app/session/better-auth-session.test.ts`). Drive the client's own module with a `fetch` bound to
  `composeD1Worker(env)`. That `fetch` resolves relative URLs against `PUBLIC_BASE_URL`, sends that origin as
  `Origin` (Better Auth checks it) and keeps `Set-Cookie` in a jar. This checks the request and response shapes the
  fake-`fetch` unit suite assumes, inside the gate. The browser E2E then only has to cover what needs a browser.
- **A fake for the Better Auth client returns the SDK's shapes.** `better-auth/client` (1.7.22) resolves
  `{ data, error }` on any HTTP failure (a refused sign-out is `error.status === 403`) and throws only on a network
  failure. Drive the real `createAuthClient` + `jwtClient` over a fake `fetch` and cover both failure kinds; a
  `try/catch`-only module passes a fake that throws and misses every refused call ([[UI388]],
  `packages/approvals-app/src/better-auth.test.ts`).
- **A page script is tested as a function of its effects.** Make the DOM entry `run(root, deps)` with `fetch`,
  `location` and config passed in; only the thin entry file reads build constants. Name the environment with a
  per-file `// @vitest-environment happy-dom` docblock so the root vitest projects run it ([[UI388]],
  `packages/approvals-app/src/app.test.ts`). For "this library is not in the entry chunk", check a marker string on
  the real build output and prove it with `splitting: false` as the absence mutation (`src/build.test.ts`).
- `truncateAll(owner)` lists every `public` base table from the catalog at call time (except Kysely's two), so a new table needs no harness edit.
- `beforeEach` is scoped to its enclosing `describe`. A second top-level `describe` in a file does not
  inherit the first one's reset; give it its own.
- Before API tests: `pnpm db:test:reset` (or `db:test:worktree`). Run: `pnpm -C packages/api test [file]`.
- For file downloads, assert a UTF-8 BOM on `response.arrayBuffer()` (`EF BB BF`), not `response.text()`:
  Fetch's decoder strips the BOM.
- Postgres `NUMERIC` comes back from `pg` as a string even when a `sql<number>` annotation says otherwise.
  Convert at the DTO boundary and assert actual JSON value types in route tests.

## 7. Browser E2E scripts (Playwright, Clerk)

**One React layer ([[UI447]]).** `@vibase/ui` and the pages run on real React everywhere; no build or test project aliases `react`. The shared project's
sentinel (`packages/ui/scripts/default-runtime.test.tsx`) turns red if `react` ever resolves to anything else, and a manifest guard
(`packages/ui/src/manifest-guard.test.ts`) refuses `preact`, `@preact/*` and `@testing-library/preact` in any workspace `package.json`.

**Enumerated attributes: prove the rendered property in a real browser.** `spellCheck`, `draggable` and `contentEditable` are enumerated
attributes, written as `"true"`/`"false"` strings, so a happy-dom assertion on the attribute or prop shape is not proof of what the browser does.
Assert the browser *property* in Chromium, as `packages/ui/e2e/gallery-react.e2e.ts:172` does (`input.spellcheck === false`).

**React, Tailwind and the pages' CSP** ([[UI445]]):
- **Only a browser run under the policy proves a page CSP-safe.** `react-dom` 19's minified bundle itself contains
  `createElement("style")`, so a string scan of the built bundle cannot tell (finding 445.13). The source scan
  (`packages/ui/src/test/react-scan.ts`) refuses `style` props, `<style>` and `dangerouslySetInnerHTML` in our code;
  the gallery run listens for `securitypolicyviolation` and CSP console errors, and an injected inline style
  (`E2E_GALLERY_MUTATION`) is its seen-failing proof.
- **Tailwind's `outline-none` removes the focus ring** that `focus-visible:ring-*` alone does not replace in every
  element; the gallery's Tab-and-screenshot check caught it. Assert a visible ring per focusable element.
- **`page.emulateMedia({ colorScheme })` flips the scheme at once; a CSS transition does not.** shadcn's `Button`
  has `transition-colors`, so for 150 ms after the flip it still shows light colours on a dark card, and an axe
  contrast check or a screenshot taken immediately fails (UI446 E2E run 1, auth-pages and oauth-pages step 3). The
  auth pages and the workspace app disable transitions on their mount (`[&_*]:transition-none!`, pinned in
  `scripts/build-ui.test.ts` and `scripts/build-app.test.ts` (the Vite page builds, [[UI489]]; a page build under vitest must force `NODE_ENV=production`, which `buildPage` does, or React's development build ships); the app's was added after its E2E hit the same failure,
  [[UI460]] 460.15); a page that keeps transitions waits for them to finish before axe or a screenshot. It is not a missing dark token:
  check the computed colour before and after a pause before editing the theme.
- **A colour axe catches after a click may be hover, not transition.** A Radix dialog portals outside the mount's
  no-transition wrapper, and Playwright leaves the pointer on the last button it clicked: [[UI459]]'s dialog axe step
  failed in dark on the hovered destructive button (459.32; the hover colour itself fails AA, #477). Before axe or a
  screenshot on a state reached by clicking, park the pointer away from controls (`page.mouse.move(0, 0)`); a fixed wait
  does not settle a hover.
- **"No horizontal scroll" does not prove a narrow layout.** A flex row whose content column is `flex-1` (zero basis)
  beside actions kept the page within 375 px while collapsing a `CommandBlock`'s `pre` to 0 px; axe and the scroll check
  were green ([[UI459]] review round 2). When a cycle puts new content in a shared row or flex component, the narrow-width
  leg asserts geometry: the content's measured width (`boundingBox()`, a floor such as 200 px or half the row) and that
  the actions' box does not overlap it. Seen red on the broken layout before it counts.
- **The workspace app's first paint waits on four reads** (discovery, session, `me.get`, the agents walk). Under a
  loaded machine `e2e:auth-pages` legs 11b and 11c each once timed out on Playwright's default 5 s while the shell
  still showed "Loading…" ([[UI467]], 467.16, not reproduced in isolation). A leg that waits for the app's first
  state passes an explicit timeout sized for that chain, not the default.
- **Axe sees only what is open.** A closed `<details>` keeps its region out of the accessibility tree, so axe on a
  page's default state passed while two open `ScopeList` disclosures, both named "Requested permissions", failed
  `landmark-unique` ([[UI455]] review 1). Run one axe check with every disclosure and collapsible open, and give a
  component that renders a named region a `label` prop when a page may render it more than once.
- **Assert what a forced control sends, not only its checked state.** [[UI455]]'s "Write forces Propose" mutation
  stayed green on a page suite that checked `aria-checked` until a test asserted the Allow body.
- **Radix's Switch (and Checkbox) inside a `<form>` render a hidden bubble `<input aria-hidden>`** with an inline
  `style` set through CSSOM: `PAGE_CSP` and axe pass, but a keyboard check that counts focusable `input`s counts it
  though Tab skips it. Exclude `[aria-hidden="true"]` from Tab-stop selectors (`packages/ui/e2e/gallery-react.e2e.ts`,
  [[UI449]] 449.22). Component suites that run axe in happy-dom need `axe-core` as a `@vibase/ui` devDependency.
- **A Radix modal (`AlertDialog`, `Dialog`) portals its content and hides the rest of the page.** Query and run axe on
  `document.body`, not the render container, and wait for the dialog role before asserting focus. In happy-dom, axe's
  `aria-hidden-focus` flags the focusable controls Radix's `hideOthers` marks `aria-hidden`/`data-aria-hidden` behind the
  dialog, and its focus guards: exclude `[data-aria-hidden]` in the unit check and keep a real-browser axe run on the whole
  page with the dialog open as the proof (`packages/ui/src/components/confirm-dialog.ui.test.tsx`, [[UI458]] 458.23).
- **`userEvent.setup()` installs its own `navigator.clipboard`**, replacing a `vi` stub of `writeText` made before it,
  so a Copy test asserts on a stub nothing calls. Stub after `setup()`, or click with `fireEvent` ([[UI443]] 443.39,
  the `CommandBlock` suite).
- **A gallery or test mount root must not be a landmark the component renders too.** `<main id="root">` around an
  `AppShell` that renders its own `<main>` fails axe's landmark rules in the browser, not in happy-dom; mount into a
  `<div>` ([[UI443]] 443.40; the app's `index.html` root is a `<div>`, pinned in `src/app/main.ui.test.tsx`).
- **Page suites on real React** live in the root `page-ui` project (`packages/server-d1/src/{ui,app}/**/*.ui.test.tsx`,
  no alias, [[UI446]] D3, [[UI460]] 460.12); a sentinel (`src/ui/react-runtime.ui.test.tsx`) turns red if the project ever
  resolves another runtime.
- **esbuild defaults `process.env.NODE_ENV` to `"production"` under `minify`**, so an absence mutation of the
  helper's define shows nothing on a minified build. Build unminified in that test to give it teeth
  (`packages/ui/scripts/react-build.test.ts`).

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
- **`locator.evaluateAll()` and `locator.count()` do not wait.** On a client-rendered page they run as soon as they are
  called and can read an empty list before React draws it ([[UI460]] E2E run 1, the app's nav). Wait for the first
  element (`await expect(locator.first()).toBeVisible()`) before reading the set.
- **Wait for a landing on its pathname, never a URL glob.** `waitForURL('**/app/home')` matches the whole URL, query
  included, and returns at once if the current URL already matches: `/sign-in?return_to=/app/home` satisfies it before
  any sign-in. Use `page.waitForURL((u) => u.pathname === '/app/home')` ([[UI461]] E2E fix round; paths from [[UI507]]).
- **An absence assertion (`toHaveCount(0)`) on a client-rendered page passes while it is still loading.** First wait
  for the read the absence depends on (`page.waitForResponse(...)`) or a sibling that must be present
  (`oauth-pages.e2e.ts` leg 6b, [[UI461]]).
- **Use `getByLabel(text, { exact: true })`**: the default substring match also hits a section whose accessible
  name contains the label (`New password` matched "Set a new password").
- **A scenario that runs the real `vibase login` runs the Worker over HTTPS.** The CLI refuses a non-https issuer
  (`insecure_issuer`) and has no local override. Use:
  - `wrangler dev --local --local-protocol https` and `PUBLIC_BASE_URL=https://localhost:<port>`;
  - the CLI with `NODE_TLS_REJECT_UNAUTHORIZED=0` and private `HOME`/`XDG_*` directories (reuse them for a
    follow-up `vibase me get`);
  - `browser.newContext({ ignoreHTTPSErrors: true })`.
  (`packages/server-d1/e2e/oauth-pages.e2e.ts`, [[UI247]].)
- **A change to a redirect or landing page greps every E2E script for the old URL** (`grep -rn "waitForURL\|toHaveURL"
  packages/*/e2e`) and runs each script that matches. The scripts are not in the gate: #375 moved the post-sign-in landing
  to `/connect`, fixed `e2e:auth-pages` only, and `e2e:oauth-pages` leg 0 stayed red until [[UI381]]'s E2E paid for it.
  A cycle that edits an existing script runs it unchanged once first, so a leg already broken on `main` is told apart from
  its own; when the branch run is green on every leg there is nothing to attribute and the `main` run may be skipped
  ([[UI476]]).
- **A fit property ("the button is visible without scrolling") is proven in the browser at named viewports**, never by a
  CSS-rule test alone: measure the element's bounding box against the viewport at the page unscrolled (1280×720 and
  390×844 in `oauth-pages.e2e.ts`'s `foldCheck`). [[UI381]]'s CSS suite passed a fixed `10rem` scope cap that left Approve
  21 px below a 720 px fold; a viewport-relative cap (`clamp(6rem, 18vh, 10rem)`) fixed it. The unit suite pins that the
  rule exists; the E2E proves it fits.
- **Better Auth trusts only `PUBLIC_BASE_URL` as an origin.**
  - In a Vitest harness (no TLS), use `http://localhost:<port>` as that origin: Better Auth accepts `https://` or
    `http://localhost` only. A CLI test that needs the control database gets `openControlDb` from
    `@vibase/server-d1/test` (`packages/cli/src/audit.integration.test.ts`, [[CORE261]]).
  - Open the pages at exactly that origin.
  - Give server-side `request` calls to `/auth/oauth2/register` and `/auth/oauth2/token` an `Origin` header.
  - A live session makes `/auth/oauth2/authorize` skip `/sign-in`, so a signed-out leg signs out same-origin
    first, never from the client's callback page.
  - Mind its per-IP limits: 5 `GET /auth/device` per 30 minutes, and a short sign-in window. Count calls or use
    a fresh Worker.
- **Set the config's `timeout`.** Playwright's default is 30 s per test; a step that waits out a rate limit or
  starts Chrome dies mid-run with a misleading failure (`playwright.auth-pages.config.ts`, [[CORE294]] review).
- **A third-party sign-in leg stops at the provider's door.** Shipped configuration has no switch to point Google
  elsewhere ([[UI246]] D9), so route `accounts.google.com` with `page.route`, assert the captured navigation
  (`redirect_uri`, `scope`, no secret in any part), and prove the callback in workerd against a fake provider.
- **Never write "Playwright" in a non-test file under `packages/server-d1/src/`**, comments included:
  `scripts/build.test.ts` scans `src/**/*.ts` (except `*.test.ts`) for `/playwright/i` and `@clerk/testing`, and a
  test-only entry under `src/test/` is scanned too. Say "browser E2E". Run that file in the affected tests when adding
  anything under `src/` for an E2E ([[CORE304]] gate round).
- **An E2E that needs a different Worker configuration (bindings, vars, entry) is its own script** with its own
  Playwright config and fresh local state, like `e2e:oauth-pages` and `e2e:auth-pages-reset`: each consumes the single
  owner invitation, so two scripts cannot share one local state. Capture outbound email with a test-only entry that
  wraps the real Worker module and replaces `env.EMAIL` with a recording binding (`src/test/entry-email.ts`, read back at
  `/__emails`).
- **`webServer.reuseExistingServer: true` uses whatever already listens on the port**, and the block's `env` is then
  never applied. A stray `:8788` from another run, built for a different API origin, makes `e2e:approvals-app` test
  the wrong build. Stop stray listeners first (`lsof -i :8788`) ([[UI388]]). Two `wrangler dev` processes at once
  need distinct inspector ports: give the second `--inspector-port=9230`.
- **An E2E that drives a shipped remote command through a test-only driver lists every seam the driver fakes.** The
  driver's file header names each swapped dependency (database handles, `exec`, `deploy`, config reader, `git`, `run`,
  env-file writers, http instead of HTTPS) and what the real run must therefore check by hand; that list becomes the
  runbook's manual checks. A seam faked but not named was [[OPS397]]'s review finding
  (`packages/server-d1/e2e/auth-migration-driver.ts`, decision 397.18).
- **Stop the local Worker around a Node command that opens its persisted D1 state**, then restart it: two processes
  writing one local SQLite file contend ([[OPS397]], 397.15).
- **Seed state the UI cannot create by running the real program in-process**, not SQL that imitates it: run the
  operation's batch through `getPlatformProxy` against the script's persisted local D1, as the user it belongs to.
  A program `@vibase/api` does not export is imported from `../../api/src`; any raw adjustment after it is test-only and
  recorded as a decision (`packages/server-d1/e2e/seed-connection.ts`, [[UI468]] 468.20).
- **`connections.sync` refuses `501 provider_not_configured` before it reads the connection** when the Worker has no
  Google config or `MAIL_SYNC`, so an unconfigured Worker never answers `409` or `202`. Test those on a second Worker
  with Google env and a fake `MAIL_SYNC` binding (`packages/server-d1/src/app/accounts/accounts-real.test.ts`, 468.15).
- **A Worker that switches provider mid-run gets its Clerk sessions from the Backend API**, not `@clerk/testing`:
  `POST /v1/sessions` with the user id, then `POST /v1/sessions/<id>/tokens`, and send the JWT as a bearer; the dev JWT
  carries the session-token claims (`vibase_role`). Keep Playwright for the pages the scenario asserts ([[OPS397]], 397.14).
- **A test Worker entry that re-creates composition config passes every field `compose.ts` passes.** `src/test/entry-mint.ts`
  builds its own `/auth` handler; when it omitted `defaultScopes`, the default scope list silently fell back to the ceiling
  and its tests proved the wrong configuration ([[CORE330]]). When you add a field to the auth config in `compose.ts`, add
  it to every test entry in the same commit.
- **A local E2E script owns its state.** It keeps every D1 file in a `mkdtempSync` directory removed at the end:
  `--persist-to <dir>` on both `d1 migrations apply` calls and on `wrangler dev`, `persist.path` for an in-process
  `getPlatformProxy` (bootstrap, owner-only setup), and the Worker's variables from a script-owned `--env-file`. It never
  reads, deletes or rewrites `packages/server-d1/.wrangler/state` or `.dev.vars`: they are the developer's dev database
  and secrets ([[CHN432]] review, `packages/server-d1/scripts/e2e-forms.ts`). **Standing exception, until #474:** the
  Playwright scripts whose recipe runs `bootstrap` and `e2e/seed-connection.ts` (`e2e:auth-pages`, `e2e:auth-pages-reset`,
  `e2e:oauth-pages`, `e2e:accounts-connect`) use the package's default `.wrangler/state` and `.dev.vars`, because those
  tools take no persist directory; they run only in a cycle worktree (its state is its own), never in the main checkout
  ([[UI469]], 469.9, 469.14). A new script joins that family only if it needs those tools; otherwise it owns its state.
- **Local setup:** `wrangler d1 migrations apply DB --local` and `... apply CONTROL_DB --local` before `bootstrap` (it writes the control marker, CORE259); in `.dev.vars` write the
  `CLERK_JWT_KEY` PEM on one line with `\n` escapes. Delete every DCR client the run creates through BAPI by
  its application id (`DELETE /v1/oauth_applications/oa_…`), not its client id.
- **A remote E2E that signs in through a browser (`smoked1`) uses a browser of its own**, a fresh Playwright or
  `agent-browser` context, never the user's Chrome: Chrome holds the user's own `smoked1` session, and [[CHN433]]'s tester
  had to sign the user out to sign in as the throwaway owner. Plan the secrets hand-off before the run: the harness's
  permission classifier refuses an agent reading a generated password or an `owner-reset` link from a scratchpad file to
  type it into a browser, and the link lives about 5 minutes (#437), so the first attempt expired while waiting for a human
  approval. Issue the link only once the browser step is cleared to run straight after it.
- **Cloudflare's always-pass Turnstile test secret (`1x0000000000000000000000000000000AA`) passes any non-empty token**
  (`success: true`, `hostname: "example.com"`), despite the docs' "only the dummy token": a probe on 2026-11-18 passed
  `wrong`. A wrong-token refusal cannot be shown against it; the always-fail secret (`2x0000000000000000000000000000000AA`)
  answers `invalid-input-response`. Refusals are proven with a fake verifier (`packages/api/src/forms/turnstile.test.ts`,
  `ingress.integration.d1.test.ts`; [[CHN433]] 433.11).
- **The always-pass Turnstile site key (`1x00000000000000000000AA`) hides what a browser test would look at:** it
  issues one constant token, and its iframe sits in a closed shadow root. Prove the render by the widget's hidden
  `cf-turnstile-response` input, and a reset by counting `turnstile.reset(<widget id>)` calls (a wrapped
  `window.turnstile`), never by "a new token" or the iframe. Render explicitly (`?render=explicit`) inside a
  `<dialog>`, after `showModal()` ([[DX422]] 422.38, `knowledge/specs/016-DX422-makelinks-contact-form/harness/run.mjs`).
- **Chromium adds `pragma` and `cache-control` headers to a request Playwright routes**, so a "no
  custom headers" assertion allows exactly those two beyond the browser's standard set ([[DX422]]).
- **On macOS Chromium a real Ctrl+click opens the context menu and Alt+click downloads**, so neither reaches a page's
  click handler. Prove modifier-click handling with dispatched `MouseEvent`s (each of `ctrlKey`, `metaKey`,
  `shiftKey`, `altKey`, and `button: 1`), asserting `defaultPrevented` and the page's state, plus real Meta and
  Shift clicks ([[DX422]] 422.35).
- **A shell harness sets its cleanup `trap` right after `mktemp`**, before any step that can fail, so a file it
  copies into the worktree (a script that needs workspace imports, copied under `packages/<pkg>/scripts/`) or its
  temp dir never outlives a failed run ([[DX422]] review).

### Scripts

The browser E2E scripts. None is in the gate; each file's header holds its recipe. The Clerk ones use the
Clerk dev instance and `.env.dev` only (AGENTS.md, "Environments"). `e2e:rail` runs against a deployed
instance, so it is in `ship-branch`, "Command reference".

**Checks outside the gate rot unseen.** `scripts/gate.sh` runs the suites, typecheck, build and lint only. The E2E scripts
below, `smoke:worker` and `release:check` are not in it, and `main` can stay red on them across several merged cycles:
`release:check` failed from OPS249 (#464) and `smoke:worker` aborted at 25b from CORE283 (#295, #334) until [[UI460]]'s
charter asked for both. So a cycle whose charter names one of these:
- runs it on a clean `main` worktree first and records that result (the same rule as an edited E2E script, above);
- cites the issue when `main` is red, or opens one (`open-issue`);
- proves its own legs past the shared failure: an uncommitted, restored bypass of the one failing assertion, with the
  decisive lines quoted, or the `ok` count before a shared abort set against `main`'s (UI460's RESULT.md has both).
A red `main` is not this cycle's to fix, and not a reason to skip its own legs.

**A decisive assertion that needs an env value expects it set.** A leg whose check depends on a secret or a bootstrap
output (`E2E_AGENT_KEY` in `e2e:agents-clerk`) `expect`s the value at the top of the leg; an `if (env)` around the
check passes for the wrong reason when the value is missing ([[UI479]], 479.16).

Known traps in the scripts below:
- `e2e:action-requests` is not re-runnable on one `.wrangler/state`: a second run fails legs 7-8 on the first run's
  pending action requests. Reset the state between runs (479.18).
- `e2e:mcp-oauth` is red on `main` past leg 2 until #481 (the Clerk dev instance's DCR refuses the vault's scopes);
  a cycle that names it proves its own legs past leg 2 by the rule above.
  **Clerk dev instance setup it depends on** (decision 481.1): every vault custom scope (46 today, `packages/api` scope
  catalogue) must be defined in the Clerk dashboard (OAuth applications > Scopes) as Advertised, and listed in Settings >
  "Allowed scopes for dynamic clients" (the default scopes can stay the 10 reads). A new vault scope must be added there
  too, else leg 2 fails with `InvalidClientMetadataError: Invalid scope requested`.
- `smoke:worker` aborts after check 43 on `main` (#505, `getaddrinfo ENOTFOUND push.test` at the connect-callback
  call). Bypassing that leg reaches the page and asset legs (24b-24e), then a second abort at the better-auth legs
  (25b+, "a bootstrap with an agent ... requires CONTROL_DB"), so those stay unproven until #505 is fixed ([[UI504]]).
  A bypass can expose the next failure: quote which legs it actually reached.
- `e2e:auth-pages` leg 11e (Agents) reads the headings before the list loads and fails on `main`, so legs 12 and 13
  never run (#508); a cycle that names it proves legs up to 11d and says 12-13 are unrun ([[UI504]] 504.27).

```bash
pnpm -C packages/ui e2e:gallery-react             # the React/Tailwind gallery (UI445) built with @vibase/ui/build, served on 127.0.0.1:4174: the components page `/` under PAGE_CSP and the composites page `/composites` (UI443, `?view=parts|shell|shell-bare`) and the lists page `/lists` (UI458: ResourceList, StatusBadge, ConfirmDialog, ListEditor, ChoiceGroup; `?view=dialog-*` opens a dialog state at load) under APP_CSP, each its own bundle under the 100 KB gzipped budget (lists.js 97.1 KB, composites.js 88.9 KB at UI458: a new heavy composite needs its own page or a budget ruling); four theme modes, axe zero violations, focus ring, skip link, Copy, the 375 px row, zero CSP violations; its seen-failing proof is built in (no env var): a leg injects a `<style>` and an inline `<script>` at runtime, the `<style>` must violate PAGE_CSP only and the script must be blocked on both pages; not in the gate
pnpm -C packages/server-d1 e2e:auth-pages          # the Better Auth pages /invite, /sign-in, /reset-password (UI246), Google buttons (CORE294), a trusted app origin (UI255) and, from UI460, the workspace app (steps 8-10 also fetch the bundles' files at `/assets/ui/` and `/assets/app/` and assert the old `/ui/` and `/app/` file paths `404`, UI504; steps 10-12: `/`, `/app`, `/app/` 302 /app/home and the old `/home`, `/accounts`, `/agents`, `/connect` 404 (UI507), the signed-out card, the shell with APP_CSP and axe in both themes, 375 px, sign out) and, from UI467, Connected accounts (11c: `/app/accounts` lists, Connect Gmail's 501, the connect return removed; 13: signed-out `/app/accounts` returns there after sign-in); local Worker on better-auth, fresh local state, recipe in the file header; not in the gate
pnpm -C packages/server-d1 e2e:oauth-pages         # Better Auth /device and /consent with the real `vibase login` and an MCP-style client (UI247); local Worker over HTTPS (`wrangler dev --local-protocol https`, recipe in the file header and writing-tests §7), no Clerk; `e2e:auth-pages` is UI246's sibling; not in the gate
pnpm -C packages/server-d1 e2e:accounts-connect      # the connect return and Home's Connect your email prompt (UI469): its own Worker with the Gmail core four set and no CONNECT_RETURN_URL (Gmail on would flip e2e:auth-pages' 501 legs), Google answered by a Playwright route, the callback's refusal returns real; fresh local state, recipe in the spec header; no Clerk; not in the gate
pnpm -C packages/server-d1 e2e:auth-pages-reset      # self-service reset by email on /sign-in (CORE304): its own email-on Worker from the test-only entry src/test/entry-email.ts (a recording EMAIL binding read at /__emails), over HTTPS, fresh local state (recipe in the spec file header); no Clerk; not in the gate
pnpm -C packages/server-d1 e2e:approvals-app      # the approvals app (:8788, started by the config) signs in, approves and signs out through Better Auth against a local better-auth Worker on :8787 that the operator starts (UI388); E2E_INVITE_URL from bootstrap; recipe in e2e/approvals-app.e2e.ts; no Clerk; not in the gate
pnpm -C packages/server-d1 e2e:auth-migration     # the hq auth migration end to end (OPS397, OPS394): the real `auth:migrate:remote` plan, apply, claim and revert through a test-only driver (e2e/auth-migration-driver.ts: local D1 pair, fixed Time Travel bookmark, `deploy` = restart the local Worker on the committed record's provider) against the Clerk dev instance (users and sessions by the Backend API, keys from `.env.dev`, E2E_DEV_ENV_FILE may name it), then a claim link opened in the browser; own temp state, removed at the end; recipe in the spec header; E2E_BROWSER_CHANNEL=chrome if Playwright's Chromium is not installed; not in the gate
pnpm -C packages/server-d1 e2e:forms               # a website form posted to the real Worker under `wrangler dev --local` (CHN432): real Turnstile siteverify with the always-pass test secret (needs network; it passes any non-empty token, so the script proves no wrong-token refusal), live `ratelimits` bindings, owner-created form in-process; own temp state and env file, removed at the end; no browser, no Clerk; not in the gate
pnpm -C packages/server-d1 e2e:agents-clerk        # the Clerk-only legs on /app/home and /app/agents (UI479, paths UI507): Account Portal round trip, owner Disable/Enable, agent role, member, sign out; Playwright + @clerk/testing against a local Worker and the Clerk dev instance (.env.dev only, E2E_AGENT_KEY from bootstrap); same harness and config as the two below; not in the gate
pnpm -C packages/server-d1 e2e:mcp-oauth          # MCP OAuth end to end (DCR, consent, delegated agent, revocation) on the Clerk dev instance; same harness, not in the gate
pnpm -C packages/server-d1 e2e:metadata-scope     # messages:read_metadata live (API516): Miniflare Worker on better-auth with an auth_jwks key seeded from @vibase/api/test/better-auth (minted tokens verify), messages captured in-process over FakeGmail (not the MAIL_SYNC leg), agents A/B/C over REST, MCP, the feed and webhook deliveries, delegated agent D's narrowed token; own temp dir; no browser, no Clerk; not in the gate
```
