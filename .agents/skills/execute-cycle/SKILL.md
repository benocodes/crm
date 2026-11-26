---
name: execute-cycle
description: How to implement one cycle from its charter (PLAN.md or a plan-only <ID>.md) - worktree and private test DB, surveying the code yourself, red tests for every obligation, green implementation, the gate, RESULT.md evidence, commits and the CYCLE REPORT. The coder agent follows it in a sprint; any agent implementing a cycle outside a sprint follows it too. Use whenever you start or resume implementing a cycle.
---

# Execute a cycle

The charter ([[tdd-cycle-generator]]) says **what** this cycle delivers and **what must be proven**. It
does not say how. You survey the code, design the change, write the tests and implement them. Everything
here is the fixed procedure around that work. Read `AGENTS.md`, the charter, the spec it implements
(`implements:`), and the area skills for every area you touch:

- any test → `writing-tests`
- schema or migrations → `db-schema-and-migrations`
- routes, operations, resources, services, integration tests → `api-routes`
- pool, RLS or Hyperdrive → `hyperdrive-pg-rls`
- Workflows, Queues, scheduled sync → `cloudflare-workflows`

## 1. Worktree, branch, private test DB

Do all code work in a worktree. The main checkout is shared with other sessions, and switching its branch
moves them onto yours. Give the worktree its own test DB too: a shared test DB plus a concurrent
`db:test:reset` produces fake deadlocks and "column does not exist".

```bash
git worktree add .claude/worktrees/<cycle-id-lowercase> -b <type>/<issue#>-<slug> main   # from local main
cd .claude/worktrees/<cycle-id-lowercase>
pnpm install
pnpm db:test:worktree
```

If the brief names an existing worktree, use it. Every later command runs from the worktree. An agent's `cd` does
not persist between tool calls, and Write/Edit take whatever path they are given: give every file path as an absolute
path under the worktree, and before the red commit check `git -C <main checkout> status --short` is clean ([[UI458]]
cycle 1 wrote its first red files into the main checkout).

`.env` is gitignored, so a new worktree has none. The guarded remote scripts (`db:status:remote`,
`db:migrate:remote`, `deploy:remote`, `smoke:remote`) read the `.env` at the root they run from
(`ROOT_ENV_PATH` in `packages/server-d1/scripts/remote.ts`). Before running one, link the main checkout's file
with `ln -s ../../../.env .env` from the worktree root. Never copy it, and never print it ([[CORE61]] retro).

**A deliverable outside the repo** (a folder agents may not write, with no git of its own): copy it into your
scratch space without `node_modules`, build output and every `.env*` but `.env.example`, `git init` and commit a
baseline, make and prove the change there, and deliver `git diff --binary` as a patch in the cycle folder, with its
harness beside it so the reviewer and e2e-tester run what you ran. Run last, on the final patch: `git apply --check`
on a fresh `git archive` of the baseline and `patch -p1 --dry-run` in the live folder (read-only). A later edit to
the patch is made in a re-applied copy and regenerated the same way, never by hand in the patch file. The crm
branch then carries no code, so there is no gate to run ([[DX422]] D2).

## 2. Survey before you write

