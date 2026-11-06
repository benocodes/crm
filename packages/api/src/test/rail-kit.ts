// Test-only: never import from non-test code, and never reachable from the Worker bundle ([[AGT8]] D52). A scriptable fake transport, three enqueued
// test operations (one per retry policy) and a kit that opens the action-request kit with them registered and the execution rail wired.
import { z } from 'zod'
import { sql } from 'kysely'
import { uuidv7 } from '@vault/storage'
import { ApiError } from '../errors.js'
import { enqueuedOperation } from '../executions/enqueue.js'
import { runDueExecutions, railTick, runExecution, expireOverdueRequests, type RailDeps, type RunOutcome } from '../executions/runner.js'
import type { DispatchOutcome, PermanentCode, ReconcileOutcome, Transport, TransportCall } from '../executions/transport.js'
import { createVaultRegistry } from '../operations.js'
import type { Registry } from '../registry.js'
import type { RawRow } from './engines.js'
import { openActionKit, type ActionKit, type Actor, type Res } from './action-kit.js'

export type Answer =
  | { kind: 'sent'; result?: Record<string, unknown> }
  | { kind: 'not_sent'; code: 'retryable'; retryAfterMs?: number; message?: string }
  | { kind: 'not_sent'; code: PermanentCode; message?: string }
  | { kind: 'unknown'; message?: string }
  | { kind: 'throw' }
  /** Never answers until the call's signal aborts (a slow provider); then it throws, as a fetch does. */
  | { kind: 'hang'; ignoreAbort?: boolean }
export type ReconcileAnswer = ReconcileOutcome | { kind: 'throw' } | { kind: 'hang' }

/** A held call: `reached` settles when the transport has been called, `release` answers it. */
export interface Hold<A> {
  reached: Promise<void>
  release(answer: A): void
}

/** Answers each dispatch and reconcile from a script (default: `sent` / `unknown`), records every call, and can hold a call open. */
export class FakeTransport implements Transport {
  readonly dispatches: TransportCall[] = []
  readonly reconciles: TransportCall[] = []
  /** Calls that saw their signal abort. */
  aborted = 0
  private answers: Answer[] = []
  private reconcileAnswers: ReconcileAnswer[] = []
  private holds: { kind: 'dispatch' | 'reconcile'; reached: () => void; answer: Promise<Answer | ReconcileAnswer> }[] = []
  /** False: the transport has no `reconcile` (a transport that cannot ask). */
  canReconcile = true

  willDispatch(...answers: Answer[]): this {
    this.answers.push(...answers)
    return this
  }
  willReconcile(...answers: ReconcileAnswer[]): this {
    this.reconcileAnswers.push(...answers)
    return this
  }
  hold(kind: 'dispatch'): Hold<Answer>
  hold(kind: 'reconcile'): Hold<ReconcileAnswer>
  hold(kind: 'dispatch' | 'reconcile'): Hold<any> {
    let reached!: () => void
    const reachedP = new Promise<void>((r) => (reached = r))
    let release!: (a: Answer | ReconcileAnswer) => void
    const answer = new Promise<Answer | ReconcileAnswer>((r) => (release = r))
    this.holds.push({ kind, reached, answer })
    return { reached: reachedP, release }
  }
  reset(): void {
    this.dispatches.length = 0
    this.reconciles.length = 0
    this.aborted = 0
    this.answers = []
    this.reconcileAnswers = []
    this.holds = []
    this.canReconcile = true
  }

  async dispatch(call: TransportCall): Promise<DispatchOutcome> {
    this.dispatches.push(call)
    const held = this.takeHold('dispatch')
    let a: Answer
    if (held) {
      held.reached()
      a = (await held.answer) as Answer
    } else a = this.answers.shift() ?? { kind: 'sent' }
    if (a.kind === 'hang') return this.untilAborted(call, a.ignoreAbort)
    if (a.kind === 'throw') throw new Error('the fake transport threw')
    if (a.kind === 'sent') return { kind: 'sent', result: a.result ?? { message_id: `fake-${call.executionId}` } }
    return a as DispatchOutcome
  }

  get reconcile(): Transport['reconcile'] {
    if (!this.canReconcile) return undefined
    return async (call) => {
      this.reconciles.push(call)
      const held = this.takeHold('reconcile')
      let a: ReconcileAnswer
      if (held) {
        held.reached()
        a = (await held.answer) as ReconcileAnswer
      } else a = this.reconcileAnswers.shift() ?? { kind: 'unknown' }
      if (a.kind === 'hang') return this.untilAborted(call)
      if (a.kind === 'throw') throw new Error('the fake transport threw')
      return a
    }
  }
  private async untilAborted(call: TransportCall, ignoreAbort = false): Promise<never> {
    await new Promise<void>((resolve) => (call.signal.aborted ? resolve() : call.signal.addEventListener('abort', () => resolve(), { once: true })))
    this.aborted++
    if (ignoreAbort) await new Promise<never>(() => undefined)
    throw new Error('aborted')
  }
  private takeHold(kind: 'dispatch' | 'reconcile') {
    const at = this.holds.findIndex((h) => h.kind === kind)
    return at < 0 ? undefined : this.holds.splice(at, 1)[0]
  }
}

