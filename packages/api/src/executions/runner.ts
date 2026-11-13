import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, codecs, defineOperation, execute, memberOf, readAll, step, unit, type Found, type PreparedOperation, type Row, type StorageBinding } from '@vibase/storage'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from '../directory/system-principal.js'
import { eventSetStatement } from '../outbox.js'
import type { Registry, RetryPolicy } from '../registry.js'
import { actionRequests } from '../action-requests/definition.js'
import { afterOf, selectRecord, toRecord } from '../storage/crud.js'
import { claimProgram, decodeRow, dueProgram, finishProgram, railEnv, retryProgram, stampProgram, type ExecutionRow, type Outcome } from './programs.js'
import type { DispatchOutcome, FailureCode, ReconcileOutcome, Transport, TransportCall, TransportRegistry } from './transport.js'

// [[AGT8]] D13, D14, D28, D50, D52-D55: the runner of the execution rail. Everything the Worker does for an enqueued operation after its authorisation is here: one
// attempt per run (`runExecution`), the due sweep and the expiry sweep of the per-minute tick (`railTick`). No transaction spans a transport call: the claim, the
// dispatch stamp, the finish or retry are separate guarded units, each under the lease token the claim minted. It takes storage, the transports, the registry and
// the clock as dependencies and runs in Node tests as it does in the Worker.

/** The per-minute cron expression ([[AGT8]] D54): the expiry sweep, then the runner sweep. */
export const RAIL_CRON = '* * * * *'
export const MAX_ATTEMPTS = 5
export const EXECUTION_LEASE_MS = 60_000
/** The finish write needs this much of the lease after the last transport call ([[AGT8]] D60). */
export const LEASE_MARGIN_MS = 10_000
export const EXPIRY_BATCH = 100
export const DUE_BATCH = 5
const BACKOFF_BASE_MS = 30_000
/** A throttle that names no wait is not retried sooner than this (Gmail's quota 403 carries no Retry-After, [[CHN5]] D83). */
const THROTTLE_FLOOR_MS = 60_000

export interface RailDeps {
  /** Composition cap when the real transport shares the invocation's external-call budget. Fake-only/default rail remains five. */
  dueLimit?: number
  binding: StorageBinding
  registry: Registry
  transports: TransportRegistry
  clock: () => Date
  newId: () => string
  /** Real milliseconds all transport calls of one attempt may take together ([[AGT8]] D60); default `EXECUTION_LEASE_MS - LEASE_MARGIN_MS`. Injected by tests. */
  attemptBudgetMs?: number
}
export type RunOutcome = { outcome: 'done' | 'failed' | 'retry' | 'skipped'; code?: string }
const SKIPPED: RunOutcome = { outcome: 'skipped' }

/** What the vault says about a failure: its own sentence per code, never a transport's text (which may hold a token or an address). */
const MESSAGES: Record<FailureCode, string> = {
  reauth_required: 'the connection must be authorised again',
  permission_missing: 'the connection lacks a permission this operation needs',
  anchor_missing: 'the message this replies to is no longer available',
  provider_rejected: 'the provider rejected the request',
  outcome_unknown: 'it could not be confirmed whether this was delivered; check before sending again',
  attempts_exhausted: 'it was attempted the maximum number of times without success',
  deadline_passed: 'it could not be attempted before its deadline',
}

const organizationOf = (d: RailDeps): string | null => (d.binding.kind === 'd1' ? d.binding.organizationId : null)
const iso = (ms: number): string => new Date(ms).toISOString()
/** `30 * 2^(n-1)` seconds ([[CHN5]] D84). */
const backoffMs = (attempt: number): number => BACKOFF_BASE_MS * 2 ** (attempt - 1)

