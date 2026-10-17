---
name: cloudflare-workflows
description: How to structure Cloudflare Workflows (`step.do`) so retries are cheap, checkpoints serialize cleanly, and the orchestrator stays Node-testable. Read whenever changing anything under `packages/api/src/agent-runs/workflow*.ts`, adding a new `step.do(...)` call, or seeing errors like `Value returned from step "<name>" is not serialisable`, `Step execution exceeded the maximum`, or workflows stuck without progressing past a step.
---

# Cloudflare Workflows: how to structure them

A durable orchestrator that checkpoints between `step.do(...)` calls and replays completed steps on retry. The model is simple but the constraints have sharp edges. This skill captures what we hit while building the agent-runs workflow (`packages/api/src/agent-runs/workflow-run.ts`).

## Mental model — three rules

1. **Each `step.do(name, fn)` is a checkpoint.** On retry, completed steps are *replayed from their stored return value* — `fn` is NOT re-invoked. So whatever a step returns is the source of truth for any later code that uses it.
2. **The runtime serialises every step's return value** to persist the checkpoint. That serialisation is structured-clone, not JSON: `Date`, `Map`, `Set`, plain objects work; closures, class instances with methods, AJV compiled validators, db clients, LLM SDK handles, `Promise`s, regexes-with-state do NOT.
3. **The orchestrator function itself is re-executed end-to-end on every replay.** Code OUTSIDE `step.do` runs again every retry. Code INSIDE `step.do` runs once and is replayed from cache.

If you internalise those three rules, the patterns below fall out automatically.

## A slow step is not a problem — a busy one is

Workflows meter **CPU time**, not wall-clock time. Per step (paid plan): CPU 30s by default,
configurable to 5 minutes; **wall-clock duration is unlimited** — a step may sit on network I/O or a
DB query indefinitely. `step.sleep()` goes up to 365 days.

So a slow LLM provider is a non-issue at the workflow layer. Our `llm-attempt-N` steps have been
observed taking **230s** against `z-ai/glm-5.2` (2026-07-20) and that is fine: an LLM call is
essentially all I/O and burns almost no CPU. Don't reach for a faster model, a step split, or a
timeout guard to "protect the step" — you'd be optimising against a limit that isn't binding.
What actually consumes the CPU budget is work in the step body: big JSON parses, AJV compilation
over a large schema, crypto. Reserve the worry for those.

Rate limits are the real constraint on a slow provider, not duration — see spec `AI-017`.

## Pattern: structure of a workflow

The Node-safe body lives in `workflow-run.ts` (or equivalent); the Cloudflare class entrypoint in `workflow.ts` just imports `cloudflare:workers` and delegates. This split keeps the orchestrator unit-testable in plain Node by passing a step shim.

```ts
// workflow-run.ts (Node-safe)
export interface WorkflowStepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
}
export interface WorkflowEventLike<P> { payload: P }

export async function runMyWorkflow(
  event: WorkflowEventLike<MyParams>,
  step: WorkflowStepLike,
): Promise<void> {
  // … orchestration body …
}

// workflow.ts (workerd-only)
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { runMyWorkflow } from './workflow-run.js'
export class MyWorkflow extends WorkflowEntrypoint<Env, MyParams> {
  async run(event, step) { await runMyWorkflow(event, step) }
}
```

Tests pass a `step` shim like `{ async do(_name, fn) { return fn() } }` and drive `runMyWorkflow` in-process.

## Pattern: what to return from a step

A step's return value MUST be structured-cloneable AND should be small.

