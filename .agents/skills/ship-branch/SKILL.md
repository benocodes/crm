---
name: ship-branch
description: Merge a finished feature branch into main and deploy it to production in the right order — shared test/dev databases migrated forward first, suites green against the shared test DB, prod migration before the Worker deploy. Use whenever the user says "ship it", "merge and deploy", "deploy to production", or asks for the commands to get a branch live.
---

# Ship a branch

"Deploy to production" here means **merge to `main` + manual deploy** unless CI is later added; check
`.github/workflows/` before assuming either way. Give the user every command in full, `cd` included; never
"run the prod migration".

The order matters because each step depends on the one before: shared test databases migrated forward,
suites green, prod migration, then the Worker deploy. New code that writes a column production doesn't have
yet fails every request that touches it.

## 1. Pre-merge, from the branch's worktree

1. **Bring the SHARED databases up to the branch's migrations: `migrate`, never `reset`.** A worktree
   usually tests against its own private DB (`pnpm db:test:worktree`), so a new migration there proves
   nothing about the shared test DB, which is what `main`'s checkout and the deploy script's test run use.
   Skipping this is how a green branch arrives on `main` as `column "…" does not exist`.
   ```bash
   cd <worktree> && DATABASE_URL=<shared test DB url> pnpm -C packages/db db:migrate
   cd <worktree> && pnpm -C packages/db db:migrate:dev
   ```
   `db:test:reset` is the wrong tool here: it terminates every session on the shared test DB, including
   other agents' concurrent runs. Plain `migrate` only applies what's pending. Migrations are
   forward-only, so this is safe before merge; the column just exists early.
2. **Codegen** if a migration landed: `pnpm -C packages/db db:codegen`, and commit `types.generated.ts` if
   it changed.
3. **Suites against the shared DB.** Check `pgrep -f vitest` first: never two API suites at once on one
   database, and run the `db` and `api` suites serially, not in parallel.
   ```bash
   cd <worktree> && TEST_DATABASE_URL=<shared test DB url> pnpm -C packages/db test
   cd <worktree> && TEST_DATABASE_URL=<shared test DB url> pnpm -C packages/api test
   cd <worktree> && pnpm -r typecheck
   ```
   Report failures with their output; don't merge past a red suite without the user saying so.
4. **Nothing stray.** `git status` in the worktree. Unrelated uncommitted work: ask before committing it.

## 2. Merge, from the main checkout

```bash
cd <repo root> && git status && git checkout main && git pull && git merge <branch>
```

If the main checkout has foreign uncommitted changes, another session may be working there: stop and ask.
Never `git add -A` or a bare `git stash`. If the project requires PRs for `main` (it is branch-protected),
the user merges the PR on GitHub instead and you start from `git pull` here.

## 3. Deploy, in this order

List only the steps the diff actually needs.

1. **Prod migration**, only if `packages/db/migrations/` changed, and BEFORE the Worker:
   ```bash
   cd <repo root> && pnpm -C packages/db db:migrate:prod
   ```
   Destructive SQL on prod needs explicit confirmation; read the migration's `up` first. Prod is a Neon
   project: migrations go through the deploy flow or the Neon tooling, never a casual local run against a
   shared database.
2. **API Worker**, if `packages/api` (or anything it bundles, e.g. `packages/db` types) changed. The deploy
   script re-runs typecheck and the API suite first, which is why step 1.1 matters. Use the skip-tests
   variant only if the user asks.
   ```bash
   cd <repo root> && pnpm -C packages/api deploy:worker
   ```
3. **Other Workers and bindings**: the Workflow, Queue consumers and cron triggers that ship with the API
   Worker deploy with it; a separately deployed Worker (MCP, hook delivery) goes after the API Worker,
   since it calls the API. If `wrangler.toml` gained a binding (a new Queue, R2 bucket, Hyperdrive config),
   create the resource first.
4. **Starter template or Chrome extension pane**, if those packages changed: their own deploy scripts, after the
   API Worker.

### The D1 instance (`smoked1`)

The D1 Worker (`packages/server-d1`, [[OPS4]]) deploys separately from the main instance's steps above:

1. Only when `packages/storage-d1/migrations/` changed: `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env smoked1`.
2. `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env smoked1` (clean tree; runs typecheck and the suite).
3. `curl https://api.smoked1.vibase.ai/health` shows the deployed sha in `version`.

After the OPS4 cycle these are hard stops again for agents unless the user extends OPS4 spec D2 (U4).

To watch it: `pnpm -C packages/server-d1 exec wrangler tail --env smoked1 --format pretty`. With `--env`, pass **no**
Worker name: wrangler appends the env to a given name (`vault-smoked1` becomes `vault-smoked1-smoked1`, error `10007`
"Worker does not exist"). Rollback is `wrangler rollback --env smoked1`, Worker only; the database is never rolled back.

## 4. Verify

- **Migration:** query `information_schema.columns` (via the Neon tooling) for the new column or table.
- **Worker:** hit the changed route, or watch the next real event land (a captured mail, a delivered
  webhook). `wrangler tail <worker> --format=pretty` while you do.
- Say plainly what was verified and what wasn't.
- Once prod looks fine, drop the worktree's private database and remove the worktree:
  `cd <worktree> && pnpm db:test:worktree --drop`, then `cd <repo root> && git worktree remove <worktree>`.

If the branch implements a cycle, [[retrospect]] still owes its RETRO; shipping doesn't replace it.
