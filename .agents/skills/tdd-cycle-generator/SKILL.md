---
name: tdd-cycle-generator
description: Generate a complete TDD cycle plan from a spec file. Creates a PLAN.md (or a plan-only cycle folder) under knowledge/specs/ targeting one cycle of work. Gathers current conventions from the area skills, AGENTS.md and recent retros at generation time — it embeds what it reads, it does not carry its own copy of the rules. Use when starting any implementation cycle: the first cycle of a new spec, or a follow-on cycle for an existing one.
---

# TDD Cycle Generator

Generate a complete TDD cycle plan from a spec note (`<ID>.md`). The plan follows the Red / Red / Green
pattern.

Each cycle is **one folder**. If a spec is implemented across several cycles, each gets its own folder
with its own ID, plan and retro. The spec lives where it was first authored; later cycles reference it
through `implements: "[[<spec-ID>]]"`. See [[spec-author]] §1.5.

**Usage:** `/tdd-cycle-generator knowledge/specs/<seq>-<ID>-<slug>/<ID>.md`

**Design note: query, don't embed.** This skill carries **no** package conventions and **no** lessons
list. The predecessor's earlier generator embedded both; within weeks it prescribed a package that no longer existed
and an SDK the repo had banned. Conventions live in the area skills and `AGENTS.md`; lessons live in
retros and are ingested into those by [[retrospect]]. This skill *reads them fresh* (Step 5) and copies
the relevant parts into the plan, so every plan reflects the repo as it is today.

---

## Workflow

### Step 1: Read and parse the spec

Sync the knowledge repo first. `knowledge/` is its own git repo, and a stale local `main` can hide a
changed scope, a shipped status or an existing RETRO:

```bash
git -C knowledge pull --rebase
```

Read the spec note at `$1`. Extract the title, ID and goal; all H2/H3 headings; key requirements,
interfaces and acceptance criteria; referenced specs (read those too when they gate this cycle); and the
current `**Implementation cycles:**` block, which tells you what is already planned and what scope is
unclaimed.

### Step 2: Decide cycle shape and scope

Ask via `AskUserQuestion` (in an orchestrated sprint, the planner decides these itself and records the
choice and reason in the plan's header):

1. **Cycle shape.**
   - **First cycle (spec-introducing).** `PLAN.md` lives in the spec's folder. Only when no `PLAN.md`
     exists there yet.
   - **Follow-on cycle (plan-only).** The plan is the new folder's owning note `<new-ID>.md`, with
     `implements: "[[<spec-ID>]]"`. If a `PLAN.md` already exists in the spec's folder, the answer is
     always follow-on; never overwrite an existing plan.
2. **Scope.** Present the spec's sections, marking those already claimed by prior cycles. Ask which this
   cycle covers; the rest stay open.
3. **Short name.** Kebab-case, describing *this cycle's* scope, not the spec at large (e.g.
   `contacts-resource`, `webhook-delivery`).

### Step 3: Resolve the new cycle's identity (follow-on cycles only)

- **New ID.** The GitHub issue number tracking this cycle, prefixed with the spec's area code (`CORE57`).
  Open an issue in `benocodes/crm` first if none exists (`open-issue`, with `--label self-triaged`).
  **Never** suffix the spec's ID (`CORE36b` is wrong).
- **Seq prefix.** The same as the spec-introducing cycle if shipping in the same window; otherwise the
  seq that places it next to its predecessor in build order.
- **Folder.** `knowledge/specs/<seq>-<new-ID>-<slug>/`.

### Step 4: Confirm the output path

Show the resolved path and confirm before generating:

- **First cycle:** `knowledge/specs/<seq>-<spec-ID>-<slug>/PLAN.md`
- **Follow-on:** `knowledge/specs/<seq>-<new-ID>-<slug>/<new-ID>.md`

### Step 5: Gather current knowledge

