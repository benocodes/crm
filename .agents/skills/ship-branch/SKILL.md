---
name: ship-branch
description: Merge a finished feature branch into main and deploy it to production in the right order — shared test/dev DBs migrated forward first, the full suites green against the SHARED test DB, prod migration before the worker deploy, and the handset loop restarted when mobile-agent changed. Use whenever the user says "ship it", "merge and deploy", "deploy to production", or asks for the commands to get a branch live.
---

# Ship a branch

"Deploy to production" here means **merge to main + manual deploy** — there is no CI on main and
pushing deploys nothing. Give the user every command in full, `cd` included; never "run the prod
migration".

## 1. Pre-merge, from the branch's worktree

1. **LFS.** A fresh worktree holds ~130-byte pointer stubs until `git lfs pull`; they fail every
   document/PDF test with an error that reads as a regression. `ls -la data/documents/` — real files
   are megabytes.
2. **Bring the SHARED databases up to the branch's migrations — `migrate`, never `reset`.** A worktree
   usually tests against its own private DB (`pnpm db:test:worktree` → `donna_test_<worktree>`), so a new
   migration there proves nothing about `donna_test`, which is what `main`'s checkout — and
   `deploy:worker`'s own `vitest run` — use. Skipping this is how a green branch arrives on main as
   `column "…" does not exist` (2026-09-30, migration 100).
   ```bash
   cd <worktree> && DATABASE_URL=postgresql://ori@localhost/donna_test pnpm -C packages/db db:migrate
   cd <worktree> && pnpm -C packages/db db:migrate:dev
   ```
   `db:test:reset` is the wrong tool: it `pg_terminate_backend`s every session on `donna_test`,
   including other agents' concurrent runs. Plain `migrate` only applies what's pending.
   Migrations are forward-only here, so this is safe to do before merge — the column just exists
   early.
3. **Codegen** if a migration landed: `pnpm -C packages/db db:codegen:dev`, and commit
   `types.generated.ts` if it changed.
4. **Suites against the shared DB** (`pgrep -f vitest` first — never two api suites at once on one DB):
   ```bash
   cd <worktree> && TEST_DATABASE_URL=postgresql://ori@localhost/donna_test DATABASE_URL=postgresql://ori@localhost/donna_test pnpm -C packages/api test
   cd <worktree> && TEST_DATABASE_URL=postgresql://ori@localhost/donna_test pnpm -C packages/db test
   cd <worktree> && pnpm -C packages/mobile-agent test     # if it changed
   cd <worktree> && pnpm -C packages/web test              # if it changed
   ```
   Report failures with their output; don't merge past a red suite without the user saying so.
5. **Nothing stray.** `git status` in the worktree. A worktree set up with `pnpm db:test:worktree` keeps
   its private DB in gitignored `.env.test.local` files; an older one may instead have an edited tracked
   `packages/api/.env.test`, which must not be committed. Unrelated uncommitted work → ask before committing it.

## 2. Merge, from the main checkout

```bash
cd /Users/ori/Code/donna && git status && git checkout main && git merge <branch>
```

If the main checkout has foreign uncommitted changes, another session may be working there — stop and
ask; never `git add -A` or a bare `git stash`.

## 3. Deploy, in this order

Each step depends on the one before; list only the steps the diff actually needs.

1. **Prod migration** — only if `packages/db/migrations/` changed. BEFORE the worker: new code writing
   a column that doesn't exist yet fails every request that touches it.
   ```bash
   cd /Users/ori/Code/donna && pnpm -C packages/db db:migrate:prod
   ```
   Destructive SQL on prod needs explicit confirmation — read the migration's `up` first.
2. **API worker** — if `packages/api` (or anything it bundles, e.g. `packages/db` types) changed.
   `deploy:worker` re-runs typecheck + the api suite against `donna_test` first, which is why step 1.2
   matters. Use `deploy:worker:skip-tests` only if the user asks.
   ```bash
   cd /Users/ori/Code/donna && pnpm -C packages/api deploy:worker
   ```
3. **Web** — if `packages/web` changed: `cd /Users/ori/Code/donna && pnpm -C packages/web deploy:pages`
   **Site Worker** — if `packages/site` or the `@donna/shared/public-listing` contract changed, after the
   worker (it reads the API's `/public/sites/*` routes): `cd /Users/ori/Code/donna && pnpm -C packages/site deploy:worker`
4. **Handset loop** — if `packages/mobile-agent` changed. It is a long-running local process, so the
   deploy is a restart, and it goes AFTER the worker (a new client field is harmless to an old server
   only if the server ignores it — don't rely on it). `SIGINT` the running loop (it finishes its cycle
   and releases the run lock), confirm it's gone, then:
   ```bash
   cd /Users/ori/Code/donna && pnpm -C packages/mobile-agent mobile-agent --env=prod run
   ```
   See `mobile-agent-workflows` for process ownership checks.
5. **Chrome extension** — if `packages/chrome-ext` changed, see `chrome-ext-driver-redist`.

## 4. Verify

- Migration: Neon MCP `run_sql` on project `restless-rice-04376324` — e.g. `information_schema.columns`
  for a new column.
- Worker: hit the changed route, or watch the next real event land (a device capture, a run).
- Say plainly what was verified and what wasn't.
- Once prod looks fine, drop the worktree's private DB, then remove the worktree:
  `cd <worktree> && pnpm db:test:worktree --drop`, then
  `cd /Users/ori/Code/donna && git worktree remove <worktree>`.

If the branch is an epic, `epic-retrospect` still owes its RETRO; shipping doesn't replace it.
