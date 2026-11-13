import { sql, type SqlBool } from 'kysely'
import { appliedPrev, defineOperation, readAll, step, unit, type EventReceipt, type PreparedOperation, type Row, type Step } from '@vibase/storage'
import { eventStatement } from '../outbox.js'
import type { PreparedEnv } from '../storage/definition.js'
import { afterOf, beforeRead, receipt, toRecord } from '../storage/crud.js'
import { ScopeSet } from '../scopes.js'
import { actionRequests, type ActionRequestRecord } from '../action-requests/definition.js'
import { actionExecutions } from './definition.js'

// [[AGT8]] D13, D28, D50, D53, D56: the units of the runner. Claim, dispatch stamp and retry scheduling are machinery (no event, `updated_at` untouched, only the
// lease columns); the finish is the one unit that is a resource transition: the execution's outcome, the linked request's outcome and their events, committed
// together under the lease token that claimed it. Every unit is one conditional write plus a `result` select, so "did I get it" is a database fact.

/** The stored row of an execution as the runner reads it (JSON columns parsed, timestamps ISO text). */
export interface ExecutionRow {
  id: string
  organization_id: string
  created_by: string
  authorised_by: string
  action_request_id: string | null
  operation: string
  arguments: Record<string, unknown>
  resolution: Record<string, unknown>
  status: 'queued' | 'claimed' | 'done' | 'failed'
  client_ref: string
  deadline_at: string
  dispatched_at: string | null
  attempts: number
}

const AE = (column: string) => sql.ref(`action_executions.${column}`)
const parseJson = (v: unknown): Record<string, unknown> => (typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>))
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function decodeRow(row: Row): ExecutionRow {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    created_by: String(row.created_by),
    authorised_by: String(row.authorised_by),
    action_request_id: text(row.action_request_id),
    operation: String(row.operation),
    arguments: parseJson(row.arguments),
    resolution: parseJson(row.resolution),
    status: row.status as ExecutionRow['status'],
    client_ref: String(row.client_ref),
    deadline_at: String(row.deadline_at),
    dispatched_at: text(row.dispatched_at),
    attempts: Number(row.attempts),
  }
}

type Internal = { organizationId: string }
/** The row is still claimed under THIS runner's token: the guard of every write after the claim. */
const mine = (organizationId: string, id: string, token: string) =>
  sql<SqlBool>`${AE('id')} = ${id} and ${AE('organization_id')} = ${organizationId} and ${AE('status')} = 'claimed' and ${AE('lease_token')} = ${token}`

/**
 * Takes the lease on an execution that is due (queued, its time reached) or whose lease lapsed (claimed, `lease_until` passed): counts the attempt, sets
 * a lease of `leaseMs` and a fresh token. The `result` select asks for the row under THIS token, so a claim that lost the race to another runner gets nothing.
 */
export function claimProgram(d: Internal & { id: string; token: string; now: string; leaseUntil: string }): PreparedOperation<ExecutionRow | null> {
  return defineOperation<ExecutionRow | null>({
    name: 'action_executions.claim',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(
            qc.db
              .updateTable('action_executions')
              .set({ status: 'claimed', attempts: sql<number>`attempts + 1` as never, lease_until: d.leaseUntil, lease_token: d.token })
              .where(sql<SqlBool>`${AE('id')} = ${d.id}`)
              .where(sql<SqlBool>`${AE('organization_id')} = ${d.organizationId}`)
              .where(sql<SqlBool>`((${AE('status')} = 'queued' and ${AE('next_attempt_at')} <= ${d.now}) or (${AE('status')} = 'claimed' and ${AE('lease_until')} <= ${d.now}))`),
          ),
          step(qc.db.selectFrom('action_executions').selectAll().where(sql<SqlBool>`${AE('id')} = ${d.id}`).where(sql<SqlBool>`${AE('lease_token')} = ${d.token}`), 'result'),
        ],
        events: [],
        decode: (rows) => (rows[0] ? decodeRow(rows[0]) : null),
      }),
  })
}

/** The dispatch stamp, in its own unit before the transport call: true when the lease is still this runner's, so the call may be made. */
export function stampProgram(d: Internal & { id: string; token: string; now: string }): PreparedOperation<boolean> {
  return defineOperation<boolean>({
    name: 'action_executions.stamp',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(qc.db.updateTable('action_executions').set({ dispatched_at: d.now }).where(mine(d.organizationId, d.id, d.token))),
          step(qc.db.selectFrom('action_executions').select(sql<number>`1`.as('one')).where(sql<SqlBool>`${AE('id')} = ${d.id}`).where(sql<SqlBool>`${AE('lease_token')} = ${d.token}`).where(sql<SqlBool>`${AE('dispatched_at')} = ${d.now}`), 'result'),
        ],
        events: [],
        decode: (rows) => rows.length === 1,
      }),
  })
}

/** Gives the lease back and schedules the next attempt; `keepDispatched` false clears the stamp (a definite not_sent, D53). True when the lease was still this runner's. */
export function retryProgram(d: Internal & { id: string; token: string; nextAt: string; keepDispatched: boolean; code: string }): PreparedOperation<boolean> {
  return defineOperation<boolean>({
    name: 'action_executions.retry',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(
            qc.db
              .updateTable('action_executions')
              .set({ status: 'queued', next_attempt_at: d.nextAt, lease_until: null, lease_token: null, last_error_code: d.code, ...(d.keepDispatched ? {} : { dispatched_at: null }) })
              .where(mine(d.organizationId, d.id, d.token)),
          ),
          step(qc.db.selectFrom('action_executions').select(sql<number>`1`.as('one')).where(sql<SqlBool>`${AE('id')} = ${d.id}`).where(sql<SqlBool>`${AE('status')} = 'queued'`).where(sql<SqlBool>`${AE('next_attempt_at')} = ${d.nextAt}`).where(sql<SqlBool>`${AE('lease_token')} is null`), 'result'),
        ],
        events: [],
        decode: (rows) => rows.length === 1,
      }),
  })
}

