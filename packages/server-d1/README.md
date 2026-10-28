# @vault/server-d1

The vault as a Cloudflare module Worker on **one D1 database**: one organisation per deployment, the open tier
(licence: Apache-2.0, as declared in `package.json` today; nothing more is claimed here). It is the self-hosted
shape of the vault. Agents you bring read and propose over REST; the vault executes.

This package holds the Worker entry (`src/worker.ts`), its composition (`src/compose.ts`), the local bootstrap CLI and
`wrangler.jsonc`. The storage engine is `@vault/storage-d1`; the API is `@vault/api`.

## Requirements

- Node >= 22 and pnpm (see the repo root `package.json`).
- Everything below runs **locally**: `wrangler dev --local` and a local D1 in `.wrangler/state`. It needs no
  Cloudflare account, no login and no network.

## Local quickstart

From the repository root, after `pnpm install`:

```bash
export WRANGLER_SEND_METRICS=false CI=1

# 1. Apply the migrations to the local D1 (0001 to 0003).
pnpm -C packages/server-d1 exec wrangler d1 migrations apply DB --local

# 2. Create the deployment marker, the first organisation, its owner and an agent. The key is printed once.
pnpm -C packages/server-d1 bootstrap -- --org "Acme" --email owner@example.com --agent my-agent --auth-org-id org_local

# 3. Start the Worker locally (leave it running; stop it with Ctrl-C).
pnpm -C packages/server-d1 exec wrangler dev --local --port 8787
```

In another terminal, with `KEY` set to the `vk_...` key step 2 printed:

```bash
curl http://localhost:8787/health
# {"status":"ok","initialised":true}

curl -H "authorization: Bearer $KEY" http://localhost:8787/tasks
# {"data":[], ...}

# A resolve batch is capped at 100 identities: 101 are refused (400 validation_error), nothing is written.
node -e 'console.log(JSON.stringify({identities:Array.from({length:101},(_, i)=>({kind:"email",value:`p${i}@example.com`}))}))' \
  | curl -s -X POST -H "authorization: Bearer $KEY" -H "content-type: application/json" --data-binary @- http://localhost:8787/identities/resolve
```

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | the database; `migrations_dir` points at `packages/storage-d1/migrations` |
| `AUTH_PROVIDER` | var | empty: agent-only (API keys). `clerk`: also accept Clerk session tokens and webhooks |
| `CORS_ALLOWED_ORIGINS` | var | comma-separated origins for the email-client pane; empty allows none |
| `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`, `CLERK_JWT_KEY` | secrets | required with `AUTH_PROVIDER=clerk` |
| `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | secrets | required with `AUTH_PROVIDER=clerk` |
| `CLERK_API_URL` | var | optional |

Locally, put the secrets in `.dev.vars` (copy `.dev.vars.example`; gitignored). `wrangler.jsonc` has a placeholder
`database_id` and no `account_id` on purpose. A bad auth or CORS configuration fails closed: every non-health request is
`500 internal`, with one log line that names the variable and never its value.

## The small-deployment profile

This engine is built and tested for a **small deployment**: up to about five users, a few agents, and mostly
sequential work. One organisation per database; a second organisation cannot be stored.

- **A cap of 100 per set.** Anything the vault must touch as one bounded set is limited to 100 rows:
  - a resolve batch (`POST /identities/resolve`) is refused by the request schema: `400 validation_error`;
  - the live children of a delete cascade (`DELETE /companies/{id}` unlinks its contacts, `DELETE /contacts/{id}`
    tombstones its identities) and the members of a directory snapshot are refused by the runtime:
    `400 set_limit_exceeded`, and nothing is written.
- **Emails are lower-case ASCII.** The schema refuses anything else; D1 has no `citext`.
- **What a refusal looks like:**
  - `400 set_limit_exceeded`: a set was over the cap; nothing was written.
  - `403 organization_forbidden`: the token names an organisation other than this deployment's.
  - `409 conflict`: the record changed while the operation was running; **retry**.
  - `503 not_initialised`: the bootstrap CLI has not run yet (`/health` and `/openapi.json` still answer).
  - a masked `500 internal` on a write may mean the write **committed**: D1 decodes its result after the batch commits, so
    an error after that point does not undo it. **Read before retrying.**

## Measured limits

One request is one Worker invocation. These numbers come from `src/measured-limits.test.ts`, which drives the real
composition against a **local Miniflare** D1 (not remote), counting what the invocation sends to D1. A `db.batch()` call
counts as one query, as Cloudflare documents. CPU time is not measured. Remote numbers belong to the deploy cycle
(OPS4).

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

Every scenario is within the Workers Free bounds **except the 100-member directory snapshot** (201 D1 queries and,
with its 101 outbound Clerk fetches, 302 subrequests). The cost of a directory delivery grows with the number of
**first-seen members** k: 2k+3 D1 queries and 3k+5 subrequests (the members page, the organisation fetch, one profile
fetch per new member, plus the D1 queries). On Workers Free (50) **one delivery with more than about 15 new members
exceeds the limit**; a directory that large needs **Workers Paid**. Members already provisioned stay written, and later
redeliveries of the webhook should finish the job (this is not measured). A snapshot of 5 members (11 queries, 17 with
fetches) is well inside Free. The test pins each scenario's exact query count, so a new round trip is a visible,
reviewed change.

## Golden regeneration

The golden transcripts are generated on the Postgres side and replayed on D1. A failing D1 replay is never fixed by
editing the fixture on the D1 side: **fixtures are regenerated only on the enterprise side: ask a maintainer to run
`pnpm -C packages/server-postgres golden:generate`.**

## Open and enterprise packages

`@vault/storage`, `@vault/storage-d1`, `@vault/api` and this package are the **open** tier. `@vault/db`,
`@vault/storage-postgres` and `@vault/server-postgres` are the **enterprise** tier; open packages never import them.
The check below proves it by copying only the open packages into a temporary workspace and installing, typechecking
(production code), testing and smoke-running them there:

```bash
pnpm -C packages/server-d1 open:check
```

It prints `not covered: packages/api's test suites (the Postgres-backed oracle, spec D14)`: those suites run against Postgres.

## Not here yet

Remote D1, deploy, and CI are the deploy cycle's (OPS4). There is no SLA and no claim about a remote deployment.