**Do return:**
- IDs and primitives (`runId`, `threadId`, counts, strings, numbers, booleans).
- Plain DB row objects (Kysely returns `Date` for timestamps — that's fine).
- Arrays of primitives or plain objects.

**Don't return:**
- LLM SDK clients (closures over fetch + auth).
- Database clients (Kysely instances, `pg.Pool`).
- Compiled validators (AJV `validate` functions).
- Anything you constructed via `new Foo()` that has methods or private state.
- Cycles. The structured-clone algorithm handles them in principle but persisted checkpoints become bloated.
- **A `selectAll()` row from a table you don't control the future shape of.** See below — this is the one that actually bit us.

### workerd is stricter than V8's structured clone

Node's `structuredClone` accepts a class instance and silently downgrades it to a plain object.
**workerd refuses it and names the constructor:**

```
DataCloneError: Could not serialize object of type "PostgresInterval".
This type does not support serialization.
```

So there is no Node test — not even one that calls `structuredClone` — that reproduces this. It is a
production-only failure mode, and you have to design against it rather than test into it.

This cost us every extraction run for ~10 hours (2026-07-22). Migration 065 added
`entity_schemas.inquiry_ttl interval`; `loadContext` does `selectFrom('entity_schemas').selectAll()`
and returns that row from `load-context`; node-postgres decodes `interval` into a `PostgresInterval`
class instance. Nobody writing the migration knew they were touching the workflow.

Two rules fall out:

1. **`selectAll()` inside a step is an implicit promise that every current *and future* column of
   that table is workerd-serializable.** Prefer an explicit column list. `Date` is fine, which is why
   timestamps never raised the question.
2. **Neutralise the hazard at the driver.** `packages/db/src/pg-types.ts` registers a pg type parser
   for OID 1186 so `interval` decodes to text process-wide. Prefer this for any type pg decodes into
   a class — it fixes the class of bug rather than one call site.

### The failure is invisible from the DB side

A step that fails before `claim-run` errors the instance while leaving the row at `pending` — that's
by design (see the comment on `loadContext`), so a serialisation failure looks exactly like "the
queue never delivered". Diagnose it with
`wrangler workflows instances describe <workflow> <instance-id>`, which shows the per-step error.
`wrangler workflows instances list` is how you find the id; the version id also tells you which
deploy introduced it.

Worse, it's self-wedging: `agent_runs_extraction_hwm_unique` means re-capturing creates no new run,
and `recover` re-kicks a pending row on the same `attempt` → same `workflowInstanceId` → `createBatch`
idempotently no-ops against the dead instance. Recovery must bump `attempt` to get a fresh id
(fixed 2026-07-22). To force one by hand:
`wrangler workflows trigger <workflow> '{"runId":"…"}'` — it mints its own instance id, so it
sidesteps the collision entirely. Reset a zombie `running` row to `pending` first, or `claimRun`
returns null and the workflow bails.

## Thrown errors lose their identity at the step boundary

A step's return value crosses intact. **A thrown error does not** — it arrives as a bare `Error` with
the message preserved and the class, prototype and custom fields gone. So this is always false in
production:

```ts
// BROKEN — never matches once a real step boundary is involved.
try {
  await step.do('persist', () => persistResults(...))   // throws UnknownSourceMessageError
} catch (err) {
  if (err instanceof UnknownSourceMessageError) { /* dead code */ }
  throw err                                             // → workflow errors, run stuck at 'running'
}
```

**Carry business outcomes in the return value, not in an exception:**

```ts
const outcome = await step.do('persist', () => persistResults(...))  // → {ok:true} | {ok:false, reason, …}
if (!outcome.ok) await step.do('record-failure', () => recordFailure(db, runId, 'UNKNOWN_SOURCE_MESSAGE', …))
```

Keep throwing *inside* the step body where you need it (it's what rolls back the transaction) and
translate to a result at the function's own seam, where `instanceof` still works. Reserve real throws
for faults that genuinely should hit the workflow's retry machinery.

## Your test shim must emulate the boundary, not just the control flow

`{ async do(name, fn) { return fn() } }` models sequencing and nothing else: it passes objects by
reference and rethrows errors intact — precisely what workerd does *not* do. Both bugs above were
green under it and shipped.

Use `packages/api/src/test/workerd-boundary.ts` (`makeWorkerdStepShim`), which enforces both
semantics: return values are walked with workerd's accept-list and rejected by constructor name with
a property path (`step("load-context").ctx.schema.inquiry_ttl`), and thrown errors are reconstructed
as bare `Error`s. Any new workflow test should use it. Make sure the fixture actually populates the
risky columns — a nullable `interval` left NULL exercises nothing.

**Pattern when you need a non-serialisable thing later:** resolve it from a module-level factory at the call site, not from the step's return.

```ts
// BAD — llm is a closure; will throw "not serialisable" at the step boundary.
const ctx = await step.do('load', async () => ({
  rows: await db.selectFrom(...).execute(),
  llm: getLlm(),
}))

// GOOD — return only the data; re-resolve singletons outside the step.
const data = await step.do('load', async () => ({
  rows: await db.selectFrom(...).execute(),
}))
const llm = getLlm()
await step.do('llm-call', () => callLlm(data.rows, llm))
```

We hit exactly this with `ExtractionContext.llm` — the fix is in `run-extraction.ts` (no `llm` field) and `workflow-run.ts` (calls `getLlm()` at each step.do site).

## Pattern: idempotent step bodies

A step's fn may execute zero or one times per *successful* checkpoint, but at-least-once delivery (queue → workflow) means the workflow itself can be re-invoked for an already-running or already-finished job. So the *outermost* step should be defensive:

```ts
const load = await step.do('load-context', () => loadAndClaim(db, runId))
if (load.alreadyDone) return  // someone else finished us; bail cleanly.
```

`loadAndClaim` transitions `pending → running` inside one DB transaction and returns `{ alreadyDone: true }` if it saw `succeeded` / `failed`. Don't insert the "is this still my job" check into the orchestrator — push it into the load step where it's transactional.

## Pattern: looping with retries inside the orchestrator

If you have a bounded retry loop (e.g., LLM with up to N attempts), keep it in the orchestrator and give each attempt its own step name:

```ts
for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
  const turn = await step.do(`llm-attempt-${attempt}`, () => runLlmTurn(ctx, attempt, priorTurns, getLlm()))
  if (turn.valid) {
    await step.do('persist', () => persistResults(db, ctx, turn.envelope, ...))
    return
  }
  priorTurns.push({ role: 'user', content: turn.userContent }, { role: 'assistant', content: turn.rawText })
}
await step.do('record-exhausted', () => recordExhausted(db, runId))
```

Critical: `priorTurns` is rebuilt deterministically on replay from the previous steps' return values — you don't have to persist the loop variable. Code OUTSIDE `step.do` runs every replay, so `priorTurns.push(...)` re-runs, but `step.do('llm-attempt-N', ...)` returns its cached value. After all N iterations, the array contents are reconstructed identically.

This only works if the loop's progression is a pure function of step return values. If your loop depends on `Date.now()`, `Math.random()`, or any other non-deterministic input, capture it via `step.do('seed', () => ...)` and read from the captured value instead. Otherwise replays diverge from the original execution.

## Pattern: terminal failure

When a step throws, the workflow auto-retries that step (per the workflow's retry config), then the whole workflow fails. If you want to record a *business* failure (e.g., "LLM refused after 3 attempts") without auto-retry, classify the error inside the catch and write a `record-failure` step:

```ts
try {
  turn = await step.do(`llm-attempt-${attempt}`, () => runLlmTurn(...))
} catch (err) {
  const code = classifyError(err)
  await step.do('record-failure', () => recordFailure(db, runId, code, err.message))
  return  // returning ends the workflow successfully — the failure is in the DB.
}
```

The workflow itself returns successfully; the *business outcome* in the DB row is `failed`. This is the right shape because it stops infinite retries on a deterministic failure (a bad LLM prompt won't get better by retrying the workflow).

## Pattern: producer → queue → workflow

If a Worker fetch handler enqueues a workflow via a Queue, the producer's `queue.send(...)` MUST be awaited. Fire-and-forget kills the in-flight send when the fetch response resolves. See `agent-runs/kick.ts` — that file already does the right thing:

```ts
export async function kickRun(runId: string): Promise<void> {
  if (producer) {
    try { await producer.send({ runId }) } catch (err) { reportFatal(err) }
    return
  }
  // local fallback (no producer bound) for Node dev / tests
}
```

And the caller must `await Promise.all(ids.map(kickRun))` before returning the response.

## Anti-patterns we've already hit

- **Returning an LLM client / db handle from `step.do`** → `Value returned from step "<name>" is not serialisable`. Fix: re-resolve from a module-level factory at the call site.
- **Fire-and-forget `queue.send()` in the fetch handler** → message never reaches the queue; downstream rows stuck at `pending` forever. Fix: `await` or `ctx.waitUntil`.
- **Mutating a captured DB row across steps** → on replay, you see the original (cached) values, not your mutations. Always derive next-step input from the step's return, not from a closure variable mutated in place.
- **Putting `Date.now()` / random IDs outside a step** → replays generate different values, diverging from the original execution. Put non-determinism inside its own `step.do('seed', () => ...)`.
- **`selectAll()` on a table inside a step** → a column added by a later migration (`interval`, and any other type pg decodes into a class) silently makes the checkpoint unserialisable. Every extraction run dies at `load-context`, rows sit at `pending`, and no test goes red. Fix: explicit column lists, plus a driver-level type parser in `packages/db/src/pg-types.ts`.
- **`instanceof MyError` in the orchestrator** → the class doesn't survive the boundary, so the branch is dead and the run goes terminal mid-flight. Fix: return the outcome as data.
- **A pass-through step shim in tests** → models control flow only, so it validates neither of the two above. Fix: `makeWorkerdStepShim` from `src/test/workerd-boundary.ts`.

## Where this lives in donna

- `packages/api/src/agent-runs/workflow-run.ts` — Node-safe orchestrator.
- `packages/api/src/agent-runs/workflow.ts` — workerd `WorkflowEntrypoint` shim.
- `packages/api/src/agent-runs/kick.ts` — producer-side enqueue.
- `packages/api/src/agent-runs/run-extraction.ts` — `loadAndClaim`, `runLlmTurn`, `persistResults`, `recordFailure`, `recordExhausted`. These are the step bodies — keep them pure-ish (DB I/O OK, no module-level side effects) so they're easy to test.
- `packages/api/wrangler.toml` — the `[[workflows]]` binding (`AGENT_RUNS_WORKFLOW`, class `AgentRunWorkflow`) and the `[[queues.consumers]]` consumer that calls `createBatch`.
- `packages/api/src/test/workerd-boundary.ts` — the step shim that enforces the boundary's semantics in Node. Use it in every workflow test.
- `packages/db/src/pg-types.ts` — driver-level type parsers that keep query results serialisable.
- `packages/api/src/routes/agent-runs-recover.ts` — the re-drive path; bumps `attempt` so the new instance id doesn't collide with a dead one.
