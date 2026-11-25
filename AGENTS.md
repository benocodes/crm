# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A **headless CRM** (working name: the vault). No app of its own: every interaction (email, calendar,
WhatsApp, later calls and iMessage) lands in one database, agents the customer
brings access it over REST, MCP or CLI, with hooks for incoming events. Owners grant per-resource
`read`, `request_approval` or `write` permissions: `write` includes proposing for approval, while reads
remain independent. Agents may execute authorised writes, including sends, or choose review by an
authorised person or agent. The vault holds provider credentials and executes both paths. Human clients are independent apps or the CLI.

**Current focus (2026-10-30, [[discussions/2026-10-30-d1-only-mvp]]): the MVP is Cloudflare D1 only,
self-managed, one D1 database per organisation/workspace in the customer's Cloudflare account.** No
enterprise tier and no cloud-hosted Postgres service for now. The engine-neutral storage port and the
Postgres adapters stay in the repo, dormant, for later: no new Postgres work, and Postgres suites are not a
cycle gate. A single-workspace D1 deployment uses Clerk for sign-in but not Clerk Organizations; membership and roles live in Clerk (the `vibase_role` claim, [[CORE64]] D7); the vault keeps principals, agents and scopes.
**Custom objects are built (milestone T, [[CORE315]])** as physical tables with typed columns, declared in the schema file (no shared `records` table, no jsonb); the built-ins also carry an `additional_props` property bag ([[CORE318]]). Custom `<name>__c` fields on contacts, companies, deals and tasks are declared in the same file's `extend` section ([[CORE561]]); contact merge fills them and re-points references to contacts ([[CORE556]]); the adversarial contract is next (#565). A
**discoverable schema** (real names, native types, declared FKs; easy for agents and humans to query and
understand) is a core principle.

Read these first (they live in the separate knowledge repo, cloned at `knowledge/`):

- `knowledge/vision.md`: the product idea and who it is for.
- `knowledge/architecture.md`: the backend principles (12 of them) and what is inherited from the predecessor product.

## Repositories

| Repo | Path | Holds |
|---|---|---|
| `benocodes/crm` | this repo | code, skills, issues, the project board |
| `benocodes/crm-knowledge` (private) | `knowledge/` (gitignored here, its own `.git`) | vision, architecture, milestones, specs, plans, retros, discussions, `project-state.md` |

The delivery board is the GitHub project **crm** (project 3): https://github.com/users/benocodes/projects/3 (IDs and
queries in the `board` skill, `.agents/skills/board/SKILL.md`).

`knowledge/` is a nested git repo. Use `git -C knowledge ...` for it; a commit in one repo never
touches the other. Specs and plans land on `knowledge/`'s `main`; code lands through PRs on `benocodes/crm`.

## Workflow (skills)

The lifecycle is issue-driven. Skills live in `.agents/skills/`:

| Stage | Skill |
|---|---|
| Intake | `open-issue` |
| Board (IDs, queries, field edits) | `board` |
| Triage | `triage-issues` |
| Spec | `spec-author` |
| Milestones and the sprint (one milestone at a time) | `sprint-planning`, `sprint-checkpoint` |
| Plan (a cycle charter: scope now vs later, what must be tested) | `tdd-cycle-generator` |
| Implement a cycle | `execute-cycle` |
| Deliver features / bugs | `work-on-ready-issues` / `fix-bugs` |
| Pause mid-cycle | `handoff` |
| Close a cycle | `retrospect` |
| Close issue work | `reconcile-knowledge` |
| Knowledge audit | `wiki-lint` |
| Ship | `ship-branch` |

Domain skills: `db-schema-and-migrations`, `api-routes`, `writing-tests`, `hyperdrive-pg-rls`, `cloudflare-workflows`.

**Vocabulary.** A **cycle** is one unit of work: a folder under `knowledge/specs/` that ends in one
branch, one retro and (usually) one PR. A cycle need not ship a complete feature; it must ship a
complete, verifiable unit of work, inside the size budget in `tdd-cycle-generator`. A **spec** is the
design (*what and why*); a spec can be delivered by several cycles.

## Running a sprint (orchestration)

Spec and cycle work in a sprint runs **unattended**, driven by an orchestrator session that delegates
every stage to subagents so its own context stays clean. Open design discussion with the user, and work
on a single issue (`fix-bugs`, `work-on-ready-issues`), are not orchestrated: do them directly.

**Who does what** (definitions in `.claude/agents/`):

