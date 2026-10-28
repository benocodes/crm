# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A **headless CRM** (working name: the vault). No app of its own: every interaction (email, calendar,
WhatsApp, later calls and iMessage) lands in one database (single-organisation D1 per self-hosted deployment; multi-tenant Postgres for the cloud-hosted and enterprise service), agents the customer
brings read it over REST, MCP or hooks, and they **propose** actions as action requests that a person or a
rule approves; the vault executes. The only screen is a pane in the user's email client.

Read these first (they live in the separate knowledge repo, cloned at `knowledge/`):

- `knowledge/vision.md`: the product idea and who it is for.
- `knowledge/architecture.md`: the backend principles (12 of them) and what is inherited from the predecessor product.

## Repositories

| Repo | Path | Holds |
|---|---|---|
| `benocodes/crm` | this repo | code, skills, issues, the project board |
| `benocodes/crm-knowledge` (private) | `knowledge/` (gitignored here, its own `.git`) | vision, architecture, specs, plans, retros, discussions, `project-state.md` |

The delivery board is the GitHub project **CRM**: https://github.com/users/benocodes/projects/2 (IDs and
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
| Plan | `tdd-cycle-generator` |
| Deliver features / bugs | `work-on-ready-issues` / `fix-bugs` |
| Pause mid-cycle | `handoff` |
| Close a cycle | `retrospect` |
| Close issue work | `reconcile-knowledge` |
| Knowledge audit | `wiki-lint` |
| Ship | `ship-branch` |

Domain skills: `db-schema-and-migrations`, `api-routes`, `writing-tests`, `hyperdrive-pg-rls`, `cloudflare-workflows`.

**Vocabulary.** A **cycle** is one unit of work: a folder under `knowledge/specs/` that ends in one
branch, one retro and (usually) one PR. A **spec** is the design (*what and why*); a spec can be
delivered by several cycles.

## Running a sprint (orchestration)

Spec and cycle work in a sprint runs **unattended**, driven by an orchestrator session that delegates
every stage to subagents so its own context stays clean. Open design discussion with the user, and work
on a single issue (`fix-bugs`, `work-on-ready-issues`), are not orchestrated: do them directly.

**Who does what** (definitions in `.claude/agents/`):

| Agent | Model | Job |
|---|---|---|
| `orchestrator` | Opus | The main session (`claude --agent orchestrator`). Picks the next item from `knowledge/SPRINT.md`, briefs the others, merges approved PRs, keeps SPRINT.md current. Reads reports, not code. |
| `planner` | Opus | Modes: `spec` (draft and approve a spec), `plan` (`tdd-cycle-generator`), `review` (the diff against PLAN and spec), `retro` (`/retrospect` and ingest). |
| `coder` | Sonnet | Executes a PLAN's Phases 0–3 plus the Phase 4 gate (all suites, typecheck, build; must be green) in the cycle's worktree; applies review findings. |
| `e2e-tester` | Sonnet | Runs a PLAN's E2E scenario (initial state, real actions, expected end state) against a real database or UI, only when the PLAN has one, and reports evidence. Never edits. |

Subagents cannot start subagents, so the orchestrator must be the main session, never a subagent.