- **Before you start the work, read what was already decided** (before the survey, before any test): `node scripts/decisions.mjs find <the cycle's issue> --related`
  prints the planner's spec and plan decisions for this cycle, and the parent spec's and sibling cycles' rows.
  They bind you as the spec does: don't decide again what a row settles, and a row you think is wrong is a
  `blocked` (or, for an earlier coder's row, a new row with `--supersedes <ref>`), never a silent deviation.
- **Every item under "In this cycle" is scope, "Carried" one-liners included** (a stale comment, a measurement): do
  it, or record a row saying why not. A skipped one with no row costs a review round ([[CORE543]] 543.29). A row
  does not move scope to another cycle: only the planner defers. An item stated as a property ("every path that
  emits ...") covers the paths its list did not name; do them, or report `blocked` ([[CORE559]] 559.9, overturned at
  review by 559.22).
- **Adding a module to the Worker's import graph** (a `Text` or data module): grep `packages/*/scripts` and test
  harnesses for every esbuild bundle of `worker.ts` and run `smoke:worker` before review ([[CORE543]]: five bundlers).
- Read the modules the cycle changes or calls, their tests, and the shared test helpers and seeds. Reuse
  helpers; find the seam to test at. Don't call a helper you haven't opened.
- **When the cycle migrates existing behaviour, the old code is the reference** for "matches today's
  behaviour". A deliberate change needs a spec decision; a question about one is a `blocked`.
- **Before adding a table, a grant or a scope, grep for exact-list assertions** that pin whole lists:
  `migration-001`'s table list, `migration-002`'s `vault_authenticated` grants, `tenancy`'s list of inserts
  that must fail `42501`, `declaredScopes()` catalogs, `bootstrap`'s default agent scopes. Grep
  `packages/*/src` for `toEqual([` near `table_name`, `grants(`, `declaredScopes`, `scopes` and `42501`. In a
  `migration-NNN` test, **delete** the broken assertion (never rewrite an earlier migration's test to the
  new shape); in a catalog test over the current registry, **update** the list ([[CORE27]]: the plan named
  two such lists, the run found three more).
- **Cross-check a column-level grant against every writer of the table**, not just the resource's own
  operations: merges, cascades and programs from other areas ([[CORE25]]'s link-table grant missed
  merge's re-point).
- **Grep the whole package, not just `src/`, when the charter changes how something is read or written.**
  `e2e/` and `scripts/` (smokes) are outside the gate, so a stale reader there stays green until someone runs it
  ([[API105]]: two `order by id`/`rowid` event readers in `packages/server-d1/e2e` and `scripts/smoke-worker.ts`
  were found at review). `scripts/*.test.ts` *are* in the gate but not in a `src/` grep: when a stored shape
  changes (an audit `detail`, a column list), grep `packages/*/scripts` for the old literal too ([[CORE248]]'s
  only gate-fix round was `packages/server-d1/scripts/bootstrap-invitation.test.ts` pinning the old
  `invitation.created` detail).
- **Before adding a value to an allow-list, grep the tests for that value as a literal.** A fixture may use it as its
  example of what is *not* in the list: `packages/server-d1/src/ui/continuation.test.ts` used `/agents` as a non-app
  path, and adding `/agents` to `APP_PAGE_PATHS` turned two tests red at [[UI459]]'s first gate. Move such fixtures to a
  value no spec plans.
- **A new CLI flag goes into every help and usage text that lists its command's flags**, not only the parser and
  the docs: grep the command's neighbouring flag (`--d1-name`) to find them. [[OPS279]]'s review round 1 was only
  this: `--control-d1-name` parsed and documented, missing from `INSTANCE_HELP`
  (`packages/server-d1/scripts/instance/main.ts`).
- **A command's help entry is about four lines**: the usage line, what it does, its risk stated plainly (not
  alarming, not hidden), and, for a power-user command, the guarded command to use instead; guards and exit codes in
  one line. Background, alternatives and other tools' commands go in the docs page. [[OPS487]]'s `redeploy` entry
  came out at six dense lines with a `wrangler rollback` aside and cost a user-requested round; the fix was four
  lines starting `Advanced:` and naming `upgrade` as the normal, guarded path.
- **A deletion's blast-radius grep is a floor.** Grep the deleted file's basename, its exports, and
  operation names as string literals; treat every surprise as a decision to make and record. A move or rename
  of an entry point is a deletion too: grep for importers of each export the old module had, since a default
  export nothing imports survives every suite ([[OPS240]] review).
- **A migration's number can go stale.** Check `ls packages/db/migrations | tail -3` (and the D1
  migrations folder) right before creating one.
