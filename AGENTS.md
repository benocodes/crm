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
**Custom objects are not built in the MVP; the MVP is designed so they fit later** as physical tables with typed columns (no shared `records` table, no jsonb). A
**discoverable schema** (real names, native types, declared FKs; easy for agents and humans to query and
understand) is a core principle.

Read these first (they live in the separate knowledge repo, cloned at `knowledge/`):

- `knowledge/vision.md`: the product idea and who it is for.
- `knowledge/architecture.md`: the backend principles (12 of them) and what is inherited from the predecessor product.

## Repositories

| Repo | Path | Holds |
|---|---|---|
| `benocodes/crm` | this repo | code, skills, issues, the project board |
| `benocodes/crm-knowledge` (private) | `knowledge/` (gitignored here, its own `.git`) | vision, architecture, specs, plans, retros, discussions, `project-state.md` |

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
| Sprint (a band of specs) | `sprint-planning`, `sprint-checkpoint` |
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
e2e-tester (only if the charter has an E2E scenario; on failure: coder → e2e-tester, until it passes) → planner `review` (on changes requested: coder → e2e-tester if any → review; **at most two coder rounds in total**) → planner
`retro` → orchestrator opens the PR, waits for checks, merges (`gh pr merge --squash --delete-branch`),
removes the worktree and its test DB, and checkpoints SPRINT.md. Cycles that build on each other run in
order from an up-to-date `main`.

**Decisions.** Agents decide design questions themselves and record them: in the spec (with the reason),
and as one line in SPRINT.md's Ledger, so the user can review and overturn them later. Where a skill says
to ask the user, the agent decides and records instead.

**Hard stops.** The orchestrator stops, records the situation in SPRINT.md (Position, Open Questions,
Next Action) and tells the user before any of these, and never works around one:

- **money or external accounts:** creating paid or external accounts or resources (Google Cloud, Neon,
  Clerk, Cloudflare resources, the Chrome Web Store, domains);
- **production:** a deploy, or a migration against a production database;
  **Standing exception, `smoked1` (user, 2026-10-28):** the internal single-org D1 instance
  (`--env smoked1`, Worker `vault-smoked1`, `api.smoked1.vibase.ai`) is the agents' own; they may deploy
  and migrate it without stopping, through the guarded `deploy:remote` / `db:migrate:remote` scripts.
  **Extended (user, 2026-11-13, [[OPS250]]):** agents may also generate and set `smoked1`'s own
  `AUTH_SECRET` (Better Auth, [[CORE243]]) as a Worker secret; the value lives only in the gitignored
  `.env.smoked1` or the macOS keychain, is never printed, logged or committed, and may be regenerated (it
  signs everyone out of `smoked1`).
  **Extended (user, 2026-11-13, [[CORE259]], [[OPS262]]):** agents may also create `smoked1`'s resources under
  the `vb-` naming (databases `vb-crm-smoked1` and `vb-control-smoked1`, the Worker `vb-smoked1`, and its
  queues, workflows and buckets named `vb-<kind>-smoked1`), apply the control-plane migrations to them, and
  move `smoked1` onto them (the rename and the Better Auth cutover, [[OPS250]]). Deleting the old
  `vault-smoked1` resources, DNS and custom-domain changes stay hard stops until the user confirms them. New
  installs and every new resource anywhere use `vb-<kind>-<env>` names; `hq` keeps its `vault-hq` names unless
  the user says otherwise, and no code may hard-code a `vault` prefix.
  Creating resources beyond it, DNS, Clerk, and any other environment stay hard stops.
  **Standing exception, Clerk dev instance (user, 2026-11-02):** the Clerk *development* instance whose
  keys are in the gitignored `.env.dev` (`sk_test_`/`pk_test_`, `CLERK_JWT_KEY`, `CLERK_FRONTEND_API_URL`)
  is the agents' own for tests and E2E: they may configure it (session-token claims such as `vibase_role`,
  OAuth applications, device grant, dynamic client registration) and create and delete test users on it.
  The root `.env` holds **live** Clerk keys: never use them in tests, E2E or scripts. Any other Clerk
  instance stays a hard stop.
  **The Vibase team instance (`hq`, 2026-11-03):** production is `--env hq` (Worker `vault-hq`,
  `api.hq.vibase.ai`), a later staging copy is `--env hq-staging` (`api.hq-staging.vibase.ai`). Their Clerk
  keys live in the gitignored `.env.hq` and `.env.hq-staging`; agents never source or print those
  files, and may not use them in tests, E2E or scripts. **Exception (user, 2026-11-03):** an agent working
  directly with the user may read `.env.hq` to check that it is well formed and fix its formatting
  (escape newlines in PEM keys, quoting, stray whitespace); it masks every value in anything it prints, and
  never commits, copies or sends the file. Every deploy, migration or Clerk change on either env is a hard stop (the `smoked1` and
  Clerk-dev exceptions above do not extend to them).