**Per cycle:** planner `spec` (if the spec isn't approved) → planner `plan` → coder (gate green) →
e2e-tester (only if the PLAN has an E2E scenario; on failure: coder → e2e-tester, until it passes) → planner `review` (on changes requested: coder → e2e-tester if any → review; **at most two coder rounds in total**) → planner
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

TypeScript (ESM), **pnpm** workspace, Node >= 22, Vitest. Cloudflare Workers + Hono +
`@hono/zod-openapi`, Kysely on D1 (the single-organisation MVP engine, self-hosted on Cloudflare) or Neon Postgres via Hyperdrive (multi-tenant, cloud-hosted and enterprise), R2, Queues, Workflows. The Vercel AI SDK
is the only LLM library (if the vault ever calls one).

```bash
pnpm install          # at the repo root
pnpm -r test          # all packages
pnpm -r typecheck
pnpm -C packages/<pkg> test [file]
pnpm db:migrate       # dev database
pnpm db:test:reset    # rebuild the test database (refuses names without "test")
pnpm db:test:worktree # private test database for this worktree
pnpm db:codegen
pnpm -C packages/server-postgres dev               # Postgres dev server (DATABASE_URL, AUTH_PROVIDER)
pnpm -C packages/server-postgres bootstrap -- --org <n> --email <e> --agent <a>
pnpm -C packages/server-postgres smoke:auth        # and smoke:admin; both need SMOKE_EXPECT_DATABASE
pnpm -C packages/server-postgres golden:generate   # and golden:check
pnpm -C packages/server-d1 bootstrap -- --org <n> --email <e> --agent <a> --auth-org-id <org_…>  # local D1 only
pnpm -C packages/server-d1 smoke:worker            # the D1 Worker bundle in workerd (Miniflare), no network
```

The `db:*` scripts are the contract the skills assume; they arrive with the first CORE cycle.

The development machine is macOS: `sed` is BSD, where `-i` takes a backup suffix as its next argument
(`sed -i '' 's/a/b/' file`), so GNU-style `sed -i 's/a/b/' file` misparses. Prefer the Edit tool for
in-place edits ([[CORE29]] retro).

## Conventions

- Files and folders kebab-case; functions and variables camelCase; types PascalCase; database fields and
  API responses snake_case; environment variables UPPER_SNAKE_CASE.
- UUIDv7 primary keys (`uuid_generate_v7()`), never v4.
- Migrations: Kysely, forward-only, one squashed baseline to start.
- Commits: Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, ...). Branches:
  `<type>/<issue#>-<slug>`.
- Work in a git **worktree** per cycle; never switch branches in the main checkout.
- Reference specs by stable ID (`[[CORE12]]`), never by seq-prefixed folder path.

## Load-bearing invariants

Carried over from the predecessor product, where each cost real time. Add new ones through `retrospect`, not ad hoc.

1. **Tenancy is the organisation.** Every tenant table has `organization_id` and `user_id`/actor
   attribution. Postgres enforces it with RLS in the same migration as the table; a D1 deployment is one
   organisation, enforced by the schema ([[CORE35]] D18). See `api-routes` ("Tenancy per engine").
2. **The test harness must not mask tenancy**, and must not leave persistent state on the shared test
   database. See `writing-tests`.
3. **Catching `23505` inside a transaction does not save it**: the transaction is already aborted. Use
   `ON CONFLICT` instead.
4. **Agents never send.** Agents submit action requests; the vault executes them with credentials it holds.
5. **Every write emits an event** to the outbox in the same unit. Nothing else inserts into a
   resource's table except its prepared programs, and nothing but `eventStatement`/`eventSetStatement`
   inserts into `events`. The rule covers *resources* (anything tenant-visible).
   Writes that skip events are allowed only when they are not resources and a spec decision names them.
   Today that means four: identity bookkeeping (`principals`, `users` on first sight and on a provider
   profile refresh, [[CORE3]] D12, [[CORE41]] P11), channel machinery tables (credentials, subscriptions,
   sync state and cursors, [[CHN5]] D22), the dev/ops `bootstrap` script ([[CORE15]]), and the API-key
   usage stamp (`api_keys.last_used_at` only, at most once a minute, never `updated_at`, [[CORE36]] D17). If such a write has a tenant-visible consequence (a
   membership, a connection's status), that consequence must still emit its event. Add a new exception
   through a spec decision, never ad hoc.
6. **Raw bodies stay out of the database**, Postgres and D1 alike (R2 behind `ObjectStore`).
7. **A workflow step's return value must be structured-cloneable by workerd**, which is stricter than
   Node. Return plain data, never class instances (see `cloudflare-workflows`).
8. **A migration's number can go stale** between plan and implementation; re-check before creating it.
9. **Resolve an approval's anchor at approval time, not draft time.**
10. **Open packages never import enterprise code** (`@vault/storage-postgres`, `@vault/server-postgres`,
    `@vault/db`, `pg`); `packages/storage/src/import-boundary.test.ts` enforces it, with no allow-list entries for
    `packages/api` ([[CORE35]] D14/D15, [[CORE36]] D22). Postgres composition (dev server, bootstrap, smokes, golden
    generator) lives in `@vault/server-postgres`.

## Knowledge hygiene

- `retrospect` closes a cycle and pushes its lessons into skills, this file and `knowledge/`.
- `reconcile-knowledge` closes issue-only work.
- `wiki-lint` audits the knowledge layer for rot. Run it after a burst of shipped cycles.
