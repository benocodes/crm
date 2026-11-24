---
name: ship-branch
description: Merge a finished feature branch into main and deploy it to production in the right order — shared test/dev databases migrated forward first, suites green against the shared test DB, prod migration before the Worker deploy. Use whenever the user says "ship it", "merge and deploy", "deploy to production", or asks for the commands to get a branch live. Also holds the command reference for release packages and for every remote command against a deployed instance (setup, status, migrate, deploy, smoke, owner reset); read it before running one.
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
5. **Close what it delivers.** The PR body starts with one `Closes benocodes/crm#<n>` per issue the PR finishes:
   the cycle's own issue, and the spec's issue too on the spec's last cycle. An issue closed by hand later
   (merged without the line) is closed as `zooidbot` with a comment naming the PR.

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

0. `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:status:remote -- --env smoked1` prints applied versus
   expected and exits 0 only for `current` ([[CORE61]]).
1. When the status is `behind` (or `packages/storage-d1/migrations/` changed): `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env smoked1`.
   This always comes before the deploy: a Worker whose manifest is ahead of the database answers
   `503 migrations_pending` on every route but `/health` and the two OpenAPI documents (`/api/v1/openapi.json`, `/meta/v1/openapi.json`, [[API32]]).
2. `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env smoked1` (clean tree; runs typecheck and the suite).
3. `curl https://api.smoked1.vibase.ai/health` shows the deployed sha in `version`: the **full** `git rev-parse HEAD`.
4. `pnpm -C packages/server-d1 smoke:remote -- --base https://api.smoked1.vibase.ai --phase after --expect-version "$(git rev-parse HEAD)"`.
   `--expect-version` needs the full 40-character sha; a short one never matches ([[CORE77]] ship).

`smoked1` only: agents may run these under AGENTS.md, "Environments", which is the one statement of what they may
do there. Any other env, and creating resources beyond that list, stays a hard stop. Since [[OPS65]], `setup:remote -- --env smoked1 --auth none --api-host
api.smoked1.vibase.ai --dry-run` is a read-only check of the whole env: every step `ok`, except `deploy: update` (and
`verify: blocked`) while HEAD is not what `smoked1` runs.

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

## 5. Command reference: release packages and deployed instances

The commands AGENTS.md's "Stack and commands" leaves out. None is in the gate.

