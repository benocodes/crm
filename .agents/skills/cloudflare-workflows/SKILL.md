---
name: cloudflare-workflows
description: How to structure Cloudflare Workflows (`step.do`) so retries are cheap, checkpoints serialize cleanly, and the orchestrator stays Node-testable. Read whenever adding or changing a Workflow (Gmail history sync, watch renewal, webhook delivery), adding a `step.do(...)` call, or seeing errors like `Value returned from step "<name>" is not serialisable`, `DataCloneError`, `Step execution exceeded the maximum`, or workflows stuck without progressing past a step.
---

# Cloudflare Workflows: how to structure them

A durable orchestrator that checkpoints between `step.do(...)` calls and replays completed steps on retry.
The model is simple; the constraints have sharp edges. This skill is inherited from the predecessor product's agent-runs
workflow, where each rule below was paid for in production. The vault's uses are different (durable
per-mailbox history sync against Gmail, Gmail watch renewal, webhook delivery with retries),
but the runtime is the same, so the traps are too.

## Mental model: three rules

1. **Each `step.do(name, fn)` is a checkpoint.** On retry, completed steps are *replayed from their stored
   return value*; `fn` is NOT re-invoked. Whatever a step returns is the source of truth for later code.
2. **The runtime serialises every step's return value.** That is structured clone, not JSON: `Date`, `Map`,
   `Set` and plain objects work; closures, class instances with methods, compiled validators, DB clients,
   SDK handles, `Promise`s do NOT.
3. **The orchestrator function is re-executed end to end on every replay.** Code OUTSIDE `step.do` runs
   again every retry; code INSIDE `step.do` runs once and is replayed from cache.

## A slow step is not a problem; a busy one is

Workflows meter **CPU time**, not wall-clock time. Per step (paid plan) CPU is 30s by default, configurable
to 5 minutes; wall-clock duration is unlimited, so a step may wait on network I/O or a DB query
indefinitely, and `step.sleep()` goes up to 365 days. A slow external call (a Gmail history page fetch, an LLM) burns
almost no CPU and is fine. What consumes the budget is work in the step body: big JSON parses, compiling a
large schema, crypto. **Rate limits**, not duration, are the real constraint on a slow provider. Gmail's per-minute quota
arrives as a `403` with `errors[].reason: rateLimitExceeded` and **no `Retry-After`** (the `hq` backfill, [[CHN153b]]), on any
call kind, attachment gets included; a `429` may carry one. Honour `Retry-After` when sent, else grow the `step.sleep`
(30 s × 2^(n−1) per throttle of one page, [[CHN5]] D84): a flat sleep can land in the same quota window again. A throttle
is a fact about the page, never about the item: surface it as a distinct retryable error the content step rethrows, not as
a stored per-item failure (`ChannelThrottledError`, `packages/api/src/channels/port.ts`). Each throttle costs two steps (the
sleep and the repeated page).

**Steps per instance are capped: 1024 on the Free plan** (user-confirmed, 2026-11-06, [[CHN141]]; check Cloudflare's limits
page for what counts as a step, `step.sleep` included, before relying on headroom). A loop of one step per page
is bounded by the input's size, not by your code: budget the pages and continue in a new instance (`create` with a fresh
id, the cursor in the database) before the cap. The Gmail backfill's budget is #156.

## Structure

Put the Node-safe body in `workflow-run.ts`; the workerd class in `workflow.ts` only imports
`cloudflare:workers` and delegates. That keeps the orchestrator unit-testable in plain Node.

```ts
// workflow-run.ts (Node-safe)
export interface WorkflowStepLike { do<T>(name: string, fn: () => Promise<T>): Promise<T> }
export interface WorkflowEventLike<P> { payload: P }

export async function runMyWorkflow(event: WorkflowEventLike<MyParams>, step: WorkflowStepLike) { /* … */ }

// workflow.ts (workerd only)
import { WorkflowEntrypoint } from 'cloudflare:workers'
export class MyWorkflow extends WorkflowEntrypoint<Env, MyParams> {
  async run(event, step) { await runMyWorkflow(event, step) }
}
```

Step bodies (`loadAndClaim`, `fetchPage`, `persistBatch`, …) live in their own module, kept pure-ish: DB I/O
is fine, module-level side effects are not.

## What to return from a step

Must be structured-cloneable **and small**.

- **Do return:** ids and primitives, plain DB row objects (`Date` is fine), arrays of those.
- **Don't return:** SDK clients, DB clients or pools, compiled validators, anything built with `new Foo()`
  that has methods or private state, cycles, and **a `selectAll()` row from a table whose future shape you
  don't control**.

### workerd is stricter than V8's structured clone

Node's `structuredClone` accepts a class instance and silently downgrades it to a plain object. **workerd
refuses it and names the constructor:**

```
DataCloneError: Could not serialize object of type "PostgresInterval". This type does not support serialization.
```