| Agent | Model | Job |
|---|---|---|
| `orchestrator` | Sonnet | The main session (`pnpm orchestrator`, i.e. `scripts/launch-orchestrator.sh`: `claude --agent orchestrator --plugin-dir .claude/mods/sprint-relay`, which loads the `next_cycle` hand-off tool). Picks the next item from `knowledge/SPRINT.md`, briefs the others, merges approved PRs, keeps SPRINT.md current. Reads reports, not code. |
| `planner` | Opus | Modes: `spec` (draft and approve a spec), `plan` (a short charter via `tdd-cycle-generator`), `review` (the diff against charter and spec), `retro` (`/retrospect` and ingest). |
| `coder` | Sonnet | Implements the charter via `execute-cycle`: surveys the code, proves every test obligation with tests on the affected files in the cycle's worktree, records its design decisions; applies review findings and gate failures. It does not run the full gate. |
| `gate-tester` | Haiku | Runs the full gate (`scripts/gate.sh`: all suites, typecheck, build) on the pushed sha, writes `GATE.md` and reports counts. Never edits, never diagnoses. A red gate goes back to the coder; gate-fix rounds do not count toward the two-round cap. |
| `e2e-tester` | Sonnet | Runs the charter's E2E scenario (initial state, real actions, expected end state) against a real database or UI, only when the charter has one, and reports evidence. Never edits. |

Subagents cannot start subagents, so the orchestrator must be the main session, never a subagent.

**Codex roles.**

Codex equivalents live in `.codex/agents/*.toml`. For sprint work, the main Codex session reads
`.codex/agents/orchestrator.toml` and follows its `developer_instructions`; never delegate the
orchestrator to a subagent. Open design discussions and single-issue work still run directly.

| Role | Codex model | Reasoning effort |
|---|---|---|
| orchestrator | GPT-6.1 Sol | xhigh |
| planner (spec, plan, review, retro) | GPT-6.1 Sol | xhigh |
| coder | GPT-6.1 Sol | high |
| gate-tester | GPT-6.1 Sol | low |
| e2e-tester | GPT-6.1 Sol | medium |

The Opus/Sonnet names above apply to Claude only. Codex uses these TOML settings. If the runtime
cannot select custom agents by name, the orchestrator starts a fresh agent with the model and effort
from the role file and a brief to read that file and follow its instructions. All delegation stays in
the main session; workers must not spawn subagents. Respect the runtime's available concurrency.
All Codex roles use Sol for now, including verify-only workers.

Current `AGENTS.md` product rules, gates and standing exceptions take precedence over stale examples
in either runtime's role prompts. Update both sets when changing a shared workflow rule.