**Who may run what.** Agents run a remote command (anything with `CONFIRM_REMOTE=1`, `vibase-server status`,
`upgrade`, `redeploy`, `setup` or `owner-reset`, `smoke:remote`, `e2e:rail`) only against an environment that is theirs: today `smoked1`
(AGENTS.md, "Environments"). Agents pass `--yes` to every real `vibase-server` run (an agent's shell has no terminal, and the flag makes the intent visible; OPS493). Agents never push a release tag, publish the draft GitHub Release, run
`changeset publish` (or `changeset version` outside a scratch copy) or merge the Version Packages PR.

**Credentials for `smoked1` (#380).** The remote scripts (`setup:remote`, `db:status:remote`, `db:migrate:remote`,
`deploy:remote`, `bootstrap --remote`, `smoke:remote --phase after`, `e2e:rail`) read `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN` and `VIBASE_SMOKED1_VB_OPERATOR_KEY` for `--env smoked1` from the gitignored `.env.smoked1` at the
repo root of the checkout they run in, never from the root `.env` (process variables still win; a refusal names
`.env.smoked1`). A fresh worktree has none (the file is gitignored), so copy it from the main checkout before the first
remote command: `cp /Users/ori/Code/crm/.env.smoked1 .env.smoked1` (run from the worktree root; the standing `smoked1`
exception allows it; never print it). **Never copy or symlink the root `.env`** (it holds live Clerk keys). `hq` and
`hq-staging` files are never sourced by any script, and no script reads the root `.env` for them either.

### Release packages

```bash
pnpm release:build [--allow-dirty]                 # the two release packages in packages/release/dist/: vibase-cli-<version>.tgz (@vibase/cli, bin `vibase`) and vibase-server-d1-<version>.tgz (@vibase/server-d1, bin `vibase-server`) plus one SHA256SUMS (OPS210, OPS240); refuses a dirty tree unless --allow-dirty (commit <sha>-dirty); nothing published; not in the gate
pnpm release:check [<cli tarball> <server tarball>]  # verifies and scans both tarballs, npm-installs each into its own directory outside the repo (public registry read), runs the installed `vibase` and `vibase-server`, `npm exec --package`, the exports, the migrations and the Worker in workerd; not in the gate. A changed `vibase-server` usage line has TWO needles to follow: `packages/release/src/help-assertions.ts` (unit-tested) and a separate regex in `packages/release/scripts/check.ts` (seen only by a real run; OPS501's first two runs failed on it)
.github/workflows/release.yml                    # OPS237: `workflow_dispatch` or a `v*` tag runs install, the gate, release:build, release:check and uploads both tarballs and SHA256SUMS (7 days); a tag equal to the version of packages/cli and packages/server-d1 (a changesets `fixed` group, OPS210 D1/D25) then makes a DRAFT GitHub Release (never npm, never published); agents never push the tag, publish the draft or run it except the one post-merge dispatch on main (`pnpm release:ci tag|assets` are its checks). `.github/workflows/version.yml` (push to main) opens the Version Packages PR only; the user merges it
pnpm changeset                                     # add a changeset (a `.changeset/*.md`); a PR that changes what `@vibase/cli` or `@vibase/server-d1` ships adds one (OPS210 D25; the PR check is #264); agents never run `changeset publish`, `changeset version` outside a scratch copy, or merge the Version Packages PR
npx @vibase/server-d1@<version> init --env <name> --api-host <host> [--owner-email <e>] [--auth better-auth|clerk|none] [--email gmail|none] [--gcp-project <id>] [--secrets-file <p>] [--yes]  # OPS494, OPS501: local only; writes a NEW instance's settings file `<env>.json` (`stage: "init"`: api_host, auth, owner_email; replaced atomically on a rerun) then its secrets file (mode 600, exclusive create, generated AUTH_SECRET/CREDENTIALS_KEY/OAUTH_STATE_SECRET, empty lines to fill, never prints a generated value), and prints `setup --env <name>` (plus --secrets-file only when given) to run next; refuses an existing secrets file, a set-up instance's full record (never regenerate its secrets, smoked1's included) or an unparseable settings file; status/upgrade/redeploy/owner-reset refuse an init-written file ("not set up yet"); setup keeps Gmail off while neither GOOGLE_CLIENT_ID nor GOOGLE_CLIENT_SECRET is set
npx @vibase/server-d1@<version> status --env <name> [--settings <p>] [--secrets-file <p>]  # or `vibase-server status ...` once installed; the server package's bin, never the client's (OPS240; `vibase instance ...` only prints this redirect): verify, settings ~/.config/vibase/instances/<env>.json + <env>.env (mode 600), /health and a read-only tracker select; exit 0 current, 1 behind, 2 refused; reads a remote env, so agents run it only where that env is theirs (same for `upgrade`, `redeploy` and `setup`; before a registry publish: `npx --package ./vibase-server-d1-<version>.tgz vibase-server status ...`)
npx @vibase/server-d1@<version> setup --env <name> [--api-host <host> | --workers-dev] [--auth better-auth|clerk|none] [--owner-email <e>] [--dry-run] [--yes]  # OPS501: host, provider and owner email default to init's file or the instance's record (a differing flag is refused; a new instance without init's file still needs a host flag; setup:remote always does); config:write adopts init's file and records owner_email once. OPS496: verify asks the Cloudflare API (Worker VERSION/COMMIT and recorded vars, secret names, custom domain or workers.dev subdomain, both trackers, bucket; first failure exits 3), then ONE 10 s /health read: no answer is ok `not reachable yet` (exit 0, a DNS line last for a custom domain), a wrong answer exits 3. Nothing before verify may contact https://<host> (the newer-live check and the deploy skip read the Worker's settings through `scripts/instance/cf-api.ts`): an early lookup of a hostname whose record does not exist yet poisons the machine's negative DNS cache. A missing Worker is Cloudflare error code 10007. Ends with the owner invitation, or why there is none
npx @vibase/server-d1@<version> upgrade --env <name> [--dry-run] [--yes]    # OPS210/OPS234: from the installed package, migrate (control, then CRM), deploy its own Worker, verify /health (version and commit), keyless smoke; asks `proceed? [Y/n]` after the plan (OPS493: agents pass `--yes`); exit 0 done or nothing to do, 2 refused (older or unknown schema, newer live version, or same version from a different build: `same version, different build: live <sha>, package <sha>`, pointing at redeploy), 3 failed after a write began
npx @vibase/server-d1@<version> redeploy --env <name> [--extensions <path>] [--dry-run] [--yes]   # CORE543: --extensions validates the file, records its absolute path in the settings (`extensions`, only on a real run), applies it to the remote D1 (planned before the question; refusals exit 2 with no write; statements after core migrations, before the deploy) and stages it beside worker.js; later redeploy/upgrade runs reuse the recorded path (upgrade has no flag); a live file with none in the run is exit 2 (pass --extensions, or a file with no objects); verify polls /health until version, commit, migrations and the `extensions` digest match (/health lags an upload by seconds); status prints the live digest. OPS487: put THIS package's build on the instance whatever is live (a new build of the same version, the same build, or an older package: the rollback); applies only the migrations the instance lacks, never reverses one, refuses no version or schema, prints one note when the schema is newer than the build; same guards and exit codes as upgrade; `upgrade --rollback` is gone
```

### Deployed instances

Migrate before deploy; the `smoked1` order and its checks are in section 3 above.

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> (--api-host <host> | --workers-dev) --owner-email <e> [--auth better-auth|clerk|none] [--clerk-env-file .env.<name>] [--register-workers-subdomain <name>] [--change-host] [--dry-run]  # one guarded idempotent setup of a self-managed env (OPS65, OPS87, OPS249, OPS306); `better-auth` is the default for a new instance (a recorded instance keeps its provider); the instance's own env file .env.<name> holds Clerk keys, `AUTH_SECRET` and the optional Google pair, never the root `.env`; --dry-run reads only
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> --replace-instance <name> (--api-host <host> | --workers-dev) --owner-email <e> [--auth better-auth|clerk|none] [--dry-run]  # OPS250 D12: a fresh instance on derived vb-<kind>-<name> names (MAIL_SYNC on vb-mail-sync-<name>) in place of a recorded one; refused before any call if the value differs from --env, the env has no record, a new name equals a recorded one, or .env.<name> already holds AUTH_SECRET; touches and deletes nothing old (a `manual:` line lists it as left in place); the record is swapped last and the run stops there, so a plain setup:remote run follows to migrate, bootstrap and invite the owner (its pre-deploy test step runs `src/wrangler-config.test.ts`, which pins each recorded env block: update the pins after the record write, OPS251); setup:remote only, not vibase-server setup
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset [--email <owner>]  # OPS307: owner recovery for a Better Auth instance, from `.env.<name>`'s `AUTH_SECRET` (never the root `.env`): prints a one-time owner reset link (`vibase-server owner-reset --env <name> [--email <owner>] [--dry-run]` from a release, exit 0/2/3), or with no owner an owner invitation for `--email`; printed once, stored nowhere; no remote run by agents except on `smoked1`. The reset link lives about 5 minutes: issue it only when the browser step can follow at once, with no approval wait in between (CHN433, #437). With an owner named by `--email` it writes only a reset verification row and an audit row; only the no-owner path (an invitation) revokes live owner invitations (`scripts/owner-reset.ts`, CHN433 433.9). That path (like `bootstrap --owner-email`) revokes every live owner invitation, and `invitations.create` needs a human owner session, so an unclaimed first invitation cannot gain a second owner beside it: pass the right `--owner-email` to setup, or claim the first and invite from that session (OPS251 decisions 251.12, 251.13)
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:status:remote -- --env <name>    # applied vs expected; exit 0 only when current (CORE61)
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env <name>   # remote D1 migrations (OPS4); migrate before deploy
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env <name>       # deploy the Worker; /health shows the sha
pnpm -C packages/server-d1 smoke:remote -- --base <url> --phase before|after --expect-version <sha>
pnpm -C packages/server-d1 e2e:rail -- --base https://api.smoked1.vibase.ai --expect-version <sha>  # on-demand real-cron expiry check, not in the gate; runnable once #173 supplies owner-bound administration of newly added scopes
```