No Node test reproduces this, including one that calls `structuredClone`. It is a production-only failure,
so design against it. The predecessor lost every extraction run for ~10 hours when a migration added an `interval`
column and a step `selectAll()`ed that table; node-postgres decodes `interval` into a class instance, and
the person writing the migration had no idea they were touching a workflow.

1. **`selectAll()` inside a step is an implicit promise that every current and future column is
   workerd-serializable.** Use an explicit column list.
2. **Neutralise the hazard at the driver:** `packages/db/src/pg-types.ts` registers type parsers so any type
   pg would decode into a class stays text (see `db-schema-and-migrations`).

### The failure is invisible from the DB side

A step that fails early errors the instance while leaving the row at its initial state, so a serialisation
failure looks like "the queue never delivered". Diagnose with `wrangler workflows instances describe
<workflow> <instance-id>`, which shows the per-step error (`instances list` finds the id; the version id
tells you which deploy introduced it). It can also be self-wedging: if recovery re-kicks a job with the same
`attempt` it derives the same instance id, and `createBatch` idempotently no-ops against the dead instance.
Recovery must **bump the attempt** to get a fresh id. To force one by hand: `wrangler workflows trigger
<workflow> '{"…":"…"}'` mints its own instance id. Reset a zombie `running` row to `pending` first, or the
claim step returns null and the workflow bails.

## Thrown errors lose their identity at the step boundary

A step's return value crosses intact. **A thrown error does not**: it arrives as a bare `Error` with the
message preserved and the class, prototype and custom fields gone. So this is always false in production:

```ts
// BROKEN: never matches once a real step boundary is involved.
try { await step.do('persist', () => persist(...)) }          // throws UnknownMailboxError
catch (err) { if (err instanceof UnknownMailboxError) { /* dead code */ } throw err }
```

**Carry business outcomes in the return value, not in an exception:**

```ts
const outcome = await step.do('persist', () => persist(...))   // {ok:true} | {ok:false, reason, …}
if (!outcome.ok) await step.do('record-failure', () => recordFailure(db, id, outcome.reason))
```

Keep throwing *inside* the step body where you need it (it rolls back the transaction) and translate to a
result at the function's own seam, where `instanceof` still works. Reserve real throws for faults that
should hit the retry machinery.

## Your test shim must emulate the boundary, not just the control flow