**Per cycle:** planner `spec` (if the spec isn't approved) → planner `plan` → coder (affected tests green) →
gate-tester (full gate; on red: coder → gate-tester, until green; these rounds are free) →
e2e-tester (only if the charter has an E2E scenario; on failure: coder → e2e-tester, until it passes) → planner `review` (on changes requested: coder → e2e-tester if any → review; **at most two coder rounds in total**; gate-fix and user-ruling rounds are free) → planner
`retro` → orchestrator opens the PR, waits for checks, merges (`gh pr merge --squash --delete-branch`),
removes the worktree and its test DB, and checkpoints SPRINT.md. Cycles that build on each other run in
order from an up-to-date `main`.

**Decisions.** Agents decide design questions themselves and record them: in the spec (with the reason),
and as one row each in the decisions log, written by the agent that decided
(`node scripts/decisions.mjs add --issue <n> --by <role> --stage <stage> "<decision>"`; `find <issue>` reads
them back with the related specs'), so the user can review and overturn them later. A user ruling is a row
too (`--by user --stage ruling`). Where a skill says to ask the user, the agent decides and records instead.

**Hard stops.** The orchestrator stops, records the situation in SPRINT.md (Position, Open Questions,
Next Action) and tells the user before any of these, and never works around one:

- **money or external accounts:** creating paid or external accounts or resources (Google Cloud, Neon,
  Clerk, Cloudflare resources, the Chrome Web Store, domains);
- **production:** a deploy, a migration, a secret or a provider (Clerk) change on a deployed environment,
  except what **Environments** below grants on the agents' own instances;
- **public announcements:** releases, posts, emails or messages to people outside the repo;
- **irreversible data changes:** dropping any database other than the vault's own test databases,
  force-pushing, deleting branches the sprint didn't create.

It also stops when the fix loop exhausts its two coder rounds, when an agent is blocked on something no other
agent can resolve, and when the backlog is empty.

**A sprint is one milestone** (milestones live in `knowledge/milestones/<seq>-<letter>-<slug>/`: the seq is
the rank, set by the user; the letter is the identifier). The orchestrator builds the top-ranked milestone and
then opens the next. It stops when a milestone is too big for one sprint (the user decides the cut) and when
a milestone is paused on something only the user can supply: the factory waits, and no other milestone starts.
New work is a new milestone the user ranks, or a new row the user admits; work no milestone needs goes
through the board. All of it is in `sprint-planning`.

### Environments

What agents may do on each deployed environment. Anything not granted here is a hard stop. This section is
the one current statement of the rules: a new ruling from the user is merged into it, never appended as
another dated paragraph.

| Environment | What it is | Agents may | Keys |
|---|---|---|---|
| `smoked1` | the agents' own single-organisation D1 instance: `--env smoked1`, `api.smoked1.vibase.ai`, Worker `vb-smoked1` on Better Auth ([[OPS251]]; the old `vault-smoked1` resources await the user's deletion) | deploy, migrate, set secrets and create its `vb-` resources, as listed below | `.env.smoked1` |
| Clerk dev instance | the Clerk *development* instance (`sk_test_`/`pk_test_`, `CLERK_JWT_KEY`, `CLERK_FRONTEND_API_URL`) | configure it and create and delete test users, for tests and E2E, as listed below | `.env.dev` |
| `hq` | the Vibase team's production instance: `--env hq`, Worker `vault-hq`, `api.hq.vibase.ai` | nothing: every deploy, migration or Clerk change is a hard stop | `.env.hq`, never sourced or printed |
| `hq-staging` | a later staging copy of `hq`: `--env hq-staging`, `api.hq-staging.vibase.ai` | nothing, as for `hq` | `.env.hq-staging`, never sourced or printed |
| anything else | any other environment or Clerk instance | nothing: a hard stop | none |

All of these files are gitignored. The root `.env` holds **live** Clerk keys: never use them in tests, E2E or
scripts.

**`smoked1`.** Agents may, without stopping:

- deploy and migrate it, through the guarded `deploy:remote` / `db:migrate:remote` scripts, and run the other
  remote commands against it (`db:status:remote`, `setup:remote`, `owner-reset`, `vibase-server status`), including the
  release commands `vibase-server upgrade` and `setup` with the same guards;
- create its resources under the `vb-` naming (databases `vb-crm-smoked1` and `vb-control-smoked1`, the Worker
  `vb-smoked1`, and its queues, workflows and buckets named `vb-<kind>-smoked1`), apply the control-plane
  migrations to them, and move `smoked1` onto them (the rename and the Better Auth cutover, [[OPS250]]);
- set Worker secrets on whichever Worker serves it (`wrangler secret put --env smoked1`, or the guarded setup
  scripts), for example `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET`, and generate, set or
  regenerate its own `AUTH_SECRET` (Better Auth, [[CORE243]]; regenerating signs everyone out of `smoked1`).

Secret values come only from the gitignored `.env.smoked1` or the macOS keychain, are piped on stdin, and are
never printed, logged, committed or put on a command line. `.env.hq` and `.env.hq-staging` are never a source:
the user copies a value into `.env.smoked1` first.

Still hard stops on `smoked1`, until the user confirms each: deleting the old `vault-smoked1` resources, DNS
and custom-domain changes, and creating any resource not listed above.

(User rulings: 2026-10-28, 2026-11-13, 2026-11-14, 2026-11-16; [[OPS250]], [[CORE259]], [[OPS262]], [[CORE294]], [[OPS210]].)

**Clerk dev instance.** It is the agents' own for tests and E2E: they may configure it (session-token claims
such as `vibase_role`, OAuth applications, device grant, dynamic client registration) and create and delete
test users on it. (User ruling: 2026-11-02.)

**`hq` and `hq-staging`.** Agents may not use their env files in tests, E2E or scripts. One exception: an
agent working directly with the user may read `.env.hq` to check that it is well formed and fix its formatting
(escape newlines in PEM keys, quoting, stray whitespace); it masks every value in anything it prints, and
never commits, copies or sends the file. (User ruling: 2026-11-03.)

## Identities

- **The owner** is Ori, email `ori@makelinks.co`. Commits in this repo are authored with that email.
- **Issue and board writes** (comments, labels, assignees, close, project fields) go through the
  `zooidbot` identity: `scripts/gh-zooidbot <gh args>`. It reads `ZB_GH_TOKEN` from the gitignored `.env`.
  Never print the token or put it on a command line.
