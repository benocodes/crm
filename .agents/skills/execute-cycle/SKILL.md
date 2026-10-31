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

If the brief names an existing worktree, use it. Every later command runs from the worktree.

`.env` is gitignored, so a new worktree has none. The guarded remote scripts (`db:status:remote`,
`db:migrate:remote`, `deploy:remote`, `smoke:remote`) read the `.env` at the root they run from
(`ROOT_ENV_PATH` in `packages/server-d1/scripts/remote.ts`). Before running one, link the main checkout's file
with `ln -s ../../../.env .env` from the worktree root. Never copy it, and never print it ([[CORE61]] retro).

## 2. Survey before you write

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
- **A deletion's blast-radius grep is a floor.** Grep the deleted file's basename, its exports, and
  operation names as string literals; treat every surprise as a decision to make and record.
- **A migration's number can go stale.** Check `ls packages/db/migrations | tail -3` (and the D1
  migrations folder) right before creating one.
- **Third-party APIs:** fetch the current docs before writing code that calls them. Invented endpoints,
  payload shapes and signature headers sink whole phases.
- **No speculative dependencies.** Prefer the platform and Node builtins. A new dependency gets its own
  commit.

## 3. Red

For every **Must be tested** obligation in the charter, write the test(s) that prove it, following
[[writing-tests]]:

- Run each new test file alone and see it fail **for the reason the behaviour is missing**, not an import
  error. Commit the red tests, and append the red run's output to `RESULT.md` **at the red commit**.
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
output (filtered to the failing test names and messages, saying what you filtered) in `RESULT.md`.

**Decisions.** Where the spec and charter are silent on something the tests pin (an error code, a
payload field, an ordering), decide it, prefer what existing code does, and list it in `RESULT.md` and
your report. Where the gap changes a contract another spec relies on, or a behaviour the spec states,
don't guess: stop and report `blocked` with the question.

## 5. Gate

All of it must be green before you report. Never report a test as passing without having run it.

```bash
pnpm -r test
pnpm -r typecheck
pnpm -r build      # where a package has a build
```

D1 is the oracle (AGENTS.md, "Engines"): the D1 suites, typecheck and build must be green. The Postgres
suites run too but don't block: report their failures as drift instead of bending D1 behaviour to fix
them. A failure that reproduces on a clean `main` is pre-existing: report it, don't fix it in this cycle.
The charter's E2E scenario is not part of the gate; in a sprint the e2e-tester runs it.

## 6. RESULT.md, commit, push

`RESULT.md` in the cycle folder (write it with the Write tool, not a heredoc) holds:

- **Decisions** (each worth a Ledger line in a sprint);
- **Deviations from the charter** (scope moved in or out, an obligation proven differently);
- **Evidence**, keyed to the charter's obligations: red runs, absence mutations (raw), the gate's counts;
- for a deletion, a title-by-title map of deleted tests to their surviving counterparts.

Commit on the cycle branch with Conventional Commits, staging explicit paths (never `git add -A`), and
push. In a sprint, stop here: the PR, the retro and the merge belong to other stages. Outside a sprint,
run `/retrospect` on the cycle folder, then open the PR (`gh pr create`) and leave the merge to a human.

When applying review findings, change only what the findings ask for, rerun the gate, commit, push.

If you run low on context, run `/handoff` in the cycle folder and report `handed off`.

## 7. Report

End with this, whether the cycle finished, handed off or is blocked. Facts from this session only, each
backed by a command you ran or a file you wrote; "not run" is acceptable, a guess is not.

```
CYCLE REPORT — <ID>
Outcome: complete | handed off (<HANDOFF path>) | blocked (<question>)
Worktree / branch: <path> / <branch> @ <sha>
Commits: <sha — subject>, one per line
Migration: <file, or none>
Gate: <command → N passed / M failed>, one per suite; typecheck <clean | errors>; build <ok | n/a>
Obligations: <each charter obligation → test(s) and evidence (red run / mutation Mn) | not proven — why>
Decisions: <one line each, or none>
Deviations from charter: <bullets, or none>
Owed by the user: <prod migration, remote resource, manual step, with exact commands> | nothing
```