export type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string }

/** An env for the helpers that render records; the runner has no caller, so no scope and the authoriser as the actor. */
export function railEnv(d: { organizationId: string; actorId: string; now: Date; newId: () => string }): PreparedEnv {
  return { actor: { id: d.actorId, kind: 'user' }, organizationId: d.organizationId, scopes: ScopeSet.parse([]), now: d.now, newId: d.newId, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }
}

/**
 * The finish ([[AGT8]] D28, D50, D56): ONE unit guarded on the lease token. The execution's outcome, `action_execution.completed|failed`, the linked request's
 * `executed|failed` and `action_request.executed|failed`, all attributed to the authoriser. A stale lease owner changes nothing: the guarded update affects no
 * row, every later statement is gated on the one before, and the result is empty (`applied: false`).
 */
export function finishProgram(d: { env: PreparedEnv; row: ExecutionRow; token: string; at: string; outcome: Outcome; ids: { execution: string; request: string } }): PreparedOperation<{ applied: boolean }> {
  const { env, row, outcome, at } = d
  const done = outcome.ok
  return defineOperation<{ applied: boolean }>({
    name: 'action_executions.finish',
    mutates: true,
    reads: (qc) => ({ execution: beforeRead(actionExecutions, qc, env, row.id), ...(row.action_request_id ? { request: beforeRead(actionRequests, qc, env, row.action_request_id) } : {}) }),
    build: (found, qc) => {
      const beforeRow = found.maybe('execution')
      const before = beforeRow ? toRecord(actionExecutions, (({ __stamp, ...rest }) => rest)(beforeRow as Record<string, unknown>) as Row) : null
      const steps: Step[] = [
        step(
          qc.db
            .updateTable('action_executions')
            .set({
              status: done ? 'done' : 'failed',
              updated_at: at,
              done_at: at,
              lease_until: null,
              lease_token: null,
              ...(outcome.ok ? { result: JSON.stringify(outcome.result) } : { error_code: outcome.code, error_message: outcome.message }),
            } as never)
            .where(mine(row.organization_id, row.id, d.token)),
          'first-mutation',
          { expect: 'affected' },
        ),
        step(
          eventStatement(qc, { id: d.ids.execution, at, organizationId: row.organization_id, actorId: row.authorised_by, type: `action_execution.${done ? 'completed' : 'failed'}`, resourceType: 'action_execution', resourceId: row.id, before, after: afterOf(actionExecutions) }),
          'first-event',
        ),
      ]
      const events: EventReceipt[] = [receipt(actionExecutions, d.ids.execution, done ? 'completed' : 'failed', row.id)]
      const requestRow = found.maybe('request')
      if (row.action_request_id && requestRow) {
        const { __stamp, ...rest } = requestRow as Record<string, unknown>
        const request = toRecord(actionRequests, rest as Row) as ActionRequestRecord
        steps.push(
          step(
            qc.db
              .updateTable('action_requests')
              .set({
                status: done ? 'executed' : 'failed',
                updated_at: at,
                ...(outcome.ok ? { executed_at: at, result: JSON.stringify(outcome.result) } : { error_code: outcome.code, error_message: outcome.message }),
              } as never)
              .where(sql<SqlBool>`${sql.ref('action_requests.id')} = ${row.action_request_id}`)
              .where(sql<SqlBool>`${sql.ref('action_requests.organization_id')} = ${row.organization_id}`)
              .where(sql<SqlBool>`${sql.ref('action_requests.status')} = 'approved'`)
              .where(appliedPrev(qc)),
          ),
          step(eventStatement(qc, { id: d.ids.request, at, organizationId: row.organization_id, actorId: row.authorised_by, type: `action_request.${done ? 'executed' : 'failed'}`, resourceType: 'action_request', resourceId: row.action_request_id, before: request, after: afterOf(actionRequests) })),
        )
        events.push(receipt(actionRequests, d.ids.request, done ? 'executed' : 'failed', row.action_request_id))
      }
      steps.push(
        step(
          qc.db
            .selectFrom('action_executions')
            .select(sql<number>`1`.as('one'))
            .where(sql<SqlBool>`${AE('id')} = ${row.id}`)
            .where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${d.ids.execution})`),
          'result',
        ),
      )
      return unit({ steps, events, decode: (rows) => ({ applied: rows.length === 1 }) })
    },
  })
}

/** The ids of the executions due now: queued and at their time, or claimed with a lapsed lease, oldest first. Read-only. */
export function dueProgram(d: Internal & { now: string; limit: number }): PreparedOperation<string[]> {
  return defineOperation<string[]>({
    name: 'action_executions.due',
    mutates: false,
    reads: (qc) => ({
      due: readAll(
        qc.db
          .selectFrom('action_executions')
          .select(AE('id').as('id') as never)
          .where(sql<SqlBool>`${AE('organization_id')} = ${d.organizationId}`)
          .where(sql<SqlBool>`((${AE('status')} = 'queued' and ${AE('next_attempt_at')} <= ${d.now}) or (${AE('status')} = 'claimed' and ${AE('lease_until')} <= ${d.now}))`)
          .orderBy(sql`case when ${AE('status')} = 'queued' then ${AE('next_attempt_at')} else ${AE('lease_until')} end`)
          .orderBy(AE('id'))
          .limit(d.limit),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('due').map((r) => String(r.id)) }),
  })
}

