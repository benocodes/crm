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
large schema, crypto. **Rate limits**, not duration, are the real constraint on a slow provider (Gmail
throttling returns 429 with `Retry-After`; respect it with `step.sleep`).

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

These arrive with the CHN cycles that add Gmail sync; update this list when they do.

- `packages/api/src/sync/workflow-run.ts`: Node-safe orchestrator. `workflow.ts`: workerd entrypoint.
- `packages/api/src/test/workerd-boundary.ts`: the step shim. Use it in every workflow test.
- `packages/api/wrangler.toml`: `[[workflows]]` bindings and `[[queues.consumers]]`.
- `packages/db/src/pg-types.ts`: driver-level parsers that keep results serialisable.