- **Branch pushes, `gh pr create` and `gh pr merge`** use the human's own `gh` login.
- **Merging:** during sprint work the orchestrator merges a cycle's PR once the reviewer has approved it
  and its checks pass (see "Running a sprint"). Every other PR, and any PR outside a sprint, is merged by
  a human.

## Spec IDs

`<AREA><n>` where `n` is the **issue number in `benocodes/crm`** that spawned the spec. Areas:

| Code | Area |
|---|---|
| `CORE` | schema, tenancy, service layer, resources, outbox/events |
| `API` | operation registry, REST, MCP, hooks/webhooks, agent cursor |
| `CHN` | channel adapters: capture (Gmail; later Graph, WhatsApp) and send |
| `AGT` | agent principals, scopes, action requests, approval rules, execution rail |
| `UI` | the email-client pane (Chrome extension beside Gmail), digests |
| `DX` | CLI, starter template, docs for consultants |
| `OPS` | infrastructure, deploy, CI, tooling, skills |

## Stack and commands

The MVP target is D1; the Postgres lines below describe the parked enterprise path.

TypeScript (ESM), **pnpm** workspace, Node >= 22, Vitest. Cloudflare Workers + Hono +
`@hono/zod-openapi`, Kysely on D1 (the single-organisation MVP engine, self-hosted on Cloudflare) or Neon Postgres via Hyperdrive (multi-tenant, cloud-hosted and enterprise), R2, Queues, Workflows. The Vercel AI SDK
is the only LLM library (if the vault ever calls one).