- **Third-party APIs:** fetch the current docs before writing code that calls them. Invented endpoints,
  payload shapes and signature headers sink whole phases.
  **Check that the fetch reached the part you need.** A long reference page comes back truncated
  (WebFetch read the first 100000 of 113437 characters of Google's OAuth page and stopped before the refresh
  example, [[CHN149]]). When the section you rely on is missing, fetch it again by its anchor or a narrower
  page; if that fails too, list in `RESULT.md` which facts are unconfirmed and where they came from instead.
  Where the reference and common practice disagree (the history reference omits `labelIds` that real
  responses carry), parse the field when present and treat its absence as unknown, never as a value.
- **No speculative dependencies.** Prefer the platform and Node builtins. A new dependency gets its own
  commit.

## 3. Red

For every **Must be tested** obligation in the charter, write the test(s) that prove it, following
[[writing-tests]]:

- **Meet the obligation as written.** Where it names a column kind, an operand form or an exact status and code, the
  test uses that kind, form and code; a weaker substitute (a text column for a timestamp range, a 4xx range for an
  exact error) is a review finding. If the built-in schema lacks the case (no nullable boolean filter for `is: true`),
  build the table entry or fixture that has it. [[DX608]] lost its one review round to three such substitutions
  (608.15 to 608.17).
- **Implement the shape the spec states, not a stricter or looser one.** Where the spec names a type or contract
  (`a readonly array of field names`), the code uses exactly it; narrowing it (a non-empty tuple, to make an empty
  list a compile error) or widening it is a design change, so either follow the spec or record a decision row saying
  why, before review. [[DX616]] lost its one review round to an unrecorded narrowing (616.15).

- Run each new test file alone and see it fail **for the reason the behaviour is missing**, not an import
  error. Commit the red tests, and append the red run's output to `RESULT.md` **at the red commit**.