- **public announcements:** releases, posts, emails or messages to people outside the repo;
- **irreversible data changes:** dropping any database other than the vault's own test databases,
  force-pushing, deleting branches the sprint didn't create.

It also stops when the fix loop exhausts its two coder rounds, when an agent is blocked on something no other
agent can resolve, and when the sprint is finished.

## Identities

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
pnpm -C packages/server-d1 smoke:worker            # the D1 Worker bundle in workerd (Miniflare), no network; builds the /connect page first
pnpm release:build [--allow-dirty]                 # the two release packages in packages/release/dist/: vibase-cli-<version>.tgz (@vibase/cli, bin `vibase`) and vibase-server-d1-<version>.tgz (@vibase/server-d1, bin `vibase-server`) plus one SHA256SUMS (OPS210, OPS240); refuses a dirty tree unless --allow-dirty (commit <sha>-dirty); nothing published; not in the gate
pnpm release:check [<cli tarball> <server tarball>]  # verifies and scans both tarballs, npm-installs each into its own directory outside the repo (public registry read), runs the installed `vibase` and `vibase-server`, `npm exec --package`, the exports, the migrations and the Worker in workerd; not in the gate
.github/workflows/release.yml                    # OPS237: `workflow_dispatch` or a `v*` tag runs install, the gate, release:build, release:check and uploads both tarballs and SHA256SUMS (7 days); a tag equal to the version of packages/cli and packages/server-d1 (a changesets `fixed` group, OPS210 D1/D25) then makes a DRAFT GitHub Release (never npm, never published); agents never push the tag, publish the draft or run it except the one post-merge dispatch on main (`pnpm release:ci tag|assets` are its checks). `.github/workflows/version.yml` (push to main) opens the Version Packages PR only; the user merges it
pnpm changeset                                     # add a changeset (a `.changeset/*.md`); a PR that changes what `@vibase/cli` or `@vibase/server-d1` ships adds one (OPS210 D25; the PR check is #264); agents never run `changeset publish`, `changeset version` outside a scratch copy, or merge the Version Packages PR
npx @vibase/server-d1@<version> status --env <name> [--settings <p>] [--secrets-file <p>]  # or `vibase-server status ...` once installed; the server package's bin, never the client's (OPS240; `vibase instance ...` only prints this redirect): verify, settings ~/.config/vibase/instances/<env>.json + <env>.env (mode 600), /health and a read-only tracker select; exit 0 current, 1 behind, 2 refused; reads a remote env, so agents run it only where that env is theirs (same for `upgrade` and `setup`; before a registry publish: `npx --package ./vibase-server-d1-<version>.tgz vibase-server status ...`)
pnpm -C packages/server-d1 build                   # the connect page (UI30) into dist/assets/connect/; `dev` runs it before `wrangler dev --local`
pnpm -C packages/ui test                          # @vibase/ui component suites under Preact (`ui-preact`) and React (`ui-react`) plus its node-side suites (UI254); component suites are `*.ui.test.tsx`, never run by the root shared projects
pnpm -C packages/ui e2e:gallery                   # builds the test-only gallery, serves it on localhost, Playwright screenshots per state in light/dark (forced and emulated) into the gitignored packages/ui/e2e-screenshots/, axe zero violations, keyboard order; not in the gate. If `playwright install chromium` fails (it does on the dev Mac), run with E2E_BROWSER_CHANNEL=chrome (installed Google Chrome)
pnpm -C packages/server-d1 e2e:connect             # Playwright + @clerk/testing against a local Worker and the Clerk dev instance (.env.dev only); not in the gate
pnpm -C packages/server-d1 e2e:mcp-oauth          # MCP OAuth end to end (DCR, consent, delegated agent, revocation) on the Clerk dev instance; same harness, not in the gate
pnpm -C packages/server-d1 e2e:rail -- --base https://api.smoked1.vibase.ai --expect-version <sha>  # on-demand real-cron expiry check, not in the gate; runnable once #173 supplies owner-bound administration of newly added scopes
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> --api-host <host> --owner-email <e> [--auth clerk|none] [--clerk-env-file .env.<name>] [--dry-run]  # one guarded idempotent setup of a self-managed env (OPS65, OPS87); Clerk keys from .env.<name>, never the root .env; --dry-run reads only
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:status:remote -- --env <name>    # applied vs expected; exit 0 only when current (CORE61)
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env <name>   # remote D1 migrations (OPS4); migrate before deploy
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env <name>       # deploy the Worker; /health shows the sha
pnpm -C packages/server-d1 smoke:remote -- --base <url> --phase before|after --expect-version <sha>
```

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
   Writes that skip events are allowed only when they are not resources and a spec decision names them.
   Today that means the list below (no count: it grows by spec decision): identity bookkeeping (`principals`, `users` on first sight, on a provider
   profile refresh and on invitation acceptance, [[CORE3]] D12, [[CORE41]] P11, [[CORE287]] P3), channel machinery tables (credentials, subscriptions,
   sync state and cursors, [[CHN5]] D22; the provider-id maps `message_sources` and `thread_sources`, [[CORE25]] D17), the dev/ops `bootstrap` script ([[CORE15]]), the API-key
   usage stamp (`api_keys.last_used_at` only, at most once a minute, never `updated_at`, [[CORE36]] D17), and
   execution machinery tables' lease columns: claim, dispatch stamp, retry scheduling and lease recovery
   write `action_executions.attempts`, `next_attempt_at`, `lease_until`, `lease_token`, `dispatched_at`,
   `last_error_code` (and the `queued`/`claimed` status they move between) without an event and without
   changing `updated_at`; creation and the final outcome of an execution, and the linked request's
   `executed`/`failed`, are resources and emit `action_execution.created|completed|failed` and
   `action_request.executed|failed` ([[AGT8]] D56); and the D1 full-text search indexes (`<table>_search` FTS5
   tables), written only by triggers on their base table, never by a program, an operation or a script ([[CORE194]] D5); and the webhook machinery tables (`webhook_secrets`, `webhook_dispatch_state`, later `webhook_deliveries`), written by the subscription units, the dispatcher, the sender and the purge without an event and without touching `webhook_subscriptions.updated_at`, while creation, update, deletion, rotation and auto-disable of a subscription emit `webhook.*` ([[API7]] D20); and the built-in auth provider's tables (`auth_*`, in the control-plane database `CONTROL_DB`, control migration 0001, [[CORE259]]; the CRM copy from 0018 is dropped by CRM 0019, [[OPS260]]) and the control marker `control_deployment` (written only by `bootstrap`), written only by Better Auth's handler at `/auth`, by `bootstrap`'s idempotent seed of the first-party `vibase-cli` client and its two resource rows (through Better Auth's own adapter in-process, never hand-written SQL, [[CORE283]]) and later [[OPS250]]'s migration tool, never by a program or an operation, without events and outside the `updated_at` rules; they are deployment-scoped (no `organization_id`), and the `auth_` prefix is reserved and hidden from schema discovery ([[CORE243]] D5); only composition, bootstrap, the control store and the release tooling (binding-to-directory mapping; tracker reads in the local `release:check` only, [[OPS260]]) may touch `CONTROL_DB`, never an operation (`control-boundary.test.ts`, [[CORE259]] D5). Likewise the control-plane `invitations` and `control_audit` (control migration 0002, [[CORE245]], [[CORE259]] D12): written only by the control store, one control batch per change and its audit row, `control_audit` append-only by trigger, no CRM event. If such a write has a tenant-visible consequence (a
   membership, a connection's status), that consequence must still emit its event. Add a new exception
   through a spec decision, never ad hoc.
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
- `wiki-lint` audits the knowledge layer for rot. Run it after a burst of shipped cycles.
