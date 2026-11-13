# @vibase/server-d1

Vibase as a Cloudflare module Worker on **one D1 database**: one organisation per deployment, the open tier
(licence: Apache-2.0, as declared in `package.json` today; nothing more is claimed here). It is the self-hosted
shape of Vibase. Agents you bring read and propose over REST; Vibase executes.

This package holds the Worker entry (`src/worker.ts`), its composition (`src/compose.ts`), the local bootstrap CLI and
`wrangler.jsonc`. The storage engine is `@vibase/storage-d1`; the API is `@vibase/api`.

## Requirements

- Node >= 22 and pnpm (see the repo root `package.json`).
- Everything below runs **locally**: `wrangler dev --local` and a local D1 in `.wrangler/state`. It needs no
  Cloudflare account, no login and no network.

## Local quickstart

From the repository root, after `pnpm install`:

```bash
export WRANGLER_SEND_METRICS=false CI=1

# 1. Apply the migrations to the local D1 (0001 to 0004).
pnpm -C packages/server-d1 exec wrangler d1 migrations apply DB --local

# 2. Create the deployment marker, the first organisation and an operator agent. The key is printed once. A Clerk-backed deployment
#    creates no human: the owner signs in with a Clerk session token whose `vibase_role` claim is `owner` (CORE64). --issuer is the
#    Worker's CLERK_ISSUER. For an API-keys-only local run: --auth-provider none --auth-org-id org_local --email owner@example.com --agent my-agent
pnpm -C packages/server-d1 bootstrap -- --org "Acme" --issuer https://clerk.example.com --agent my-agent

# 3. Start the Worker locally (leave it running; stop it with Ctrl-C).
pnpm -C packages/server-d1 dev   # builds the connect page first; or: build, then `wrangler dev --local --port 8787`
```

In another terminal, with `KEY` set to the `vk_...` key step 2 printed:

```bash
curl http://localhost:8787/health
# {"status":"ok","initialised":true,"version":"dev","migrations":{"status":"unknown","applied":0,"expected":4,"latest_applied":null,"latest_expected":"0004_messaging_model.sql"}}
# (`unknown` locally: `bootstrap` applies the migration files without wrangler, so there is no d1_migrations tracker)

curl -H "authorization: Bearer $KEY" http://localhost:8787/api/v1/tasks
# {"data":[], ...}

# A resolve batch is capped at 100 identities: 101 are refused (400 validation_error), nothing is written.
node -e 'console.log(JSON.stringify({identities:Array.from({length:101},(_, i)=>({kind:"email",value:`p${i}@example.com`}))}))' \
  | curl -s -X POST -H "authorization: Bearer $KEY" -H "content-type: application/json" --data-binary @- http://localhost:8787/identities/resolve
```

## The MCP endpoint

The Worker serves a remote MCP endpoint at `<api origin>/mcp` [[API106]]: stateless Streamable HTTP, JSON responses, one tool per Vibase operation
the caller's scopes allow (`schema_get`, `contacts_create`, ...). An API key works as a static header, for any MCP client that can send one:

```bash
curl -s -X POST http://localhost:8787/mcp -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Claude Code: claude mcp add --transport http vibase http://localhost:8787/mcp --header "Authorization: Bearer $KEY"
```

A request carrying an `Origin` header must come from `CORS_ALLOWED_ORIGINS` (empty: every browser is refused; clients with no `Origin` are unaffected).

**OAuth sign-in** ([[API115]]): with Clerk configured, a standard MCP client given only `<origin>/mcp` signs a person in with no static key. Its first
request is `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="<read and write scopes>"`;
the document names the Clerk issuer, the client registers itself (DCR), the person consents on Clerk's screen, and the token resolves to a delegated
agent for that (client, person) that an owner can disable on `/connect`. `/.well-known/vibase` carries the URL as `mcp`, and the three discovery
documents answer a browser's `OPTIONS` preflight. `pnpm -C packages/server-d1 e2e:mcp-oauth` proves the whole flow (Playwright, Clerk dev instance, `.env.dev` only).

## The connect page

Every deployment serves **`/connect`** on its own API origin ([[UI30]]): sign in through Clerk's Account Portal, see who you are and how to
connect an agent (`vibase login --server <origin>`, the API-key fallback, the MCP URL, which every instance advertises), and, as an owner,
disable or enable connected agents. With no `CLERK_PUBLISHABLE_KEY` it says sign-in is not configured and shows the API-key directions. It
calls only `me.get`, `agents.list` and `agents.update`, with a Clerk session token as a Bearer header, so the server's scopes decide everything.

```bash
pnpm -C packages/server-d1 build        # bundles src/connect/ into dist/assets/connect/ (gitignored); dev, smoke:worker and deploy:remote do it first
pnpm -C packages/server-d1 dev          # build, then wrangler dev --local on :8787; open http://localhost:8787/connect
# E2E (Playwright + @clerk/testing, Clerk development instance, keys from the gitignored .env.dev only; not part of `pnpm test`):
pnpm -C packages/server-d1 exec playwright install chromium
pnpm -C packages/server-d1 e2e:connect
```