- **The red commit comes before any implementation commit, even in a mechanical cycle.** If a test cannot
  load without part of the change (a new module's constants, a required type field), put the smallest stub
  that lets it import into the red commit, so the assertions fail rather than the import. [[API32]]'s coder
  built exactly that stub (a constants-only `surfaces.ts`) but ran it in a throwaway worktree against `main`
  and folded the tests into the implementation commit, so the branch history no longer shows red before green.
  That is a recorded deviation, not an equivalent. [[AGT8]] cycle 1 wrote its tests beside a working draft and
  made the red commit by setting the draft aside: two suites then failed on a missing module, not on their
  assertions, and the reviewer had to run a manifest mutation to see them go red. [[CORE283]] wrote five of six
  groups' tests after the code and had no red commit at all. [[API518]] wrote a nine-file grammar change first.
  It then made the red commit by setting the source files aside and stubbing one helper with today's behaviour,
  which is the accepted repair, but review still had to check it. Write the tests first. If you did not, say so per
  group in `RESULT.md`'s Deviations, and give every such group a raw absence mutation that turns *that group's*
  tests red; a group with neither a red run nor its own mutation is not proven, and the reviewer returns it.
  That includes pure-function groups (a mapper, a matrix of inputs): [[CHN428]] mutated only its integration groups
  and lost a review round on the submitter matrix, the mapper and the first-submission group. Before reporting, check
  that every "Must be tested" bullet has a red run or a mutation listed under its name. A charter line that says
  "every X in every state" (a gallery, a fixture set) is a grid: write it out (component × state, marking the states
  a component does not have) and check each cell before reporting; [[UI448]] lost a review round to a disabled
  CodeInput missing from the gallery.
- **Setting work aside never uses a bare `git checkout <file>` / `git restore <file>`.** Either resets the
  file to the last commit and silently deletes every uncommitted change in it; it cost [[CORE188]] (restoring a
  mutant) and again [[CORE199]] (mid-run, outside any mutation) a rewrite; [[UI455]] did it a third time with a
  directory (`git checkout -- src/ui`), which resets every file under it. Before you revert, split or compare
  a file, commit what you mean to keep (a WIP commit is fine; squash it before the red/green commits if it
  would blur them), or copy the file to the scratchpad. To look at `main`'s version use `git show main:<path>`
  or a throwaway worktree, never a checkout over your edits. Check `git status --short` before any
  checkout or restore.
- **No bare `git stash` / `stash pop` in a worktree.** The stash list belongs to the repository, not the
  worktree: every cycle worktree and the main checkout share it, so `pop` or `apply` without a name takes
  whoever pushed last. [[CORE639]]'s coder popped another session's stash into its branch (a conflict and a
  stray file to repair by hand). Use a WIP commit or a scratchpad copy; if you stash at all, give it a unique
  message and apply it by that message (`git stash apply "stash^{/<tag>}"`), never by position.
- A migration's test goes red against the old schema **before** the migration exists (vitest runs
  untyped, so missing generated types don't block the run). Only then write the migration, run codegen
  and change the seeds ([[CORE3]] cycle 1).
- Obligations marked "absence mutation" are proven after green (step 4).
- Use recorded payloads under the package's `test/fixtures/` for channel adapters, never synthetic data.
- A fixture must pass the runtime validator it goes through (zod schema, guard), not just the type.

Test commands: `pnpm -C packages/<pkg> test [file]`, `pnpm -r test`. Never `npx vitest`.

## 4. Green, then prove strength

Implement until the tests pass. Then run every absence mutation the charter names, plus any you judge
necessary: inject the fault, see the named test turn red on the named engine, restore. Keep the **raw**
output (filtered to the failing test names and messages, saying what you filtered) in `RESULT.md`. A table of
outcomes ("M3 → red: yes") is not raw output: paste each mutation's `FAIL` lines and its `Tests` summary line under the
mutation's name ([[CORE660]] review round 1 re-ran all eleven).

**Decisions.** Where the spec and charter are silent on something the tests pin (an error code, a
payload field, an ordering), decide it, prefer what existing code does, and record it when you make it, not at
the end: one row per decision in the decisions log, which the reviewer and later cycles read by issue number,

```bash
node scripts/decisions.mjs add --issue <the cycle's issue> --by coder --stage code [--id D-a] "<the decision, one sentence>"
```

then list it in `RESULT.md` (with the `ref` the command printed) and your report. `add` has no duplicate guard: if
you are unsure whether an `add` landed, run `find <issue>` before adding again ([[CHN407]] 407.21 and 407.23 are
one decision recorded twice; [[CHN432]] 432.13 and 432.16 repeated it, so this is a pattern, not a slip). Read
`find <issue>` once before writing RESULT.md's decision list, and check each row appears once. The script finds the knowledge
repo from any worktree; an earlier cycle's rows are `node scripts/decisions.mjs find <issue or spec ID>`.
**A decision that adds a branch needs a test that takes each side of it**, with an
absence mutation per side: a recorded but untested decision is a review round ([[CHN149]] D-b: records
without `labelIds` fetched and judged after the fetch, untested until round 2).
**A field your change leaves unread goes in this cycle.** When the cycle stops reading a field, parameter or
option, grep its readers before RESULT.md; if none remain, remove it with its fixtures now (keep a twin that
something else still reads). "Left for a later cleanup" is dead code and a review round: [[CORE639]] kept
`OAuthClientsRuntime.defaultScopes` after D4 stopped reading it, and review sent it back. Where the gap changes a contract another spec relies on, or a behaviour the spec states,
don't guess: stop and report `blocked` with the question.

## 5. Gate

**In a sprint the coder does not run the gate.** Before you report, run the tests on the files you changed
and added (`pnpm -C packages/<pkg> test <file>`) and a typecheck of the packages you touched: every package with
a path in `git diff --name-only main...`, test-only and `scripts/` files included (CORE347 changed a test in
`packages/webhook-receiver-example/scripts/`, typechecked only `api`, and lost a gate round to a TS2339), and `pnpm lint`
after your last commit (UI510 committed a `release:check` leg after its lint run and lost a gate round to a format diff;
about a second; Biome's a11y rules fire only there: UI381 lost a gate round to `useSemanticElements` refusing
`div role="region"`, which wants `<section aria-label>`; a scrollable region keeps `tabIndex={0}` under a scoped
`biome-ignore` of `noNoninteractiveTabindex` with the reason. Biome turns its React rules on per package once `react`
is in that package's `package.json`, so adding the dependency can surface errors in files the cycle never touched:
UI446's 15 errors, first misreported as baseline. An error is baseline only if the same command on a `main`
checkout shows it, never a run that already holds the branch's files. `pnpm lint` exits 0 on warnings, so compare its
warning count with `main`'s and remove any warning you added: CORE541's unused import passed lint and the gate and
cost a review round); report the gate
as "not run: gate-tester". The orchestrator then spawns the gate-tester, which runs `scripts/gate.sh` and writes
`GATE.md`; you are woken only if it is red, and that round is free (it does not count toward the reviewer-round
cap). Outside a sprint, run the gate yourself, as below. Never report a test as passing without having run it.

```bash
pnpm -r --workspace-concurrency=1 --filter '!@vibase/api' test   # every other package, one at a time
pnpm -C packages/api test --reporter=dot                          # the api suite alone on the machine
pnpm -r typecheck
pnpm -r build      # where a package has a build
```

**Waiting costs context cache; wait as few times as possible.** Every wake-up after a long idle gap re-reads the whole
context uncached, and a Monitor that expires (900 s) and is re-armed is one such wake-up per expiry. So:
- While iterating, run only the affected files (`pnpm -C packages/<pkg> test <file>`), in the foreground; they finish in
  seconds to a minute or two. The full gate runs once, when the work is green, not after each change. "Affected"
  includes every test file in a folder you add a source file to: a dormant cycle's no-caller test scans its siblings'
  sources, and [[CHN428]]'s new module tripped [[CHN424]]'s guard in the same folder, seen first by the gate. It also
  includes `packages/server-d1/src/measured-limits.test.ts` whenever you add or remove a D1 read or write on an
  operation or the capture pipeline in `packages/api`: it pins each scenario's query count from another package, and
  [[CORE574]]'s extra per-chunk read was seen first by the gate. A gate-fix round updates RESULT.md (gate line, decisions)
  as well as the log. A red guard (a source or content scan) is answered in the guard or in the line, never by
  reshaping the line so the scan misses it (`writing-tests`, "A guard that flags your line"; [[CORE662]]'s built
  `/${'device'}` was sent back in review). When the cycle moves where an error is raised (an earlier layer refuses first), "affected" is
  every test file in the package that asserts that message: grep for it ([[CORE602]]'s two stale storage tests).
- Run the whole gate as ONE background script, `scripts/gate.sh [log-dir]` (the four commands above, one log per
  step, `gate.status` ending in `GATE_EXIT=<0|1>`), started with `run_in_background`. Then wait once. Do not start a
  Monitor per suite.
- Wait with a single `until grep -q GATE_EXIT <log>; do sleep 30; done` Monitor given the longest timeout the tool
  allows, and send nothing while it runs. If it expires, re-arm it once with no commentary; do not poll, re-read the log
  or run other commands in between.
- Never start a second gate run while one is going (they contend for the machine and both slow down).
- In a sprint, run no package's full suite at all (`pnpm -r test`, `pnpm -C packages/<pkg> test` with no file): the
  gate-tester's run is the full-suite evidence, and [[API516]]'s coder left full runs going in the worktree that
  contended with it. Stop every background command before you report.

Every D1 package (`@vibase/api`, `server-d1`, `storage-d1`, `cli`) runs its files in parallel at 4 workers ([[OPS223]], [[OPS338]]), alone on the machine, on the 8-core
development machine: api about 105 s (104 s in the OPS340 run; 382 s on the binding transport; 971 s serial); server-d1 about
130 s (129 s; 376 s on the binding transport; 973 s serial); storage-d1 about 13 s (12 s; 24 s binding; 55 s serial); cli about 10 s (9 s; 15 s binding; 28 s serial) (OPS340 runs at
load 4 to 6; OPS339's earlier numbers were for the binding transport); the whole gate about 5 minutes (OPS340's two green gates on one sha, at load 5 to 10: packages about 160 s (server-d1 122 to 132 s, storage-d1 11 s, cli 8 to 9 s), api 87 to 100 s, typecheck about 20 s, build about 15 s, lint about 1 s; inside the gate, which runs everything at once, server-d1 and api come in a little under their stand-alone times).
Since OPS340 a test reaches D1 through the request transport: if a failure might be the transport's, rerun the file with `VIBASE_TEST_D1_TRANSPORT=binding` ([[writing-tests]]). On a loaded machine lower the count with
`VITEST_MAX_WORKERS=N pnpm -C packages/<pkg> test` and name N in RESULT.md. A plain `pnpm -r test` runs the packages concurrently
(each package's 4 workers beside the others'), which is why the gate splits it as above. The default reporter prints nothing until the end, so a slow run looks like a
hang: run it as `pnpm -C packages/api test --reporter=dot` (or `verbose`) and keep its log ([[CORE200]] retro).
The same holds for `server-d1`'s scripts: `pnpm -C packages/server-d1 test scripts` as one process with the default reporter printed
nothing for over 12 minutes, while the same files split by directory (`test scripts/instance`, `test scripts/setup scripts/bootstrap ...`)
finished in minutes ([[OPS307]] retro). Split by directory, or pass `--reporter=verbose`, and run it in the background.
Run a package's full suite only through its `test` script (`pnpm -C packages/<pkg> test`), which passes the root
`vitest.config.ts` (D1 and engine-neutral projects). A bare `vitest run` or `pnpm exec vitest run` inside the package has no
config, collects the `*.postgres.test.ts` files and fails them without a Postgres database: the [[CORE202]] reviewer's api
run showed 32 such false failures. This holds for reviewers as much as coders.

D1 is the oracle (AGENTS.md, "Engines"): the D1 suites, typecheck and build must be green. The Postgres
suites are off by default (the `postgres` vitest project, switched in the root `vitest.config.ts`; `pnpm -r test` skips
them, no Postgres database needed); don't run `pnpm test:postgres` in a cycle unless the cycle is about Postgres.
If you do run them, their failures are drift to report, not to fix by bending D1 behaviour.
A new test that needs Postgres is a `*.postgres.test.ts` file, never a list entry or a guard. A failure that reproduces on a clean `main` is pre-existing: report it, don't fix it in this cycle.
The `@vibase/api` Postgres baseline is tracked in #89 (128 failures on `main` `7bd7973`, D1-only schema):
compare the count against it, and if it rises name the D1 migration responsible ([[CORE84]] retro), instead of
re-running a clean `main` to prove the failures predate the branch.
**The one allowed skip** ([[OPS275]]): when every changed file is outside `@vibase/api` and outside the packages it
depends on (`packages/api/package.json`: today `storage`, `storage-d1`, and the parked `db`, `storage-postgres`), for
example a diff confined to `packages/server-d1/scripts/` or `packages/release/`, the `@vibase/api` suite may be skipped.
Say so in RESULT.md with the `git diff --name-only` list that justifies it; typecheck and build still run in full.
The charter's E2E scenario is not part of the gate; in a sprint the e2e-tester runs it.
When the scenario is a script you wrote (a Playwright `*.e2e.ts`) and it needs only a local Worker and
`.env.dev`, run it once before you report and fix what is yours. A recipe in the spec file's header (`.dev.vars`,
migrated local D1s, a bootstrap invitation, `pnpm dev`) is that case, not a reason to skip: [[UI467]]'s coder left
`e2e:auth-pages` legs type-checked only, and an assertion the charter had spelled out differently cost a coder round. When the script has rate-limited legs (the
device legs of `e2e:oauth-pages`), rerun only the legs you changed (`-g`); repeated full runs spent [[UI455]]'s
per-IP limit and left the full run undone. The tester's run is still the evidence; yours
catches script slips, which cost [[API115]] a full coder and tester round. Start the run only once `pnpm dev` has
finished its build (a run started over a rebuild failed at an early leg in [[UI468]]), and stop every dev server or
`wrangler dev` you started before you report (`lsof -i :8787`): [[UI468]]'s coder left one running and the orchestrator
had to kill it before the gate. Note the run (pass, or what failed and
why) in RESULT.md. **Before writing a Playwright spec, read `writing-tests` §7** and copy the waits of an existing
spec (`mcp-oauth.e2e.ts`): [[AGT8]] cycle 1's spec read `window.Clerk.session` right after sign-in, a race §7
already names, and it cost a coder and tester round. A spec that only type-checks has not been run.
**A harness outside the gate that fails** (`smoke:worker`, `release:check`): run it once on a clean `main` worktree
(`git worktree add --detach <dir> main`, `pnpm install --frozen-lockfile`) before you report. If it fails there too,
quote the failing line in RESULT.md so the reviewer or planner can open an issue; "not confirmed on `main`" leaves
that check to them. [[UI246]]'s `smoke:worker` abort had been on `main` since #286 (#295).

**Resuming an interrupted gate** (`knowledge/specs/012-CORE170-message-sort/RETRO.md`): inventory the saved
per-package logs against the current source/test state before rerunning. Retain still-applicable passing checks,
label them as retained in RESULT.md, and complete missing or failed checks; do not describe the combined evidence as
a fresh recursive run. Re-read current permissions: an old worker may retain a socket sandbox after the main session
changes permissions. Report that mismatch to the orchestrator for a fresh verifier; a denial before tests is not
baseline evidence. Keep RESULT/HANDOFF current before a planned handoff so the next worker need not recover logs.

## 6. RESULT.md, commit, push

`RESULT.md` in the cycle folder (write it with the Write tool, not a heredoc) holds:

- **Decisions** (each already a row in the decisions log, with its `ref`). On a fix round, update RESULT.md's Decisions and
  evidence lines to match the log: a review round that supersedes a decision leaves a stale line otherwise ([[CORE549]] retro);
- **Deviations from the charter** (scope moved in or out, an obligation proven differently);
- **Evidence**, keyed to the charter's obligations: red runs, absence mutations (raw), the gate's counts per
  suite written out in RESULT.md itself (the retro reads the folder, not the CYCLE REPORT);
- for a deletion, a title-by-title map of deleted tests to their surviving counterparts.

A change to what `@vibase/cli` or `@vibase/server-d1` ships (a migration, an export, the Worker, the CLI) adds a
`.changeset/*.md` (`pnpm changeset`; AGENTS.md, [[OPS210]] D25); [[OPS260]]'s review round 1 was partly a missing one.
A behaviour change in a shared package the Worker bundles (`@vibase/api`, `@vibase/storage*`, `@vibase/auth`) changes
what `@vibase/server-d1` ships, so it adds one too (`'@vibase/server-d1': minor` for new behaviour). Add it yourself;
"the PR stage decides" is not an answer ([[CHN423]] review round 1, decision 423.16).

A new workspace package (`packages/<dir>`) must update `packages/release/src/workspace.test.ts` (the full
directory list), the count in `packages/release/src/version.test.ts` and `.changeset/config.json`'s `ignore` list
(every package but `@vibase/cli` and `@vibase/server-d1`), or the gate goes red ([[UI254]]'s gate-fix round).
The gate's `pnpm -r build` runs every package's `build` script with no settings in the environment, so a build that
needs settings and refuses without them (an example app compiled with a deployment URL and a client id) is named
something else (`build:app`) and the package has no `build` script ([[DX637]]'s gate-fix round, decision 637.18).

Commit on the cycle branch with Conventional Commits, staging explicit paths (never `git add -A`), and
push. Commit `RESULT.md` in the knowledge repo together with your decision rows: `git -C knowledge add
specs/<cycle folder>/RESULT.md decisions/`, one commit, push. A `RESULT.md` that cites refs the knowledge repo's
`main` does not hold leaves the reviewer reading rows from your working tree and the orchestrator committing them
after you ([[UI489]]: `RESULT.md` landed in one commit, rows 489.16–489.22 in a later one). In a sprint, stop here:
the PR, the retro and the merge belong to other stages. Outside a sprint, run the full gate (`scripts/gate.sh`) on
the pushed sha, run `/retrospect` on the cycle folder, then open the PR (`gh pr create`) with the gate's
`gate.status` result in its body, and leave the merge to a human. The PR's GitHub check is lint only
(`.github/workflows/ci.yml`), so a green check is not a green gate: #486 was merged with only `lint` green and
put two red tests on `main` until #488.

When applying review findings, change only what the findings ask for, rerun the gate, commit, push,
and **end with the `CYCLE REPORT`** (§7). A review round is a run like any other: a fix pushed without a report
leaves the orchestrator waiting for one ([[API63]] round 1). The same holds for a gate or E2E fix round. If the fix
changes something one of your decision rows states (a file, where a function lives), add the superseding row
(`--supersedes <ref>`) and update `RESULT.md` in that round. A new choice the fix makes is a new row, listed in
`RESULT.md`'s Decisions in the same round, with the fix's evidence. [[UI256]]'s review round 1 asked only for these
records, and [[UI445]]'s round 2 was a gate-fix row (445.24) missing from `RESULT.md`. A fix that changes layout
(a flex basis, a wrap, a width) re-runs every width the charter's E2E checks, with a geometric assertion
(`writing-tests` §7), before reporting: [[UI459]]'s round-1 `flex-1` fix was proven at desktop width only and broke
375 px, which cost round 2.

If you run low on context, run `/handoff` in the cycle folder and report `handed off`.

**Checkpoint.** The safety net for a cycle that turned out bigger than its charter said. Once your context
has been compacted, or after about 150 tool calls without a green gate, stop at the next clean point:
commit what is green, push, run `/handoff`, and report `handed off` with what remains. The orchestrator
resumes with a fresh brief. Note in RESULT.md where the charter underestimated the work, so the retro can
recalibrate the size budget.

## 7. Report

End with this, whether the cycle finished, handed off or is blocked. Facts from this session only, each
backed by a command you ran or a file you wrote; "not run" is acceptable, a guess is not. **Send it once**, after
every background command has finished: while waiting, send nothing, never the same report again ([[API105]]: repeated
reports left the orchestrator sorting duplicates from a real final one). Never send a placeholder ("report to
follow"): a hand-back ends your run, and [[API516]]'s placeholder cost a continuation run to get the real report.

```
CYCLE REPORT — <ID>
Outcome: complete | handed off (<HANDOFF path>) | blocked (<question>)
Worktree / branch: <path> / <branch> @ <sha>
Commits: <sha — subject>, one per line
Migration: <file, or none>
Tests run: <command → N passed / M failed>, affected files; typecheck of touched packages <clean | errors>
Gate: not run (gate-tester) in a sprint; outside a sprint <command → N passed / M failed>, one per suite; typecheck <clean | errors>; build <ok | n/a>
Obligations: <each charter obligation → test(s) and evidence (red run / mutation Mn) | not proven — why>
Decisions: <one line each, or none>
Deviations from charter: <bullets, or none>
Owed by the user: <prod migration, remote resource, manual step, with exact commands> | nothing
```