```bash
pnpm install          # at the repo root
pnpm -r test          # all packages (D1 and engine-neutral; the postgres project is off)
pnpm test:postgres    # the parked Postgres suites alone (the `postgres` vitest project; needs a Postgres test database)
pnpm -r typecheck
pnpm lint             # Biome (biome.json): format + lint check, exit 1 on any format diff or lint error; part of the gate
pnpm format           # Biome: apply formatting and safe lint fixes in place (run before committing)
pnpm -C packages/<pkg> test [file]
pnpm db:migrate       # dev database
pnpm db:test:reset    # rebuild the test database (refuses names without "test")
pnpm db:test:worktree # private test database for this worktree
pnpm db:codegen
pnpm -C packages/server-postgres dev               # Postgres dev server (DATABASE_URL, AUTH_PROVIDER)
pnpm -C packages/server-postgres bootstrap -- --org <n> --email <e> --agent <a>
pnpm -C packages/server-postgres smoke:auth        # and smoke:admin; both need SMOKE_EXPECT_DATABASE
pnpm -C packages/api golden:generate               # and golden:check; goldens generated on D1 (Miniflare), review the fixture diff
pnpm -C packages/server-d1 bootstrap -- --org <n> --issuer <CLERK_ISSUER> [--agent <a>]  # local D1 only; Clerk path creates no human (CORE64 D11); `--auth-provider none --auth-org-id <n> --email <e> --agent <a>` keeps the API-key-only owner; `--auth-provider better-auth --public-base-url <url> [--auth-org-id <label>]` creates no human and seeds `vibase-cli` in the control database (CORE283)
pnpm -C packages/server-d1 smoke:worker            # the D1 Worker bundle in workerd (Miniflare), no network; builds the auth pages and the app first
pnpm -C packages/server-d1 build                   # the auth pages and the app (Vite, UI489) into dist/assets/assets/{ui,app}/ (UI504; clears stale old-layout folders; the app's pages are `/app/home`, `/app/accounts`, `/app/agents`, UI507)
pnpm -C packages/server-d1 dev                     # builds, then wrangler dev --local on :8787 and the Vite dev server (HMR) on :5173 in front of it: open http://localhost:5173/app/home; `dev:worker` is the Worker alone
pnpm -C packages/server-d1 test src/ui            # the auth pages' suites (`src/ui/**/*.ui.test.tsx`) on real React in the root `page-ui` project (UI446 D3)
pnpm -C packages/ui test                          # @vibase/ui: the React component suites (`src/components/**/*.ui.test.tsx`, project `ui-components`, UI448, UI447) plus its node-side suites (`engine-neutral`); component suites are `*.ui.test.tsx`, never run by the root shared projects
pnpm changeset                                     # add a changeset (a `.changeset/*.md`); a PR that changes what `@vibase/cli` or `@vibase/server-d1` ships adds one (OPS210 D25; the PR check is #264)
```

These are the commands of everyday work. The rest live in the skill that uses them; read it before running one:

- **Release packages and deployed instances** (`release:build`, `release:check`, the release and version
  workflows, `vibase-server status`, and every `CONFIRM_REMOTE=1` command: `setup:remote`, `db:status:remote`,
  `db:migrate:remote`, `deploy:remote`, `smoke:remote`, `owner-reset`, `e2e:rail`): `ship-branch`, "Command
  reference".
- **Browser E2E scripts** (`e2e:gallery-react`, `e2e:oauth-pages`, `e2e:auth-pages`, `e2e:auth-pages-reset`,
  `e2e:mcp-oauth`, `e2e:approvals-app`; none is in the gate): `writing-tests` §7, "Scripts".

Two rules hold wherever those commands are run. Agents run a remote command only against an environment that
is theirs ("Environments"). Agents never push a release tag, publish the draft GitHub Release, run
`changeset publish` (or `changeset version` outside a scratch copy) or merge the Version Packages PR.

The `db:*` scripts are the contract the skills assume; they arrive with the first CORE cycle.

The development machine is macOS: `sed` is BSD, where `-i` takes a backup suffix as its next argument
(`sed -i '' 's/a/b/' file`), so GNU-style `sed -i 's/a/b/' file` misparses. Prefer the Edit tool for
in-place edits ([[CORE29]] retro).

## Conventions

- Files and folders kebab-case; functions and variables camelCase; types PascalCase; database fields and
  API responses snake_case; environment variables UPPER_SNAKE_CASE.
- Names ([[OPS262]], [[OPS265]]): packages are `@vibase/*`, new local resource names use `vb`, and user-visible
  text says "Vibase". TypeScript identifiers, file names, the `x-vibase-proposal` OpenAPI extension, the
  `vibase.invalid` default `client_ref` domain, test hosts (`vibase.test`) and the `VIBASE_SMOKED1_*` script env vars
  all say Vibase, with no aliases. "The vault" stays the internal term in comments and knowledge prose. What keeps
  `vault`: stored `…@vault.invalid` rows (history, never rewritten), the `vault_*` Postgres roles and
  databases (#266), the existing `vault-<env>` instances (`vault-smoked1`, `vault-hq`, `vault-approvals-hq`:
  [[OPS251]], [[OPS252]]); no code may hard-code a `vault` prefix for anything new. Both setup front-ends derive
  `vb-<env>`, `vb-crm-<env>`, `vb-bodies-<env>` for a new instance and take an existing instance's names from its
  record (settings file, or `wrangler.jsonc`'s env block), refusing a differing name flag ([[OPS276]]).
- UUIDv7 primary keys (`uuid_generate_v7()`), never v4.
- Migrations: Kysely, forward-only, one squashed baseline to start.
- Commits: Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, ...). Branches:
  `<type>/<issue#>-<slug>`.
- Work in a git **worktree** per cycle; never switch branches in the main checkout.
- Reference specs by stable ID (`[[CORE12]]`), never by seq-prefixed folder path.

## Engines (from 2026-10-30)

**D1 is the oracle.** Behaviour, contracts and goldens are defined by the D1 adapter; the MVP ships on it.
The Postgres adapters (`@vibase/storage-postgres`, `@vibase/server-postgres`, `@vibase/db`) are kept alive
because a fuller Postgres adapter is planned (schema per workspace or database per workspace, decided by
plan and size) and shared code must not drift from it:

- Postgres packages stay in the **typecheck and build** gate (blocking, cheap): a change to shared code
  (`@vibase/storage`, `@vibase/api`) must still compile against both adapters.
- Postgres **test suites are off by default** (2026-11-02, OPS92): an engine is a vitest **project**, chosen by the
  file name. `*.postgres.test.ts` runs in the `postgres` project, `*.d1.test.ts` and engine-neutral `*.test.ts` (no
  engine infix) in the default projects, so `pnpm test` and `pnpm -r test` run D1 and engine-neutral suites only and
  need no Postgres database. The one switch is `RUN_POSTGRES_PROJECT` in the root `vitest.config.ts` (projects are
  defined in `vitest.projects.ts`). `pnpm test:postgres` runs the `postgres` project alone, whatever the switch says
  (needs `TEST_DATABASE_URL` / `.env.test.local`); run it when un-parking Postgres, or on demand to see drift
  (non-blocking: a failure is drift to note, never a reason to bend D1 behaviour). **Naming rule:** a test file that
  needs Postgres carries the `.postgres.` infix (`x.integration.postgres.test.ts`); a file with no infix must not
  import `@vibase/db`, `@vibase/storage-postgres` or `pg` directly (a boundary test in `@vibase/storage` enforces it; it sees
  direct imports only, and the runtime is the backstop: the default projects load no Postgres env, so `createTestDb`
  throws `TEST_APP_DATABASE_URL is not set`, unless the shell already exports that variable). A suite
  that proves the same behaviour on both engines is one shared body (`x.integration.suite.ts`, exporting
  `engineSuite(engineName)`) with two entry files (`x.integration.d1.test.ts`, `x.integration.postgres.test.ts`),
  never a flag or a `skipIf`.
- New features are specced and built for D1 only. Do not add Postgres migrations or Postgres-only work;
  where a shared interface changes, keep the Postgres adapter compiling and say what it would need.
- Specs with Postgres or multi-tenant cloud work are marked **parked**, not deleted.

## Load-bearing invariants

Carried over from the predecessor product, where each cost real time. Add new ones through `retrospect`, not ad hoc.

1. **Tenancy is the organisation.** Every tenant table has `organization_id` and `user_id`/actor
   attribution. Postgres enforces it with RLS in the same migration as the table; a D1 deployment is one
   organisation, enforced by the schema ([[CORE35]] D18). See `api-routes` ("Tenancy per engine").
2. **The test harness must not mask tenancy**, and must not leave persistent state on the shared test
   database. See `writing-tests`.
3. **Catching `23505` inside a transaction does not save it**: the transaction is already aborted. Use
   `ON CONFLICT` instead.
4. **Agents act within owner-granted authority** (user revision, 2026-11-05, [[AGT8]]). Per-resource
   `write` includes `request_approval`; `read` is independent. Agents with write permission may send
   directly through the vault, or propose the same registered operation for approval by a user or agent
   with the target write authority. Proposal-only permission never authorises execution. Both paths use the same validation, audit and execution rail;
   provider credentials stay in the vault. This replaces the former "agents never send" rule.
5. **Every write emits an event** to the outbox in the same unit. Nothing else inserts into a
   resource's table except its prepared programs, and nothing but `eventStatement`/`eventSetStatement`
   inserts into `events`. The rule covers *resources* (anything tenant-visible).
   Writes that skip events are allowed only when they are not resources and a spec decision names them:
   identity bookkeeping, channel machinery tables, the `bootstrap` script, the
   execution lease columns, the D1 full-text search indexes, and the
   control-plane database `CONTROL_DB` (`auth_*`, `control_deployment`, `invitations`, `control_audit`, the four `webhook_*` tables, `api_keys`).
   The exact tables and columns, who may write each and the deciding spec are the table in `api-routes`
   ("Writes that emit no event"); read it before writing to any of them. No operation may touch
   `CONTROL_DB` (`control-boundary.test.ts`, [[CORE259]] D5). If such a write has a tenant-visible
   consequence (a membership, a connection's status), that consequence must still emit its event. Add a
   new exception through a spec decision and a row in that table, never ad hoc.
6. **Raw bodies stay out of the database**, Postgres and D1 alike (R2 behind `ObjectStore`).
7. **A workflow step's return value must be structured-cloneable by workerd**, which is stricter than
   Node. Return plain data, never class instances (see `cloudflare-workflows`).
8. **A migration's number can go stale** between plan and implementation; re-check before creating it.
9. **Resolve an operation's anchor at authorisation time, not draft time:** approval time for a
   proposal, submission time for an authorised direct send ([[AGT8]]).
10. **Open packages never import enterprise code** (`@vibase/storage-postgres`, `@vibase/server-postgres`,
    `@vibase/db`, `pg`); `packages/storage/src/import-boundary.test.ts` enforces it, with no allow-list entries for
    `packages/api` ([[CORE35]] D14/D15, [[CORE36]] D22). Postgres composition (dev server, bootstrap, smokes) lives in
    `@vibase/server-postgres`; the golden generator is open code in `@vibase/api` ([[CORE72]]).

## Knowledge hygiene

- `retrospect` closes a cycle and pushes its lessons into skills, this file and `knowledge/`.
- `reconcile-knowledge` closes issue-only work.
- `wiki-lint` audits the knowledge layer for rot and for growth. Run it after a burst of shipped cycles.
- This file is read by every agent on every run and has a budget of 4,000 words (`wiki-lint` check 10). Detail
  belongs in the skill that owns the topic; this file keeps the rule and a pointer. A new user ruling is merged
  into the rule it changes, never appended as a dated paragraph.