/** One deadline and one signal for every call of an attempt; storage retains the last ten seconds of the lease. */
function transportBudget(d: RailDeps, leaseUntil: number) {
  const controller = new AbortController()
  const leaseDeadline = leaseUntil - LEASE_MARGIN_MS
  const remaining = Math.max(0, Math.min(d.attemptBudgetMs ?? Infinity, leaseDeadline - d.clock().getTime()))
  const wallDeadline = Date.now() + remaining
  const timer = setTimeout(() => controller.abort(), remaining)
  return {
    signal: controller.signal,
    async call<T>(invoke: () => Promise<T>, unknown: T): Promise<T> {
      if (controller.signal.aborted || Date.now() >= wallDeadline || d.clock().getTime() >= leaseDeadline) {
        controller.abort()
        return unknown
      }
      let onAbort!: () => void
      const expired = new Promise<T>((resolve) => {
        onAbort = () => resolve(unknown)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        // Racing also bounds a transport that observes abort but never settles its promise.
        return await Promise.race([invoke(), expired])
      } catch {
        return unknown
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => clearTimeout(timer),
  }
}
type TransportBudget = ReturnType<typeof transportBudget>

function callOf(row: ExecutionRow, signal: AbortSignal): TransportCall {
  return { executionId: row.id, operation: row.operation, arguments: row.arguments, resolution: row.resolution, clientRef: row.client_ref, attempt: row.attempts, signal }
}
/** A transport that throws has told us nothing: the call may have been made. */
async function dispatchSafe(transport: Transport, call: TransportCall, budget: TransportBudget): Promise<DispatchOutcome> {
  return budget.call<DispatchOutcome>(() => transport.dispatch(call), { kind: 'unknown' })
}
async function reconcileSafe(transport: Transport, call: TransportCall, budget: TransportBudget): Promise<ReconcileOutcome> {
  if (!transport.reconcile) return { kind: 'unknown' }
  return budget.call<ReconcileOutcome>(() => transport.reconcile!(call), { kind: 'unknown' })
}

/** One attempt at one execution. Claims it (skipped when it is not due or another runner holds it), then follows D53 and finishes or reschedules it. */
export async function runExecution(d: RailDeps, id: string): Promise<RunOutcome> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return SKIPPED
  const identity = { kind: 'internal', organizationId } as const
  const now = d.clock()
  const token = crypto.randomUUID()
  const claimed = (await execute(d.binding, identity, claimProgram({ organizationId, id, token, now: iso(now.getTime()), leaseUntil: iso(now.getTime() + EXECUTION_LEASE_MS) }))).value
  if (!claimed) return SKIPPED
  const budget = transportBudget(d, now.getTime() + EXECUTION_LEASE_MS)
  try {
    return await runClaimedExecution(d, claimed, token, now, budget)
  } finally {
    budget.dispose()
  }
}

async function runClaimedExecution(d: RailDeps, row: ExecutionRow, token: string, now: Date, budget: TransportBudget): Promise<RunOutcome> {
  const { id, organization_id: organizationId } = row
  const identity = { kind: 'internal', organizationId } as const
  const op = d.registry.get(row.operation)
  const decl = op?.kind === 'tenant' ? op.execution : undefined
  const transport = decl ? d.transports[decl.transport] : undefined
  const policy: RetryPolicy = decl?.retry ?? 'reconcile'

  const finish = async (outcome: Outcome): Promise<RunOutcome> => {
    const at = codecs.timestamp.write(d.clock())
    const program = finishProgram({
      env: railEnv({ organizationId, actorId: row.authorised_by, now: d.clock(), newId: d.newId }),
      row,
      token,
      at,
      outcome,
      ids: { execution: d.newId(), request: d.newId() },
    })
    const { applied } = (await execute(d.binding, identity, program)).value
    if (!applied) return SKIPPED // a stale lease owner: the current one finishes
    return outcome.ok ? { outcome: 'done' } : { outcome: 'failed', code: outcome.code }
  }
  const fail = (code: FailureCode) => finish({ ok: false, code, message: MESSAGES[code] })
  const schedule = async (delayMs: number, keepDispatched: boolean, code: string): Promise<RunOutcome> => {
    const nextAt = iso(d.clock().getTime() + delayMs)
    const ok = (await execute(d.binding, identity, retryProgram({ organizationId, id, token, nextAt, keepDispatched, code }))).value
    return ok ? { outcome: 'retry' } : SKIPPED
  }

  if (!decl || !transport) return fail(row.dispatched_at !== null ? 'outcome_unknown' : 'provider_rejected')
  const call = callOf(row, budget.signal)
  const maybeSent = row.dispatched_at !== null
  /** Whether the execution may have been delivered as things stand now: the stamp of an earlier attempt, or this attempt's call. */
  let sentNow = maybeSent
  const deadline = Date.parse(row.deadline_at)

  /** The last word on an execution that cannot be attempted again: one final reconcile when it may have been sent, else the code that stopped it. */
  const terminal = async (never: FailureCode): Promise<RunOutcome> => {
    if (!sentNow) return fail(never)
    if (policy !== 'never') {
      const r = await reconcileSafe(transport, call, budget)
      if (r.kind === 'found') return finish({ ok: true, result: r.result })
    }
    return fail('outcome_unknown')
  }

  if (now.getTime() >= deadline) return terminal('deadline_passed')
  if (row.attempts > MAX_ATTEMPTS) return terminal('attempts_exhausted')

  /** Schedules the next attempt, or ends the execution when there is none to make (attempts used up, or past the deadline). */
  const retryOr = async (delayMs: number, code: string): Promise<RunOutcome> => {
    // No attempt left is the answer before any deadline question: there is no next attempt to fall past it.
    if (row.attempts >= MAX_ATTEMPTS) return terminal('attempts_exhausted')
    if (d.clock().getTime() + delayMs > deadline) return terminal('deadline_passed')
    return schedule(delayMs, sentNow, code)
  }

  if (maybeSent) {
    if (policy === 'never') return fail('outcome_unknown')
    if (policy === 'reconcile') {
      const r = await reconcileSafe(transport, call, budget)
      if (r.kind === 'found') return finish({ ok: true, result: r.result })
      if (r.kind === 'unknown') {
        // Nothing to learn: wait, and ask again. Past the last attempt or the deadline this IS the final reconcile.
        const next = d.clock().getTime() + backoffMs(row.attempts)
        if (row.attempts >= MAX_ATTEMPTS || next > deadline) return fail('outcome_unknown')
        return schedule(backoffMs(row.attempts), true, 'unknown')
      }
      // not_found: it was not delivered; dispatch again below.
    }
  }

  // The stamp is its own unit, before the call: a crash after it is recovered by reconciling, a crash before it by dispatching.
  const stamped = (await execute(d.binding, identity, stampProgram({ organizationId, id, token, now: iso(d.clock().getTime()) }))).value
  if (!stamped) return SKIPPED
  sentNow = true
  const out = await dispatchSafe(transport, call, budget)
  switch (out.kind) {
    case 'sent':
      return finish({ ok: true, result: out.result })
    case 'not_sent':
      if (out.code !== 'retryable') return fail(out.code)
      sentNow = false
      return retryOr(out.retryAfterMs === undefined ? Math.max(backoffMs(row.attempts), THROTTLE_FLOOR_MS) : Math.max(backoffMs(row.attempts), out.retryAfterMs), 'retryable')
    case 'unknown':
      if (policy === 'never') return fail('outcome_unknown')
      return retryOr(backoffMs(row.attempts), 'unknown')
  }
}

/** The runner sweep of the tick: at most `DUE_BATCH` due or lease-expired executions, oldest first, one attempt each. One failing does not stop the others. */
export async function runDueExecutions(d: RailDeps): Promise<{ attempted: number }> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return { attempted: 0 }
  const ids = (await execute(d.binding, { kind: 'internal', organizationId }, dueProgram({ organizationId, now: iso(d.clock().getTime()), limit: Math.min(DUE_BATCH,d.dueLimit??DUE_BATCH) }))).value
  let attempted = 0
  for (const id of ids) {
    try {
      if ((await runExecution(d, id)).outcome !== 'skipped') attempted++
    } catch (err) {
      console.error(`[rail] execution ${id} failed to run: ${err instanceof Error ? err.name : 'error'}`)
    }
  }
  return { attempted }
}

type Plan = { id: string; before: Record<string, unknown> }

/**
 * The expiry sweep ([[AGT8]] D17, D55): one set unit for the `EXPIRY_BATCH` oldest pending requests past `expires_at`. Each is guarded on `status = 'pending'` (a
 * decision that landed between the plan and the commit wins), decided by the `system` principal, and gets one `action_request.expired` only if this unit changed it.
 */
export async function expireOverdueRequests(d: RailDeps): Promise<{ expired: number }> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return { expired: 0 }
  const now = d.clock()
  const at = codecs.timestamp.write(now)
  const env = railEnv({ organizationId, actorId: organizationId, now, newId: d.newId })
  const mintSystem = d.newId()
  const program: PreparedOperation<number> = defineOperation<number>({
    name: 'action_requests.expire',
    mutates: true,
    reads: (qc) => ({
      [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      due: readAll(
        selectRecord(actionRequests, qc, env, undefined, { derived: false })
          .where(sql<SqlBool>`${sql.ref('action_requests.status')} = 'pending'`)
          .where(sql<SqlBool>`${sql.ref('action_requests.expires_at')} <= ${at}`)
          .orderBy('action_requests.expires_at', 'asc')
          .orderBy('action_requests.id', 'asc')
          .limit(EXPIRY_BATCH),
      ),
    }),
    build: (found: Found, qc) => {
      const plans: Plan[] = found.all('due').map((r: Row) => ({ id: String(r.id), before: toRecord(actionRequests, r) }))
      if (plans.length === 0) return unit({ steps: [], events: [], decode: () => 0 })
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), mintSystem, at)
      const ids = plans.map((p) => p.id)
      const eventIds = plans.map(() => d.newId())
      const expired = sql<SqlBool>`${sql.ref('action_requests.status')} = 'expired' and ${sql.ref('action_requests.decided_by')} = ${sys.id} and ${sql.ref('action_requests.decided_at')} = ${at}`
      return unit({
        steps: [
          ...sys.steps,
          step(
            qc.db
              .updateTable('action_requests')
              .set({ status: 'expired', decided_by: sys.id, decided_at: at, updated_at: at } as never)
              .where(memberOf(qc, 'action_requests', 'id', ids))
              .where(sql<SqlBool>`${sql.ref('action_requests.organization_id')} = ${organizationId}`)
              .where(sql<SqlBool>`${sql.ref('action_requests.status')} = 'pending'`)
              .where(sql<SqlBool>`${sql.ref('action_requests.expires_at')} <= ${at}`),
            'first-mutation',
          ),
          step(
            eventSetStatement(qc, {
              at,
              organizationId,
              actorId: sys.id,
              type: 'action_request.expired',
              resourceType: 'action_request',
              after: afterOf(actionRequests),
              rows: plans.map((p, i) => ({ eventId: eventIds[i]!, resourceId: p.id, before: p.before })),
              where: expired,
            }),
            'first-event',
          ),
          step(qc.db.selectFrom('action_requests').select(sql<number>`1`.as('one')).where(memberOf(qc, 'action_requests', 'id', ids)).where(expired), 'result'),
        ],
        events: plans.map((p, i) => ({ id: eventIds[i]!, type: 'action_request.expired', resourceType: 'action_request', resourceId: p.id })),
        decode: (rows) => rows.length,
      })
    },
  })
  try {
    return { expired: (await execute(d.binding, { kind: 'internal', organizationId }, program)).value }
  } catch (err) {
    // A concurrent first use of the system principal (or any drift) is retried by the next tick; nothing was written.
    if (err instanceof UnitDriftError) return { expired: 0 }
    throw err
  }
}

/** The per-minute tick ([[AGT8]] D54): the expiry sweep, then the runner sweep. A failing sweep does not stop the other; the first failure is rethrown after both ran. */
export async function railTick(d: RailDeps): Promise<{ expired: number; attempted: number }> {
  let failure: unknown
  let expired = 0
  let attempted = 0
  try {
    expired = (await expireOverdueRequests(d)).expired
  } catch (err) {
    failure = err
    console.error(`[rail] expiry sweep failed: ${err instanceof Error ? err.name : 'error'}`)
  }
  try {
    attempted = (await runDueExecutions(d)).attempted
  } catch (err) {
    failure ??= err
    console.error(`[rail] runner sweep failed: ${err instanceof Error ? err.name : 'error'}`)
  }
  if (failure) throw failure
  return { expired, attempted }
}