The E2E's Account Portal step signs in with a Backend-API sign-in token (`__clerk_ticket` on the portal URL), which works whatever sign-in methods the development instance offers; it does not rely on an email-code or password route.

Locally set `CLERK_AUTHORIZED_PARTIES=http://localhost:8787` and `CLERK_PUBLISHABLE_KEY` in `.dev.vars` (see `.dev.vars.example`).

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | the database; `migrations_dir` points at `packages/storage-d1/migrations` |
| `AUTH_PROVIDER` | var | empty: agent-only (API keys). `clerk`: also accept Clerk session tokens; the role is the `vibase_role` claim ([[CORE64]]), there is no webhook |
| `CORS_ALLOWED_ORIGINS` | var | comma-separated origins for the email-client pane; empty allows none |
| `CLERK_ISSUER` | var | public value, required with `AUTH_PROVIDER=clerk` |
| `CLERK_AUTHORIZED_PARTIES` | var | optional on D1: comma-separated origins allowed as a session token's `azp`; unset, a token carrying an `azp` is 401. The connect page's own origin must be listed (`setup:remote` adds `https://<api-host>`; locally `http://localhost:8787`) |
| `CLERK_PUBLISHABLE_KEY` | var | public; returned as `auth.publishable_key` by `/.well-known/vibase` for the connect page. Its Frontend API host must be `CLERK_ISSUER`'s, or every request is `500 internal` (the variable is named, the value never). Unset: the page says sign-in is not configured |
| `ASSETS` | assets binding | the built connect page (`dist/assets/connect/`), served only under `/connect*` by the Worker, which adds the security headers |
| `CLERK_JWT_KEY`, `CLERK_SECRET_KEY` | secrets | required with `AUTH_PROVIDER=clerk`; the key is a PEM (line breaks, or `\n` escapes, optionally quoted) |
| `AUTH_ROLE_CLAIM` | var | the session-token claim holding `owner`, `member` or `agent`; default `vibase_role`; an empty value fails closed |
| `AUTH_CLI_CLIENT_ID` | var | the first-party CLI's public OAuth client id; its tokens act as the signed-in person, any other OAuth client is a delegated agent ([[CORE77]]). Unset: no CLI client; set but blank fails closed |
| `CLERK_API_URL` | var | optional |
| `GOOGLE_CLIENT_ID` | var | the Google OAuth client id of the Gmail channel; one of the four core Gmail names (all four or none); set by `setup:remote` from `.env.<env>` |
| `GOOGLE_CLIENT_SECRET` | secret | the Google OAuth client secret; core; set by `setup:remote` from `.env.<env>` (`wrangler secret bulk`) |
| `OAUTH_STATE_SECRET` | secret | signs the OAuth `state` of the connect flow; core; set by `setup:remote` from `.env.<env>` |
| `CREDENTIALS_KEY` | secret | base64, exactly 32 bytes: encrypts stored channel credentials; core; put once, never replaced by `setup:remote` (not even with `--rotate-secrets`); set by `setup:remote` from `.env.<env>` |
| `CREDENTIALS_KEY_VERSION` | var | positive integer naming the key in use (rotation raises it, [[CHN5]] D4); optional; set by `setup:remote` from `.env.<env>` |
| `GMAIL_TOPIC_NAME` | var | `projects/<p>/topics/<t>`, the Pub/Sub topic Gmail watches publish to; optional; set by `setup:remote` from `.env.<env>` |
| `GMAIL_PUSH_SUBSCRIPTION` | var | `projects/<p>/subscriptions/<s>`, the push subscription; a push whose body names another subscription is refused; optional; set by `setup:remote` from `.env.<env>` |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | var | the service account email Pub/Sub signs push requests as; a push token for any other `email` is refused; optional; set by `setup:remote` from `.env.<env>` |
| `MAIL_SYNC` | Workflow binding | the sync run. Push is **on** only with Gmail configured, this binding, and all four of `GMAIL_TOPIC_NAME`, `GMAIL_PUSH_SUBSCRIPTION`, `GMAIL_PUSH_SERVICE_ACCOUNT` and `PUBLIC_BASE_URL` set and well formed (one parser, shared with `setup:remote`). Off: `POST /gmail/push` answers `404`, no watch is registered or renewed; a partly set group logs `push is off: set or fix <names>` at startup |
| `PUBLIC_BASE_URL` | var | absolute `https` URL of the Worker, origin only (no path), for OAuth redirects and as push's endpoint base (`<it>/gmail/push` is the token audience); default `https://<api-host>` when the Gmail group is set; set by `setup:remote` from `.env.<env>` |
| `CONNECT_RETURN_URL` | var | absolute `https` URL the connect flow returns to; optional; set by `setup:remote` from `.env.<env>` |
| `GMAIL_BACKFILL_DAYS` | var | positive integer, days of mail to backfill on connect; optional; set by `setup:remote` from `.env.<env>` |
| `ATTACHMENT_MAX_BYTES` | var | positive integer, the largest attachment kept; optional; set by `setup:remote` from `.env.<env>` |
| `VERSION` | var | the deployed git sha, set by `deploy:remote`; `/health` reports it (`dev` when absent) |
| `BODIES` | R2 binding | the object store (`ObjectStore`): message bodies and file bytes served by `messages.content` and `files.content`; without it those two routes answer `503 objects_unavailable` |