Before writing a plan step, collect what the repo currently knows. This keeps plans from encoding stale
conventions.

1. **Area skills.** Read the skill for every area the cycle touches:
   - schema or migrations → `db-schema-and-migrations`
   - routes, middleware, services, resource definitions, integration tests → `api-routes`
   - pool, RLS or Hyperdrive behavior → `hyperdrive-pg-rls`
   - Workflows, Queues, scheduled sync → `cloudflare-workflows`
2. **`AGENTS.md`**: the load-bearing invariants, naming conventions and commands.
3. **`knowledge/architecture.md`**: the principle(s) the spec's area is built on, and its "Open
   questions" (decide or defer them explicitly in the plan rather than silently picking).
4. **Recent retros.** Read "Lessons Learned" and "Deviations from Plan" of every earlier cycle of **this
   spec** and the 3 most recent retros in the same area (`ls -t knowledge/specs/*/RETRO.md | head`). A
   deviation that happened last month will happen to this plan unless it is planned around. If a
   hard-dependency prerequisite cycle landed very recently, its retro may not exist or may omit
   fine-grained details (helper signatures, status codes, column names): read that cycle's landed files
   before writing anything that claims to mirror them.
5. **External services.** If the cycle integrates a third-party API (Gmail, Kapso/WhatsApp,
   Cloudflare's Queue/Workflow HTTP APIs, Clerk), fetch the service's current documentation *now*.
   Invented endpoints, payload shapes and signature headers invalidate entire phases. At minimum pin down
   the auth mechanism, the connect/callback flow, webhook signature verification and real payload shapes.
6. **Survey the code.** Read the modules the cycle changes or calls, their existing tests, and the shared
   test helpers and seed functions those tests use. Look for helpers to reuse and the seam to test at.

Then **embed what applies into the plan**: copy the specific rules, commands and gotchas the implementer
needs into the relevant steps, with a pointer to the source. The plan must be self-contained for whoever
executes it; "see the skill" alone is not embedding.

Meta-rules that always apply:

- **Follow existing specs before inventing flows.** Reference and follow them.
- **Migration plans never round-trip `down()` and never touch a real DB in tests.** Any plan with a
  migration embeds `db-schema-and-migrations`' testing rules.
- **A test fixture must satisfy the runtime validator it will actually pass through, not just the
  TypeScript type.** If a fixture feeds a function that validates its input (a zod schema, a hand-written
  guard), read the validator before writing the fixture literal.

### Step 6: Generate the plan

Create the plan at the path confirmed in Step 4.

**First-cycle header** (`id` is the spec's own ID, since plan and spec share the folder):

```markdown
---
id: <spec-ID>
type: plan
order: <seq>
title: "{Title} - TDD Cycle"
implements: "[[<spec-ID>]]"
---

# {Title} - TDD Cycle

**Goal:** {extracted from the spec}
**Spec:** [[<spec-ID>]]
**Scope:** {user-defined scope summary}
```

**Follow-on header** (`id` is this cycle's own new ID):

```markdown
---
id: <new-ID>
type: plan
order: <seq>
title: "{Cycle title}"
aliases: [<new-ID>, "{Cycle title}"]
status: draft
implements: "[[<spec-ID>]]"
---

# {Cycle title}

**Spec:** [[<spec-ID>]]
**Goal:** {one line, scoped to this cycle}
**Scope:** {sections of the spec this cycle covers; deferred sections go under Out of scope}
```

**Body (both shapes):**

````markdown

---

## Prerequisites
{What is already in place: packages, migrations, services, fixtures. For a plan-only cycle, first name the
prior cycle(s) assumed merged, e.g. "Assumes `[[CORE36]]`'s outbox is merged".}

## Code map
{Existing code this cycle builds on, from the Step 5 survey. One entry per type, function, helper or
component, with `path:line` and the current signature copied from the file, not recalled. Every existing
name the plan's tests or steps rely on must appear here. A plan with no citations was written from the
spec alone, and its tests will call helpers that don't exist.}

**Source**
- `{path}:{line}` — `{signature}`

**Test helpers**
- `{path}:{line}` — `{signature}`

## Contracts
{Shapes this cycle adds or changes, which the tests pin exactly: event payloads, error codes and strings,
function signatures, zod schemas, scope names, table shapes. Existing shapes stay in the Code map; for a
changed one show before and after.}

## Test infrastructure
{The test stack for the affected package(s), from `AGENTS.md` and the area skill: runner config, how the
test DB is reset, how tenancy is exercised (the production-like pool: nothing preset), mock strategy.}

## Phase 0: Worktree, branch, private test DB

Do all of the cycle's code work in a new worktree. The main checkout is shared with other sessions;
switching its branch silently moves them onto yours. Give the worktree its own test DB too: a shared test
DB plus a concurrent `db:test:reset` produces fake deadlocks and "column does not exist".

```bash
cd {repo root}
git worktree add .claude/worktrees/{cycle-id-lowercase} -b feat/{cycle-short-name} main
cd .claude/worktrees/{cycle-id-lowercase}
pnpm install
pnpm db:test:worktree
ls packages/db/migrations | tail -3   # confirm the migration number this plan claims is still free
```

Branch from **local** `main`. Every later command runs from the worktree.

## Phase 1: Red (unit tests)

### Step 1.0: Verify against the tree
Before writing any test, check each Code map entry against the tree: open the cited file, confirm the
signature still holds, and look for anything the map missed. Where the tree disagrees with this plan, the
tree wins; note the difference for the retro.

### Step 1.1: {test file path}
{One line on what the file covers, then a test-case table:}

| Test | Given | When | Then |
|------|-------|------|------|
| {name} | {setup} | {action} | {observable outcome; exact where a Contract applies} |

**Isolation:** {how the boundary is stubbed, naming Code map helpers}

### Step 1.2: Run the tests (expect failures)
{Exact command. Each test must fail because the behavior is missing, not because of an import error or a
wrong factory call.}

## Phase 2: Red (integration tests)
{Real seams: routes or operations against the test DB (production-like pool), the outbox and event rows,
workflow steps through the workerd boundary shim, adapters against recorded payloads.}

### Step 2.1: {integration test file path}
{Test-case table and isolation strategy.}

### Step 2.2: Run the integration tests (expect failures)
{Exact command.}

## Phase 3: Green (implementation)
### Step 3.1: {first implementation step}
{Files to create or change, key functions and signatures, the approach and why. Snippets only for
non-obvious logic, not full files.}

### Step 3.N: Run the tests
{Commands; expect them to pass.}

---

## Phase 4: Verify

**You MUST actually run all tests. Do NOT skip. Do NOT assume pass.**

Steps 4.1 to 4.3 are the **gate**: in a sprint the coder runs them and must be green before it reports.
Step 4.4 is the **E2E scenario**, run by the e2e-tester only after the gate passes.

### Step 4.1: Run all tests
```bash
pnpm -r test
```
### Step 4.2: Typecheck
```bash
pnpm -r typecheck
```
### Step 4.3: Build (if applicable)
### Step 4.4: E2E scenario, or `E2E: none ({reason})`
Include a scenario only when the cycle adds behaviour that exists across a real seam the deterministic
tests fake or skip: a new externally reachable surface (REST route, MCP tool, CLI command, the pane, a
channel adapter over a recorded fixture); infrastructure Node doesn't reproduce (workerd, Workflows,
Queues, Hyperdrive, R2); auth, tenancy or approval flows through the real pool and RLS; a migration over a
database that already holds data. Otherwise (refactors, service-layer changes covered by the both-engine
tests, schema-only additions covered by contract tests, types, docs, skills) write `E2E: none` with the
reason; the orchestrator then spawns no e2e-tester.

A scenario states, in this order:
- **Initial state**: what exists before (rows, tenants, credentials, fixtures), and how to set it up.
- **Actions**: the real calls, with payloads (REST/MCP requests, CLI commands, fixture replays).
- **Expected end state**: what must be true afterwards (responses, rows, events, outbox), including the
  failure paths the cycle defines.

**Any scenario that reads through a running API must first confirm which database it is actually on**:
an already-exported `DATABASE_URL` overrides `--env-file`, so a dev server started from a shell that had
run the tests can serve the test DB. Write the expected database into the step.

---

## Phase 5: Retro and commit

**In an orchestrated sprint** (AGENTS.md, "Running a sprint") this phase is split: the coder runs the gate (steps 4.1 to 4.3),
commits and pushes after Phase 3, the e2e-tester runs the E2E scenario (step 4.4) if there is one, the planner runs `/retrospect` after review approves,
and the orchestrator opens and merges the PR. Outside a sprint, the executing agent does all of it:

Run `/retrospect` on this cycle folder **before** committing: it captures deviations while they are fresh
and its ingest step propagates lessons. Then commit on the feature branch from the worktree:

```bash
git rev-parse --abbrev-ref HEAD      # must be feat/{cycle-short-name}
git status --short                   # nothing stray
git add {explicit paths}             # never `git add -A`
git commit -m "feat({pkg}): {short description}"
git push -u origin feat/{cycle-short-name}
gh pr create --fill
```

Opening the PR is the hand-back point. The executing agent never merges: in a sprint the orchestrator
merges after review approves; otherwise the user reviews and merges. The retro, spec and plan live in the
nested `knowledge/` repo and commit there (`git -C knowledge`).

---

## Verification commands
{All test, typecheck and build commands in one copy-pasteable block.}

## Completion checklist
- [ ] {cycle-specific item}
- [ ] All unit tests executed and passing (not just written)
- [ ] All integration tests executed and passing
- [ ] Typecheck clean; build succeeds (if applicable)
- [ ] E2E scenario run, with the database confirmed first | `E2E: none` with reason
- [ ] Retro written and ingested (`/retrospect`)
- [ ] Committed, pushed, PR opened

---

## Completion report

Your **final message** is a report to the sprint manager (the session running `/sprint-checkpoint`).
Send it whether the cycle finished, stopped at a handoff or is blocked; a stop is still a report. Facts
from this session only, each backed by a command you ran or a file you wrote; "not run" is acceptable, a
guess is not.

```
CYCLE REPORT — {ID}
Outcome: complete | handed off (<HANDOFF path>) | blocked (<on what>)
Worktree: .claude/worktrees/{cycle-id-lowercase}
Branch / commits: feat/{cycle-short-name} @ <sha> — <subject> (one line per commit)
Migration: <number used, or none> (<differs from the plan's claim? say so>)
Tests: <command> → <N passed / M failed> (one line per suite); typecheck <clean | errors>; build <ok | n/a>
E2E: <scenario run and what was seen> | none — <why>
Deviations from plan: <bullets, or none>
Red runs: <each new test file → command, N failed, for the right reason> (one line per file)
Absence checks: <each injected fault → which tests went red, run how> | none in plan
Retro: <RETRO path> | not written — <why>
Knowledge ingested: <file → one-line lesson> per change | none — <why>
Spec status: <old> → <new>; changelog entry <added | not added>
Owed by Ori: <merge, prod migration, deploy, manual smoke… with exact commands> | nothing
Open questions / blockers: <bullets, or none>
```
````

### Step 7: Review the plan

1. Re-read the generated plan.
2. Verify: every file path exists or is explicitly marked new; naming follows `AGENTS.md`; test commands
   use the `pnpm -C` form; the `## Completion report` section is present; no seq-prefixed spec path
   survived into the text (`grep -nE 'knowledge/specs/[0-9]{3}-' <plan>` must come back empty); every
   embedded convention came from a Step 5 source.
3. Report the output path and a summary to the user, and flag gaps: packages or tables the spec
   references that don't exist, prerequisite specs that haven't landed, dependencies to install.

### Step 8: Commit and push the plan

Commit the plan straight to `main` of the knowledge repo and push it. Don't open a PR: plans are pushed
when written so whoever implements the cycle builds from the same plan and the retro can cite it.
Follow-on cycles also include the spec's updated **Implementation cycles** block.

```bash
git -C knowledge pull --rebase
git -C knowledge add specs/<seq>-<ID>-<slug>/
git -C knowledge commit -m "docs(specs): <ID> cycle plan — <short scope>"
git -C knowledge push
```

If the push is rejected, `git pull --rebase` and push again. Writing and pushing the plan is where this
skill ends; don't start implementing unless asked.

---

## Plan quality rules

1. **Complete test cases, not complete test code.** Every test step lists its cases (given/when/then)
   precisely enough that two implementers would write equivalent tests. Don't say "write a test that does
   X"; name each case and its outcome. Don't paste full test or implementation files either: the plan is
   written before anyone checks the tree, and pasted code drifts (invented helpers, wrong signatures).
   Every rule a test enforces must also appear in prose or in **Contracts**, never only in an assertion.
2. **Paths from the repo root**, e.g. `packages/api/src/resources/contact.ts`.
3. **Reference specs and cycles by stable ID**, never by seq-prefixed path. The seq is a reassignable
   hint; folders get renumbered, and every reference written through it dies silently. The path form is
   only for filesystem operations during generation.
4. **Correct test commands**: `pnpm -C packages/{pkg} test [file]`, `pnpm -r test`. Never `npx vitest`.
5. **No speculative dependencies.** Prefer the platform and Node builtins. A new dependency gets its own
   step so install and test runs are separable.
6. **Fetch external API docs before writing** any plan that calls a third-party API.
7. **Fixtures over synthetic data for adapters.** Recorded Gmail and WhatsApp payloads are the fixture
   source for capture and send adapters; store them under the package's `test/fixtures/`, reference by
   path, don't paste them.
8. **One cycle, one folder.** A `PLAN.md` is the only plan in its folder. Never `PLAN-02.md`; later
   cycles are new folders with their own ID.
9. **Contract suite for resources.** A cycle that adds a resource definition must add it to the contract
   suite (create emits `<resource>.created`, cross-tenant reads return nothing, a missing scope is
   refused, REST and MCP both work) rather than hand-writing those tests, and must say so in the plan
   ([[architecture]] §11).
10. **An absence test is only red-then-green if the fixture triggers the producer under the old code.** A
    conditional producer makes a bare-minimum fixture pass trivially. Plans that assert an absence say so
    and have the executing agent run the test before implementing to confirm it fails for the right
    reason. **Check that the injected fault can actually turn each named test red** before promising it:
    `set_config(..., false)` inside a transaction that rolls back is rolled back too, so it cannot redden
    an "after rollback" leak test ([[CORE1]]). Tell the executor to run each target test alone (`-t`):
    on a shared `max: 1` pool, one test's leak reddens the next for the wrong reason.
11. **A migration's test goes red before the migration exists.** The red tests and seed helpers often need
    the new columns in `types.generated.ts` to typecheck, and that pulls the migration and codegen forward
    into Phase 2, so the migration test never fails against the old schema ([[CORE3]] cycle 1). The plan's
    Phase 2 must order it explicitly. First write the migration's integration test and run it alone
    against the current schema: it must fail on the missing column or table, not on a compile error
    (vitest runs untyped, so a type error does not block the run). Record that red run. Only then create
    the migration, run codegen and change the seeds. Commit the red test before the migration, so the
    history shows the order.
12. **A deletion cycle's blast-radius grep is a floor, not a ceiling.** Grep for the deleted file's
    basename and exports too, and for operation names as string literals, not only the domain concept;
    tell the executor to treat every surprise the grep finds as a decision to make.
13. **Grep for exact-list assertions before adding a table, a grant or a scope.** Earlier suites pin whole
    lists, and each addition breaks them: `migration-001`'s table list, `migration-002`'s
    `vault_authenticated` grants, `tenancy`'s list of inserts that must fail `42501`,
    `identity-definitions.test.ts`'s `declaredScopes()`, `bootstrap`'s default agent scopes. In
    [[CORE27]] the plan named two of them, and the coder found the other three during the run. Grep
    `packages/*/src` for `toEqual([` near `table_name`, `grants(`, `declaredScopes`, `scopes` and `42501`,
    and list every hit in the plan's Phase 2 with its fix. In a `migration-NNN` test, **delete** the broken
    assertion (`db-schema-and-migrations`: never rewrite an earlier migration's test to the new shape). In a
    catalog test over the current registry (`declaredScopes`, bootstrap's scopes), **update** the list in
    the same change: it states today's truth on purpose.
14. **Every new test file gets its own recorded red run**, not only the migration test (rule 11). Phase 1
    and Phase 2 each name the command that runs the new file alone, and the coder pastes the result (N
    failed, and why) into the completion report's `Red runs` line. A file never seen failing is the same
    gap as an absence test never seen failing ([[CORE27]] review note (e)). The plan also tells the coder
    to append each red run to RESULT.md **at the red commit**, not at the end: in [[CORE38]] the coder's
    report was lost and the red output with it.
15. **A rule that compares against stored state gets a test for "no stored state".** A guard such as
    [[CORE3]] D20's newer-copy rule ("refuse when the copy changed after the token was issued") is silent
    when there is no row to compare, and that is where it leaked in [[CORE29]]: a member added and removed
    in Clerk before the vault held a row could be re-created by an older token. For each such rule, the
    plan's Phase 2 names the empty-state case and its expected outcome, and if the spec does not say, the
    planner raises it as a spec question before the plan ships.
16. **A behaviour row in a plan is checked against the shipped code before it ships.** When a cycle
    migrates existing behaviour, the old service is the oracle. Read it and cite it, and never write what
    the behaviour "should" be. [[CORE35]]'s PLAN said a same-value patch emits no event; the shipped
    `updateResource` emits one, and the row became a coder deviation and a review decision (spec D22).
    A real behaviour change is a spec decision, not a plan row.
17. **A type-safety gate names its call-site negatives.** List the expected compile errors at the
    declaration a user writes (a resource definition: unknown, secret or mistyped record column; unknown
    or mistyped computed column; unknown filter or reference; a guard on another table), not only on
    standalone helpers. A generic core built on an untyped internal view passes helper-level negatives
    while its definitions accept anything ([[CORE35]] review F1).
18. **Say how to red a suite that needs the whole vertical.** Integration suites that exercise a pipeline
    end to end (contract, parity, atomicity, concurrency) cannot fail meaningfully before the pipeline
    exists. Plan them as **absence mutations**: name the fault to inject and the test that must turn red,
    and require the raw output in RESULT.md, instead of a red-first run that would only show a
    missing-module error ([[CORE35]]).
19. **A step that creates a remote resource names who runs it, and assumes the agent cannot.** Claude
    Code's permission classifier denies an agent's creation of external resources (`wrangler d1 create`,
    `r2 bucket create`, a first deploy that attaches a Custom Domain) even when the spec's decision
    authorizes it, because an agent's or a spec's word is not the user's consent. Write such a step as
    either **the user runs it** (the exact commands, in an owed-by-user item before the step) or **the agent
    runs it once the user has added scoped allow rules** for those exact command forms to their own
    gitignored `.claude/settings.local.json` (also an owed-by-user item). Never plan a workaround through
    another tool or API. Read-only probes (lists, `GET`s) are not affected ([[OPS4]]).