`{ async do(_n, fn) { return fn() } }` models sequencing and nothing else: it passes objects by reference
and rethrows errors intact, exactly what workerd does *not* do. Both bugs above were green under it and
shipped. Build a shim (`packages/api/src/test/workerd-boundary.ts`, `makeWorkerdStepShim`; port it from
the predecessor's) that enforces both semantics: return values are walked with workerd's accept-list and rejected by
constructor name with a property path (`step("load-context").row.ttl`), and thrown errors are reconstructed
as bare `Error`s. Every workflow test uses it, and its fixtures must populate the risky columns; a nullable
`interval` left NULL exercises nothing.

**When you need a non-serialisable thing later, resolve it from a module-level factory at the call site, not
from a step's return:**

```ts
// BAD: client is a closure; throws "not serialisable" at the step boundary.
const ctx = await step.do('load', async () => ({ rows: await loadRows(), client: getClient() }))
// GOOD: return only data; re-resolve singletons outside the step.
const data = await step.do('load', async () => ({ rows: await loadRows() }))
const client = getClient()
await step.do('call', () => callProvider(data.rows, client))
```

## Idempotent step bodies

A step's fn runs zero or one times per successful checkpoint, but at-least-once delivery (queue → workflow)
means the workflow itself can be invoked again for a job already running or finished. Make the outermost
step defensive, and push the "is this still my job" check into the load step where it is transactional:

```ts
const load = await step.do('load-and-claim', () => loadAndClaim(db, jobId))
if (load.alreadyDone) return
```

**Instance id as the dedupe key ([[API221]]).** `create({ id })` with an existing id throws on the deployed
platform, with wording Cloudflare does not document; **Miniflare does not throw at all** (two creates with the
same id both return). So: (1) treat "already exists" as success by a loose message match *and* a `get(id)`
fallback for any other error (an instance that exists means the work is started; `get` throwing means it is
not, so answer `5xx`); (2) never rely on the instance id alone for idempotency: the step that writes (here,
proposing an action request) must look up its own prior effect first, because locally a duplicate create runs
the workflow twice. Unit-test the "already exists" branch with a fake binding; a local E2E cannot reach it.
See `packages/webhook-receiver-example/src/receiver.ts`.

## Loops with retries inside the orchestrator

Keep a bounded retry loop in the orchestrator and give each attempt its own step name
(`fetch-page-${n}`). Loop state is rebuilt deterministically on replay from the earlier steps' return
values, so you don't persist the loop variable. This only holds if progression is a pure function of step
return values: capture `Date.now()`, random ids or any other non-determinism with `step.do('seed', …)` and
read the captured value, or replays diverge from the original execution.

## Terminal failure

When a step throws, the runtime retries it per the retry config, then fails the workflow. To record a
*business* failure without auto-retry (a revoked Google grant, a deterministic 4xx), classify inside a catch
and write a `record-failure` step, then `return`. The workflow ends successfully and the failure lives in the
DB row. That stops infinite retries on a deterministic failure.

## Producer → queue → workflow

If a Worker's `fetch` handler enqueues work via a Queue, the producer's `queue.send(...)` MUST be awaited
(or wrapped in `ctx.waitUntil`). Fire-and-forget kills the in-flight send when the response resolves, and
downstream rows sit at `pending` forever. `await Promise.all(ids.map(kick))` before returning the response.
Webhook delivery is the same shape with a dead-letter queue behind it.

## Anti-patterns

- Returning an SDK client or DB handle from `step.do` → "not serialisable". Re-resolve from a factory.
- Fire-and-forget `queue.send()` in the fetch handler → message never reaches the queue.
- Mutating a captured DB row across steps → on replay you see the original cached values. Derive next-step
  input from the step's return, never from a mutated closure variable.
- `Date.now()` or random ids outside a step → replays diverge. Put them in a `seed` step.
- `selectAll()` on a table inside a step → a later migration silently makes the checkpoint unserialisable
  and no test goes red. Explicit column lists plus the driver-level type parser.
- `instanceof MyError` in the orchestrator → dead branch; the run goes terminal mid-flight. Return the
  outcome as data.
- A pass-through step shim in tests → validates neither of the two above.

## Where this lives in the vault

Gmail sync ([[CHN141]], CHN5 cycle 4) is the first Workflow. Paths are real:

- `packages/api/src/sync/workflow-run.ts`: Node-safe orchestrator `runMailSync(event, step, resolve)`. Step names are unique per instance
  (`seed`, `claim`, `p<pass>-history-<n>`, `p<pass>-finish`, `record-failure`, `chain`); every step re-resolves the runtime from `resolve()` and
  returns only ids, counts, page tokens, history ids, bounds and outcomes. `lease.ts` (lease on `mail_sync_state`: one conditional write plus a
  `result` select in the same D1 batch, so "did I get it" needs no drift handling), `request.ts` (`requestSync`, `dueConnections`), `cron.ts`.
- `packages/server-d1/src/mail-sync-workflow.ts`: the workerd class (`MailSyncWorkflow`, imports `cloudflare:workers`, typed by
  `src/cloudflare-workers.d.ts`); `src/instance.ts` is the one per-isolate composition that `fetch`, `scheduled` and the Workflow share;
  `compose.ts` returns `{ fetch, scheduled, runMailSync }`. `src/worker.ts` must **export the class by name**: the binding names it.
- `packages/server-d1/wrangler.jsonc`: `workflows` and `triggers.crons` are **not inherited by an env**; each env states its own (`vb-mail-sync`,
  `vault-smoked1-mail-sync`, `vault-hq-mail-sync`; `hq` has `"triggers": { "crons": [] }` on purpose). Config test: `src/wrangler-config.test.ts`.
- `packages/api/src/test/workerd-boundary.ts` (`makeWorkerdStepShim`): the step shim. It walks returns with workerd's accept-list (constructor name and
  path), clones them, turns thrown errors into bare `Error`s, records `sleep`s and `returns`, and has `retries`, `beforeStep` (kill the instance at a
  step) and `afterCommit` (fail after the step's unit committed) hooks. Use it in every workflow test.
- `packages/server-d1/scripts/smoke-worker.ts` (`smoke:worker`, checks W1-W5) runs the real `MailSyncWorkflow` from the real bundle in Miniflare's
  Workflows engine (`workflows: { MAIL_SYNC: { name, className } }`; esbuild needs `external: ['cloudflare:workers']`), Google faked by the
  outbound service (`FakeGmail.handle` serves Gmail over HTTP). `scheduled` is driven with `(await mf.getWorker()).scheduled({ cron })`.
- `packages/db/src/pg-types.ts`: driver-level parsers that keep results serialisable (the Postgres engine).

Traps found building it: a **claim step must take back its own lease** (`run_id = :run` in the guard), because a retried step re-runs after its unit
committed; the **cron expression** the handler dispatches on is `controller.cron`; a **kill is modelled before a step**, and a second run needs the
lease to expire (advance the injected clock past `LEASE_MS`).

Found in review ([[CHN141]] round 1):

- **Every step that writes passes the migration gate, the terminal ones too.** `record-failure` and `chain` were first written without
  `rt.gate()`, so a database behind its migrations could still release a lease or start an instance. Put the gate first in each step body
  and give at least one terminal step its own gate test (shim `beforeStep` flips `behind`, the row must be unchanged).
- **A "kept, the cron will serve it" promise needs the cron's predicate to include it.** `503 sync_unavailable` keeps `sync_requested_at`;
  the cron selected only stale or lease-expired connections, so a fresh connection's request waited 15 minutes. `dueConnections` also selects
  `sync_requested_at > last_success_at`. When an error path defers work to a scheduler, test the scheduler picks that exact state.