Locally, put the secrets in `.dev.vars` (copy `.dev.vars.example`; gitignored). `wrangler.jsonc` has a placeholder
`database_id` and no `account_id` on purpose. A bad auth or CORS configuration fails closed: every non-health request is
`500 internal`, with one log line that names the variable and never its value.

## Deploy

A deployed instance is a named `env` in `wrangler.jsonc`; the top level is local-only and a bare `wrangler deploy` has no
usable database. The worked example is `smoked1` (Worker `vault-smoked1`, D1 `vault-smoked1`, R2 `vault-smoked1-bodies`,
`https://api.smoked1.vibase.ai`, API keys only). **A self-hoster** copies the `env.smoked1` block under their own name and
replaces the env name, Worker `name`, D1 name and `database_id`, bucket name and hostname with their own.

**One command.** `setup:remote` takes an env from nothing to a migrated, bootstrapped, deployed, verified Worker, one idempotent
step at a time (`preflight`, `config:resources`, `clerk`, `config:write`, `migrate`, `bootstrap`, `deploy`, `secrets`, `verify`).
Read the plan first: `--dry-run` only reads and needs no `CONFIRM_REMOTE`; a real run needs it. The first real run creates the D1
database and the R2 bucket, configures Clerk, writes `env.<name>` into `wrangler.jsonc` (comments kept; a differing value you
already have is a `fail`, never overwritten) and **stops**: review and commit the file, then run the same command again to
migrate, bootstrap, deploy, put the secrets and verify. Re-running a finished setup changes nothing.