export const TEST_TRANSPORT = 'test'
export const TEST_OPS = { reconcile: 'test.enqueue', idempotent: 'test.enqueue_idempotent', never: 'test.enqueue_never' } as const
const input = z.strictObject({
  text: z.string().min(1).max(200),
  /** Refused at final validation (authorise): `409 test_refused`. */
  refuse: z.boolean().optional(),
  anchor: z.string().max(50).optional(),
  /** A task the resolution rests on: a guard at commit says it still exists. */
  guard_task: z.uuid().optional(),
  /** A token whose authorise refuses from its second use on (a retracted anchor after the send). */
  once: z.string().max(50).optional(),
})

/** The three enqueued test operations, registered before the queue's so `action_requests.create` lists them. */
export function registerTestOperations(registry: Registry): void {
  const seenOnce = new Set<string>()
  const common = {
    summary: 'Test-only enqueued operation',
    scope: { resource: 'tasks', action: 'write' } as const,
    transport: TEST_TRANSPORT,
    input,
    authorise: async (_env: unknown, args: Record<string, unknown>) => {
      if (typeof args.once === 'string') {
        if (seenOnce.has(args.once)) throw new ApiError(409, 'anchor_retracted', 'the anchor is gone')
        seenOnce.add(args.once)
      }
      if (args.refuse === true) throw new ApiError(409, 'test_refused', 'refused at final validation')
      const guardTask = args.guard_task as string | undefined
      return {
        resolution: { anchor: (args.anchor as string | undefined) ?? 'anchor-1' },
        clientRefDomain: 'test.invalid',
        ...(guardTask ? { guards: () => [sql<boolean>`exists (select 1 from "tasks" where "tasks"."id" = ${guardTask} and "tasks"."deleted_at" is null)` as never] } : {}),
      }
    },
  }
  registry.register(enqueuedOperation({ ...common, name: TEST_OPS.reconcile, path: '/test-enqueue', readScope: { resource: 'tasks', action: 'read' } }))
  registry.register(enqueuedOperation({ ...common, name: TEST_OPS.idempotent, path: '/test-enqueue-idempotent', retry: 'idempotent', readScope: { resource: 'tasks', action: 'read' } }))
  registry.register(enqueuedOperation({ ...common, name: TEST_OPS.never, path: '/test-enqueue-never', retry: 'never', readScope: { resource: 'notes', action: 'read' } }))
}

export interface RailKit extends ActionKit {
  transport: FakeTransport
  /** The runner's dependencies: this kit's binding, registry, transport, clock and ids. */
  deps: RailDeps
  /** How many times the app asked to start the runner after a commit. */
  starts: number
  /** True: a start is counted and dropped (a kick lost to the cron). */
  suppressStart: boolean
  /** Waits for every runner the app started. */
  settle(): Promise<void>
  /** A direct enqueue of `body` (with its `idempotency_key`). */
  enqueue(actor: Actor, body: Record<string, unknown>, op?: keyof typeof TEST_OPS): Promise<Res>
  run(id: string): Promise<RunOutcome>
  runDue: () => Promise<{ attempted: number }>
  expire: () => Promise<{ expired: number }>
  tick: () => Promise<{ expired: number; attempted: number }>
  /** The stored execution row, every column. */
  exec(id: string): Promise<RawRow>
  execs(): Promise<RawRow[]>
}

export async function openRailKit(opts: { now?: Date } = {}): Promise<RailKit> {
  const transport = new FakeTransport()
  const pending: Promise<unknown>[] = []
  const state = { starts: 0, suppress: true }
  const registry = createVaultRegistry({ operations: registerTestOperations })
  const base = await openActionKit({
    ...(opts.now ? { now: opts.now } : {}),
    registry,
    executions: {
      transports: { [TEST_TRANSPORT]: transport },
      start: (run) => {
        state.starts++
        if (!state.suppress) pending.push(run().catch(() => undefined))
      },
    },
  })
  const deps: RailDeps = {
    get binding() {
      return base.binding
    },
    registry,
    transports: { [TEST_TRANSPORT]: transport },
    clock: () => base.now(),
    newId: () => uuidv7(base.now()),
  }
  const kit: RailKit = Object.create(base, {
    transport: { value: transport },
    deps: { value: deps },
    starts: { get: () => state.starts },
    suppressStart: { get: () => state.suppress, set: (v: boolean) => void (state.suppress = v) },
    settle: { value: async () => void (await Promise.all(pending.splice(0))) },
    enqueue: {
      value: (actor: Actor, body: Record<string, unknown>, op: keyof typeof TEST_OPS = 'reconcile') => base.call(actor, 'POST', `/api/v1/${TEST_OPS[op].replace('test.', 'test-').replaceAll('_', '-')}`, body),
    },
    run: { value: (id: string) => runExecution(deps, id) },
    runDue: { value: () => runDueExecutions(deps) },
    expire: { value: () => expireOverdueRequests(deps) },
    tick: { value: () => railTick(deps) },
    exec: { value: async (id: string) => (await base.rows('action_executions', 'id = ?', id))[0]! },
    execs: { value: () => base.rows('action_executions') },
    reset: {
      value: async () => {
        await base.reset()
        transport.reset()
        pending.length = 0
        state.starts = 0
        state.suppress = true
      },
    },
  })
  return kit
}