**`--auth clerk` (the default)** also configures a Clerk instance from its Backend API and checks what the API cannot do. The
instance's keys live in **one gitignored env file per instance**, `.env.<env>` at the repo root by default (`--clerk-env-file`
to name another), with `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (or `VITE_CLERK_PUBLISHABLE_KEY`). The file is read on its
own: never the root `.env` (the command refuses it), never the process environment, and no value is ever printed. A production
instance (`sk_live_`) needs `--clerk-production` on every run, dry runs included; a development instance is accepted with a
warning. `--owner-email` is required: the first owner is invited by Clerk, never created by bootstrap. The `clerk` step lists
rows C1-C10: sign-up mode, Organizations, session-token claim, allowed origins, the scope catalog, dynamic client
registration, the `Vibase CLI` OAuth application and the first owner. A row it cannot read is `manual` (the session-token
claim and the sign-in methods always are); a dashboard row it can check and finds wrong is a `fail` that prints the exact
dashboard path, and the run stops before `config:write`. After the invitation is accepted, `vibase login` and
`GET /meta/v1/me` must show `role: owner`. The `secrets` step puts `CLERK_SECRET_KEY` and the derived `CLERK_JWT_KEY` with
`wrangler secret bulk` (JSON on stdin) after the deploy and leaves present ones alone unless `--rotate-secrets`.

**`--auth none`** is API keys only (`smoked1`): no Clerk steps, and no secrets unless the Gmail group below is set.

**The Gmail group (optional, either auth mode).** If the same env file (`.env.<env>`, or `--clerk-env-file`) holds the four
core names `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET` and `CREDENTIALS_KEY`, `setup:remote` carries the
Gmail values to the Worker: the three secrets in the `secrets` step's one `wrangler secret bulk`, and the vars
(`GOOGLE_CLIENT_ID`, `GMAIL_TOPIC_NAME`, `GMAIL_PUSH_SUBSCRIPTION`, `GMAIL_PUSH_SERVICE_ACCOUNT`, `PUBLIC_BASE_URL`,
`CONNECT_RETURN_URL`, `CREDENTIALS_KEY_VERSION`, `GMAIL_BACKFILL_DAYS`, `ATTACHMENT_MAX_BYTES`) into `env.<name>.vars`, so
`deploy:remote` keeps them. None of the four core names: the group is skipped (the report says so; on `--auth none` a missing
file is a skip too). Some but not all: refused before any command, naming the missing ones. Values are checked first
(`CREDENTIALS_KEY` base64 of 32 bytes, integers, `https` URLs, topic and subscription paths), and a refusal names the variable,
never the value. Only these names are read; any other name in the file is ignored. Re-runs follow the usual rules: a present
secret or equal var is left alone, a var that differs in `wrangler.jsonc` is a `fail`, a var the file omits is never deleted,
and `CREDENTIALS_KEY` is never replaced (`--rotate-secrets` replaces the other two; rotating the key is a new
`CREDENTIALS_KEY_VERSION`, not setup's job). The Google Cloud side (project, OAuth client, topic, push) is the guide in [Google Cloud setup for Gmail](#google-cloud-setup-for-gmail-user-run).

```bash
pnpm -C packages/server-d1 setup:remote -- --env acme --api-host api.acme.example.com --owner-email you@example.com --dry-run
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env acme --api-host api.acme.example.com --owner-email you@example.com \
  [--clerk-env-file .env.acme] [--clerk-production] [--no-dcr] [--rotate-secrets] \
  [--web-origin https://app.example.com] [--extra-origin https://other.example.com] \
  [--operator-agent operator --key-env ACME_OPERATOR_KEY [--org <name>]] [--only clerk,secrets]
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env smoked1 --auth none --api-host api.smoked1.example.com \
  [--operator-agent operator --key-env SMOKED1_KEY --owner-email you@example.com]
```

`--api-host` is required (a custom domain on a zone in your account). With `--auth none` and no `--operator-agent` the bootstrap
writes only the deployment marker `none:<env>`; with `--auth clerk` it writes `clerk:<issuer>` and the organisation (`--org`, default the env name), and an operator agent and key only with `--operator-agent`. The commands below stay as the manual and repair path.

**The API token** (in the gitignored root `.env` as `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`; see `.env.example`).
Account level: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers Tail Read, Account Settings Read. On the
zone: Zone Read and Workers Routes Edit. No DNS or certificate permission: Cloudflare creates the Custom Domain's DNS
record and certificate itself. There is no `account_id` in the config on purpose.

**A manual `wrangler d1 execute ... --remote`** (a read-only pre-check, say) gets none of that: the guarded `db:*:remote` and `deploy:remote`
scripts load `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the root `.env`, but a bare `wrangler` call does not. Export both from the
root `.env` in your shell first (without printing them), or wrangler asks for an account it cannot choose ([[CHN155]], #157).

**Every remote command refuses to run without `CONFIRM_REMOTE=1`** and prints its target (database name and id) before it
does anything. They refuse the placeholder `database_id` and any env whose D1 binding is not `remote: true`.

```bash
# First provisioning (once per instance; the ids are not secrets, commit the database id into env.<name>)
pnpm -C packages/server-d1 exec wrangler d1 create vault-smoked1
pnpm -C packages/server-d1 exec wrangler r2 bucket create vault-smoked1-bodies

# Shipping order: migrate (only when packages/storage-d1/migrations changed), then deploy, then look
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env smoked1   # prints the applied-versus-expected diff before and after
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:status:remote -- --env smoked1    # read-only: the same diff, exit 0 only when current
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env smoked1   # clean tree; typecheck and tests first; --var VERSION:<sha>
curl https://api.smoked1.vibase.ai/health                                    # shows the deployed sha

# The first organisation, owner and agent. The key is written to the root .env as the variable named by --key-env
# and is never printed; a re-run is refused while that variable is set.
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env smoked1 --org smoked1 --email "$ADMIN_EMAIL" \
  --agent operator --auth-provider none --auth-org-id smoked1 --key-env VAULT_SMOKED1_OPERATOR_KEY

# Smoke
pnpm -C packages/server-d1 smoke:remote -- --base https://api.smoked1.vibase.ai --phase before --expect-version <sha>
pnpm -C packages/server-d1 smoke:remote -- --base https://api.smoked1.vibase.ai --phase after --expect-version <sha>
```

### Putting the connect page on `hq` (user-run: every step is a hard stop for agents)

`hq` (Worker `vault-hq`, `https://api.hq.vibase.ai`, Clerk production, keys in the gitignored `.env.hq`) gets `/connect` with the next deploy,
plus two vars: `CLERK_PUBLISHABLE_KEY` and `https://api.hq.vibase.ai` in `CLERK_AUTHORIZED_PARTIES`. Run, from the repository root:

```bash
# 1. Read-only plan. Expect config:write "update" naming env.hq.vars.CLERK_PUBLISHABLE_KEY and env.hq.vars.CLERK_AUTHORIZED_PARTIES, and nothing else.
pnpm -C packages/server-d1 setup:remote -- --env hq --api-host api.hq.vibase.ai --owner-email <owner email> --clerk-production --dry-run

# 2. The same without --dry-run: writes the two vars into wrangler.jsonc and stops.
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env hq --api-host api.hq.vibase.ai --owner-email <owner email> --clerk-production

# 3. Review and commit the wrangler.jsonc change (a clean tree is required to deploy).
git diff packages/server-d1/wrangler.jsonc
git add packages/server-d1/wrangler.jsonc && git commit -m "chore(hq): CLERK_PUBLISHABLE_KEY and the api origin as an authorized party (UI30)"

# 4. The same command again: migrate is a no-op, deploy is "update" (it builds the page first), secrets are left alone, verify is ok.
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env hq --api-host api.hq.vibase.ai --owner-email <owner email> --clerk-production

# 5. Smoke (<sha> is `git rev-parse HEAD`), then open the page in a browser and sign in.
pnpm -C packages/server-d1 smoke:remote -- --base https://api.hq.vibase.ai --phase after --expect-version <sha>
curl -s https://api.hq.vibase.ai/.well-known/vibase    # auth.publishable_key is the pk_live_ key
open https://api.hq.vibase.ai/connect
```

Optional, in the Clerk dashboard (Paths): set the Account Portal's after-sign-in URL to `https://api.hq.vibase.ai/connect`.

Before the first remote bootstrap writes anything, the CLI proves on the live database that a failed `batch()` leaves no
marker (`atomicity probe: atomic`); if it does not, it stops. Migrations are expand-only with respect to the running
Worker, because they run first. **Rollback** is `pnpm -C packages/server-d1 exec wrangler rollback --env <name>` of the
Worker only; the database is never rolled back (D1 Time Travel is a recovery action for a person).

**Backups and export.** `wrangler d1 export` refuses a database that holds FTS5 virtual tables (migration `0014`, the
`*_search` indexes, [[CORE194]] D14): `cannot export databases with Virtual Tables (fts5)`. D1 Time Travel is the backup;
a single plain table still exports with `--table <name>`. A full-export path that drops and recreates the index tables is a
follow-up.

### Recording Google's real responses on `hq` (user-run: every step is a hard stop for agents)

The Gmail code was written from Google's documented shapes. To check them against the real thing, the Worker can write a **redacted** copy of
each Google exchange to R2 ([[CHN5]] D78, D79). It is off unless `GOOGLE_RECORDING_UNTIL` holds an ISO-8601 UTC instant that is still ahead and
at most 7 days away; absent, past, malformed or too far ahead means off (the last two are logged by variable name, never by value). It is a plain
var read from the Worker's env (a secret works too). On `hq` it is already in `env.hq.vars` with a dated value (committed for the first run); remove it after the run. Only `env.hq` may carry it (a test checks).

What is written: at most 3 recordings per call kind per sync run, plus up to 3 per distinct non-2xx status, in the env's `BODIES` bucket under
`_recordings/<run start>-<instance or request id>/`, plus `_recordings/index.json` (the keys; `wrangler r2 object` cannot list). No D1 write, no event.
**Redaction is deny-by-default and happens in the Worker before any byte is stored**: request headers are never recorded; every JSON string is
masked (letters to `x`/`X`, digits to `0`, punctuation kept) unless it is on the allow-list in `packages/api/src/channels/gmail/recorder.ts`;
tokens and secrets are `"<redacted>"`; message ids are pseudonyms (consistent within a run); base64 members (`raw`, a part's `data`, an
attachment's `data`) become `{ length, padding, alphabet_ok, decoded_bytes }`. Numbers, booleans and which members are present are kept: those are
the shapes. Read every pulled file before it goes anywhere: your review is the second check.

```bash
# 0. Redeploy hq to a build that has the recorder (migrate first only if migrations changed), and do NOT reconnect the mailbox with the recorder off:
#    the connect callback requests the first backfill, and an unrecorded one spends it. A reconnect WITH the recorder on is the only way to record the
#    code exchange, ID token, profile and send-as list (they run at connect only); optional.
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env hq

# 1. Turn it on: the var is already in env.hq.vars in packages/server-d1/wrangler.jsonc. Check its instant is still ahead and at most 7 days away at deploy time
#    (else change it: UTC, ending in Z), commit, deploy.
#      "GOOGLE_RECORDING_UNTIL": "2026-11-09T00:00:00Z"   (as committed on main, 1493548)
# If it had to change: git add packages/server-d1/wrangler.jsonc && git commit -m "chore(hq): move the Google recorder switch (CHN153)"
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env hq

# 2. Run the supervised backfill: POST /meta/v1/connections/<id>/sync as the owner (connections.sync), then watch the run to the end
#    (the connection's last_synced_at moves; `wrangler tail --env hq` shows [recording] lines only on a problem).
curl -s -X POST -H "Authorization: Bearer <owner session token>" https://api.hq.vibase.ai/meta/v1/connections/<id>/sync

# 3. Pull (read-only: `wrangler r2 object get --remote` only) into the gitignored packages/server-d1/recordings-pull/hq/ and review every file.
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 recordings:pull -- --env hq

# 4. Turn it off: remove the var from wrangler.jsonc and deploy again (if you forget, the 7-day cap turns it off by itself).
git add packages/server-d1/wrangler.jsonc && git commit -m "chore(hq): turn the Google recorder off (CHN153)"
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env hq

# 5. Delete the recordings from R2 once you have what you need (one command per key; the keys are in recordings-pull/hq/index.json).
pnpm -C packages/server-d1 exec wrangler r2 object delete vault-hq-bodies/_recordings/index.json --remote --env hq
```

Concurrent runs can race on `index.json` (it is read, extended and written back); run one sync at a time. Then hand the reviewed files to the agent
for the second half of #153 (commit them under `packages/api/src/test/fixtures/google/` as `source: recorded`, with an `expect` each, and settle the
shape questions). `pnpm -C packages/api recordings:generate` rewrites only the synthetic ones.

## Google Cloud setup for Gmail (user-run)

Nothing here is done by `setup:remote`, and no agent runs `gcloud` ([[CHN5]] D39): Google Cloud is configured in Google's console or `gcloud`, once per
deployment. `<api-host>` is the Worker's host (for `hq`, `api.hq.vibase.ai`). The commands below follow Google's Pub/Sub and Gmail push documentation; compare
them with the ones you already use before running anything.

### 1. The project and the OAuth consent screen

1. Create (or pick) a Google Cloud project and enable the two APIs: `gcloud services enable gmail.googleapis.com pubsub.googleapis.com`.
2. **Internal or External.** *Internal* (a Google Workspace organisation) lets only your organisation's accounts connect and needs no Google verification:
   choose it when every mailbox is in your Workspace. *External* works for any Google account but a project in *Testing* is limited to listed test users and
   its refresh tokens expire after 7 days; for real use publish it, and because `gmail.readonly` and `gmail.send` are restricted scopes Google requires
   app verification (and, for restricted scopes, a security assessment) before more than 100 users. Internal avoids all of that.
3. **Scopes** (the consent screen's data access): `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.send`. Vibase requires `gmail.readonly` (a grant without it is refused as `scope_missing`); `gmail.send` is
   recorded when granted and used by nothing yet.
4. **OAuth client**: a *Web application*. Authorised redirect URI, exactly: `https://<api-host>/oauth/google/callback` (it is `PUBLIC_BASE_URL` plus
   `/oauth/google/callback`, so they must agree). The client id is `GOOGLE_CLIENT_ID` (a var); the client secret is `GOOGLE_CLIENT_SECRET` (a secret).

### 2. The topic Gmail publishes to

```bash
PROJECT_ID=<your-project-id>
gcloud config set project "$PROJECT_ID"
gcloud pubsub topics create gmail.watch
# Gmail publishes as this Google-owned account; it must be allowed to publish to the topic:
gcloud pubsub topics add-iam-policy-binding gmail.watch \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

`GMAIL_TOPIC_NAME` is `projects/<project id>/topics/gmail.watch`. A domain-restricted-sharing organisation policy can refuse the grant.

### 3. The push service account and the authenticated subscription

Pub/Sub calls Vibase with an OIDC token signed as a service account you create. Vibase checks the token's signature against Google's keys, its
issuer, its **audience (it must equal `<PUBLIC_BASE_URL>/gmail/push` exactly)**, its `email` (this service account) and `email_verified`, and that the body
names this subscription.

```bash
gcloud iam service-accounts create gmail-push --display-name="Vibase Gmail push"

# Optional: only if Pub/Sub cannot mint tokens as that account (a project from before 2021, or an organisation policy). The Pub/Sub service agent needs
# the token-creator role. Check the subscription's delivery before adding it: with the grant already in place this is a no-op.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

gcloud pubsub subscriptions create gmail.push \
  --topic=gmail.watch \
  --push-endpoint="https://<api-host>/gmail/push" \
  --push-auth-service-account="gmail-push@${PROJECT_ID}.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://<api-host>/gmail/push"
```

`GMAIL_PUSH_SUBSCRIPTION` is `projects/<project id>/subscriptions/gmail.push`; `GMAIL_PUSH_SERVICE_ACCOUNT` is `gmail-push@<project id>.iam.gserviceaccount.com`.
Pub/Sub's tokens may be up to an hour old; Vibase accepts them until their `exp` (with 30 seconds of clock tolerance).

### 4. Variables, secrets and the order

Put the values in the instance's own gitignored env file (`.env.<env>`) and let `setup:remote` carry them (see "The Gmail group" above), or set them by hand:
the vars `GOOGLE_CLIENT_ID`, `GMAIL_TOPIC_NAME`, `GMAIL_PUSH_SUBSCRIPTION`, `GMAIL_PUSH_SERVICE_ACCOUNT` and `PUBLIC_BASE_URL` go in `env.<name>.vars`; the secrets
`GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET` and `CREDENTIALS_KEY` (base64 of 32 random bytes) with `wrangler secret put` or the bulk. Then, in this order:

1. Create the Google resources above (the subscription can exist before the Worker answers: until deploy the route is `404` and Pub/Sub retries).
2. Set the vars and secrets, **migrate, then deploy** (`db:migrate:remote`, then `deploy:remote`). Push is on once all four push vars are set.
3. Connect the mailbox (`connections.authorize`). The callback registers the watch (INBOX and SENT) before it writes the connection; if that fails the connection
   still commits and the next cron tick registers it. Mailboxes connected before push was configured get their watch at the next tick (every 15 minutes).
4. The 15-minute cron renews every watch with less than 6 days left (Google drops a watch after 7 days) and stays the safety net: a push Vibase never got is
   served by the next tick. Deleting a connection calls Gmail's `users.stop` after the delete commits, best effort.

If you arm the Google recorder on a deployment whose cron is on (see the recorder section above), arm it for one tick at most: the cron's watch calls and a sync run
can overlap, and the recorder's index is one object read, extended and written back ([[CHN5]] D81).

### 5. When something is wrong (the Worker's log, `wrangler tail`; values are never logged)

| Log line | Meaning | Fix |
|---|---|---|
| `[gmail] push is off: set or fix <names>` at startup | a push variable is missing or malformed | set it; `PUBLIC_BASE_URL` must be an origin only |
| `[gmail] push is off: the MAIL_SYNC binding is missing` | no Workflow binding | add the `workflows` block to the env |
| `[watch] ... misconfigured connection=<id> status=403` | the topic's publisher grant is missing, or the topic is in another project | step 2's `add-iam-policy-binding`; check `GMAIL_TOPIC_NAME` |
| `[watch] ... misconfigured ... status=400` | a bad topic name, or Google refusing `labelFilterBehavior` (Vibase sends `include`; Google's reference lists lowercase, its push guide's example writes `INCLUDE`) | fix the topic; if the status stays 400 on a correct topic, the casing is the cause (one constant in `client.ts`) |
| `[watch] ... misconfigured ... status=404` | the topic does not exist | create it |
| `[watch] ... throttled` | `429`, or a rate-limit `403` | none: the next tick retries (each failing connection costs one call per tick) |
| `[watch] ... failed` | a network error or a `5xx` | none: the next tick retries |
| a connection `reauth_required` after a tick | Google answered `invalid_grant`: access was revoked | reconnect the mailbox |
| `[gmail-push] refused: bearer / alg / header` | no token, or not an RS256 JWT | only Pub/Sub's authenticated push may call the route |
| `[gmail-push] refused: token` | bad signature, issuer, **audience** or expiry | the subscription's `--push-auth-token-audience` must equal `<PUBLIC_BASE_URL>/gmail/push` |
| `[gmail-push] refused: email` / `email_verified` | the token is for another service account | the subscription's `--push-auth-service-account` must be `GMAIL_PUSH_SERVICE_ACCOUNT` |
| `[gmail-push] refused: subscription` | the body names another subscription | `GMAIL_PUSH_SUBSCRIPTION` must be this subscription's full name |
| `[gmail-push] the JWKS could not be fetched` (answers `503`) | Google's keys were unreachable; Pub/Sub retries | none |
| `[gmail-push] no live watched connection for this notification` (answers `204`) | the mailbox is not connected, was deleted, needs a reconnect, or has no watch yet | none: the cron registers a missing watch |

## The small-deployment profile

This engine is built and tested for a **small deployment**: up to about five users, a few agents, and mostly
sequential work. One organisation per database; a second organisation cannot be stored.

- **A cap of 100 per set.** Anything Vibase must touch as one bounded set is limited to 100 rows:
  - a resolve batch (`POST /identities/resolve`) is refused by the request schema: `400 validation_error`;
  - the live children of a delete cascade (`DELETE /companies/{id}` unlinks its contacts, `DELETE /contacts/{id}`
    tombstones its identities) and the members of a directory snapshot are refused by the runtime:
    `400 set_limit_exceeded`, and nothing is written.
- **Emails are lower-case ASCII.** The schema refuses anything else; D1 has no `citext`.
- **What a refusal looks like:**
  - `400 set_limit_exceeded`: a set was over the cap; nothing was written.
  - `403 organization_forbidden`: the token names an organisation other than this deployment's.
  - `409 conflict`: the record changed while the operation was running; **retry**.
  - `503 not_initialised`: the bootstrap CLI has not run yet (`/health` and the two OpenAPI documents, `/api/v1/openapi.json` and `/meta/v1/openapi.json`, still answer).
  - `503 migrations_pending`: the database lacks a migration this Worker build expects (deployed before migrating). Run
    `db:migrate:remote`; the Worker re-reads within 5 s. `/health` and the two OpenAPI documents still answer. It wins over `not_initialised`.

## Migration state

`/health.migrations` is `{ status, applied, expected, latest_applied, latest_expected }`, from comparing the names in wrangler's
`d1_migrations` table with the list compiled into the build (`packages/storage-d1/src/migrations-manifest.ts`):
`current` (same set), `behind` (something expected is missing: every other route answers `503 migrations_pending`),
`ahead` (extra migrations, e.g. after a Worker rollback: served), `unknown` (no readable tracker: served). A new migration file must
be added to the manifest with its sha256 in the same change; a test fails otherwise and fails if an existing file is edited.
  - a masked `500 internal` on a write may mean the write **committed**: D1 decodes its result after the batch commits, so
    an error after that point does not undo it. **Read before retrying.**

## Measured limits

One request is one Worker invocation. These numbers come from `src/measured-limits.test.ts`, which drives the real
composition against a **local Miniflare** D1 (not remote), counting what the invocation sends to D1. A `db.batch()` call
counts as one query, as Cloudflare documents. CPU time is not measured.

| Scenario (one request) | D1 queries | Statements | Outbound fetches | Rows read | Rows written | Longest statement (bytes) | Most bound parameters |
|---|---|---|---|---|---|---|---|
| first request of a fresh Worker | 4 | 4 | 0 | 3 | 1 | 499 | 3 |
| key request, `last_used_at` stamp due | 3 | 3 | 0 | 3 | 1 | 499 | 3 |
| key request within the minute | 2 | 2 | 0 | 2 | 0 | 499 | 2 |
| `PATCH /tasks/{id}` | 3 | 5 | 0 | 7 | 4 | 716 | 9 |
| resolve 100 new emails | 3 | 7 | 0 | 1,402 | 1,500 | 1,038 | 6 |
| resolve the same 100 again | 2 | 2 | 0 | 302 | 0 | 1,038 | 3 |
| delete a company with 100 contacts | 3 | 10 | 0 | 906 | 504 | 814 | 9 |
| delete a contact with 100 identities | 3 | 10 | 0 | 906 | 404 | 545 | 9 |
| directory snapshot, 5 members | 11 | 36 | 6 | 91 | 55 | 850 | 8 |
| directory snapshot, 100 members | **201** | 607 | **101** | 6,686 | 1,303 | 850 | 8 |

Against Cloudflare's documented limits (fetched 2026-10-28):

| Limit (Workers Free / Paid) | Value | Source |
|---|---|---|
| D1 queries per Worker invocation (a `batch()` is one) | 50 / 1,000 | developers.cloudflare.com/d1/platform/limits/ (updated 2026-10-24) |
| Bound parameters per query | 100 | same |
| Max SQL statement length | 100,000 bytes | same |
| Max string, BLOB or row size | 2,000,000 bytes | same |
| SQL query duration | 30 s | same |
| Max database size | 500 MB / 10 GB | same |
| Subrequests per invocation (D1 counts) | 50 / 10,000 | developers.cloudflare.com/workers/platform/limits/ (updated 2026-10-12) |
| CPU time per invocation | 10 ms / 30 s default (5 min max) | same (not measured locally) |
| Memory | 128 MB | same |

**The Workers Free limit that matters is 50 per invocation, twice over.** One request (or one webhook delivery) may make at
most 50 D1 queries, and at most 50 subrequests in total, where every D1 query *and* every outbound `fetch` counts as a
subrequest. Workers Paid raises these to 1,000 queries and 10,000 subrequests.

This deployment profile is a small organisation of about 5 to 10 members. Every scenario above is within the Workers Free
bounds at that size, **except the 100-member directory snapshot** (201 D1 queries and, with its 101 outbound Clerk
fetches, 302 subrequests). That one is held to the Paid bound in the test and is not a supported Free-plan size.

The cost of a directory delivery (a Clerk webhook, after which Vibase fetches the organisation's whole member list)
grows with the number of **first-seen members** k: 2k+3 D1 queries and 3k+5 subrequests (the members page, the
organisation fetch, one profile fetch per new member, plus the D1 queries). The subrequest total is the binding one:
3k+5 stays at or under 50 up to **k = 15 new members in one delivery**, so organisations of 5 to 10 members have room
(a 5-member snapshot is 11 queries, 17 with fetches; a 10-member one is about 35 subrequests). An organisation that
adds more than about 15 new members at once, for example on first connection of a larger directory, needs **Workers
Paid** for that delivery. Members already provisioned stay written, and later redeliveries of the webhook should finish
the job (this is not measured). The test pins each scenario's exact query count, so a new round trip is a visible,
reviewed change.

**Remote latency (one measurement).** The first deploy smoke of `smoked1` ([[OPS4]], 2026-10-28) sent 200 authenticated
`GET /api/v1/tasks` requests at concurrency 20 to `https://api.smoked1.vibase.ai` from a developer machine: **p50 158 ms, p95
326 ms**, zero non-2xx. That is end-to-end time seen by the client (network, TLS, the Worker and its two or three D1
queries per request), on an empty database; it is one sample, not a guarantee. `smoke:remote --phase after` prints the
same numbers for your instance.

## Golden regeneration

The golden transcripts (`packages/api/fixtures/golden/`) are generated on D1, the oracle, and replayed on D1 in the
test gate. After an intended behaviour change, run `pnpm -C packages/api golden:generate` (Miniflare, no database URL)
and review the fixture diff line by line before committing it: every changed line must be explained by the change.
`pnpm -C packages/api golden:check` exits non-zero when a fixture is stale. Never edit a fixture by hand to make a
replay pass.

## Open and enterprise packages

`@vibase/storage`, `@vibase/storage-d1`, `@vibase/api` and this package are the **open** tier. `@vibase/db`,
`@vibase/storage-postgres` and `@vibase/server-postgres` are the **enterprise** tier; open packages never import them.
The check below proves it by copying only the open packages into a temporary workspace and installing, typechecking
(production code), testing and smoke-running them there:

```bash
pnpm -C packages/server-d1 open:check
```

It prints `not covered: packages/api's test suites (the Postgres-backed oracle, spec D14)`: those suites run against Postgres.

## Not here yet

CI ([[OPS4]] D19) and remote measurements beyond the deploy smoke's. There is no SLA and no claim about a remote deployment.
