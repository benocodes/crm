import { sql, type Expression, type SqlBool } from 'kysely'
import { z } from 'zod'
import {
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  readMaybe,
  step,
  ts,
  unit,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Row,
  type Step,
} from '@vault/storage'
import { systemPrincipalRead, systemPrincipalSteps, SYSTEM_PRINCIPAL_READ } from '../directory/system-principal.js'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { noReads, proposableOperations, proposerScopes, proposalScopeOf } from '../proposal.js'
import { validateOperationInput, type ExecutionDecl, type PrepareContext, type Registry, type TenantOperation } from '../registry.js'
import { actionExecutions } from '../executions/definition.js'
import { inputHash } from '../executions/canonical.js'
import { ownArguments } from '../executions/enqueue.js'
import { DEADLINE_MS, clientRefOf, insertExecution } from '../executions/rows.js'
import { parseInput } from '../resources/define.js'
import { formatScope, type Scope } from '../scopes.js'
import { afterOf, beforeRead, receipt, resultStep, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'
import { splitArguments } from '../mcp/tools.js'
import { actionRequests, evidenceItem, type ActionRequestRecord } from './definition.js'
import { readSendBody, requireSendStore, storeSendBody } from '../messaging/send-body.js'
import { requireReplyRead } from '../messaging/send.js'

// [[AGT8]] cycle 1: the four commands of the queue. Every decision is "plan, then one unit": a plan read of the request (and, for an approval,
// the target's own plan), a commit-time assertion that the request is still the pending one that was read, and guarded statements, so a
// concurrent decision turns this unit into a no-op that aborts as drift (replanned once, D28). Nothing here writes outside the unit.

const DAY_MS = 86_400_000
export const DEFAULT_EXPIRY_DAYS = 7
export const MAX_EXPIRY_DAYS = 30

const AR = (column: string) => sql.ref(`action_requests.${column}`)
const notFound = () => new ApiError(404, 'not_found', 'action request not found')
const lower = (s: string) => s.toLowerCase()
const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

const idParams = z.object({ id: z.uuid() })
const decisionBody = z.strictObject({ decision_reason: z.string().trim().min(1).max(2000).optional() })
const approveBody = z.strictObject({
  edited_arguments: z.record(z.string(), z.unknown()).optional().describe('Complete replacement arguments, validated and authorised as if proposed now. The original arguments stay on the request.'),
  decision_reason: z.string().trim().min(1).max(2000).optional(),
})
const looseCreate = z.strictObject({
  operation: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(2000),
  evidence: z.array(evidenceItem).max(20).optional(),
  contact_id: z.uuid().optional(),
  thread_id: z.uuid().optional(),
  interaction_id: z.uuid().optional(),
  dedup_key: z.string().min(1).max(200).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
})
type CreateBody = z.infer<typeof looseCreate>

type Plan = { record: ActionRequestRecord; stamp: string }

/** The one plan read of a decision command: the request as stored, and its exact `updated_at` for the commit guard. Null when there is none. */
function readRequest(env: PreparedEnv, id: string): PreparedOperation<Plan | null> {
  return defineOperation<Plan | null>({
    name: 'action_requests.plan',
    mutates: false,
    reads: (qc) => ({ row: beforeRead(actionRequests, qc, env, id) }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) return null
          const { __stamp, ...rest } = row as Record<string, unknown>
          return { record: toRecord(actionRequests, rest as Row), stamp: String(__stamp) }
        },
      }),
  })
}

const notPending = (status: string) => new ApiError(409, 'action_request_not_pending', `the action request is ${status}, not pending`)
const expiredNow = (r: ActionRequestRecord, now: Date) => Date.parse(r.expires_at) <= now.getTime()
const expired = () => new ApiError(409, 'action_request_expired', 'the action request has expired; it can no longer be decided')
const insufficient = (scope: Scope) => new ApiError(403, 'insufficient_scope', `requires ${formatScope(scope)}`)

const queueRead: Scope = { resource: 'action_requests', action: 'read' }
/**
 * [[AGT8]] D58 (#168): whether a decision command may tell this caller that the request exists. A caller who can read the queue, or holds the target's authority
 * at the command's level, is told the truth in D46's order; any other caller gets the 404 a missing id gets, whatever the request's status or expiry.
 */
function mayKnow(env: PreparedEnv, registry: Registry, record: ActionRequestRecord, level: 'write' | 'request_approval'): boolean {
  if (env.scopes.has(queueRead)) return true
  const target = registry.get(record.operation)
  if (target?.kind !== 'tenant' || target.scope === null) return false
  return env.scopes.has(level === 'write' ? target.scope : proposalScopeOf(target.scope))
}

/** The stored row is still the pending one the plan read (and, when `live`, not yet expired): else the whole unit aborts as drift. */
const stillPending = (qc: QueryContext, id: string, stamp: string, at: string | null) =>
  assertStep(
    qc,
    sql<SqlBool>`exists (select 1 from "action_requests" where ${AR('id')} = ${id} and ${AR('status')} = 'pending' and ${ts.exact(qc, 'action_requests.updated_at')} = ${stamp}${at !== null ? sql` and ${AR('expires_at')} > ${at}` : sql``})`,
  )

type Transition = {
  env: PreparedEnv
  qc: QueryContext
  plan: Plan
  to: 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'superseded' | 'executed'
  by: string
  at: string
  eventId: string
  eventType: string
  set?: Record<string, unknown>
  /** An extra predicate on the update (the approval's "the target's events exist"). */
  gate?: Expression<SqlBool>
  label?: boolean
}

/** The guarded pending -> `to` update and its event, which exists only when the update applied. The update is stamp-guarded on the row the plan read. */
function transition(t: Transition): Step[] {
  const { qc, plan, env } = t
  let update = qc.db
    .updateTable('action_requests')
    .set({ status: t.to, decided_by: t.by, decided_at: t.at, updated_at: t.at, ...(t.set ?? {}) } as never)
    .where(sql<SqlBool>`${AR('id')} = ${plan.record.id}`)
    .where(sql<SqlBool>`${AR('organization_id')} = ${env.organizationId}`)
    .where(sql<SqlBool>`${AR('status')} = 'pending'`)
    .where(sql<SqlBool>`${ts.exact(qc, 'action_requests.updated_at')} = ${plan.stamp}`)
  if (t.gate) update = update.where(t.gate)
  return [
    step(update, t.label ? 'first-mutation' : undefined, { expect: 'affected' }),
    step(
      eventStatement(qc, {
        id: t.eventId,
        at: t.at,
        organizationId: env.organizationId,
        actorId: t.eventType === 'action_request.expired' ? t.by : env.actor.id,
        type: t.eventType,
        resourceType: 'action_request',
        resourceId: plan.record.id,
        before: plan.record,
        after: afterOf(actionRequests),
      }),
      t.label ? 'first-event' : undefined,
    ),
  ]
}

const eventsPresent = (receipts: readonly EventReceipt[]): Expression<SqlBool> =>
  receipts.length === 0 ? sql<SqlBool>`1 = 1` : sql<SqlBool>`(select count(*) from "events" where "events"."id" in (${sql.join(receipts.map((r) => r.id))})) = ${receipts.length}`

/** The target operation of a stored request, or `400 operation_not_proposable` when the registry no longer offers it. */
function targetOf(registry: Registry, name: string): TenantOperation {
  const op = registry.get(name)
  if (!op || op.kind !== 'tenant') throw new ApiError(400, 'operation_not_proposable', `unknown operation "${name}"`)
  if (op.proposal?.eligible !== true) throw new ApiError(400, 'operation_not_proposable', `${name} cannot be proposed: ${op.proposal && !op.proposal.eligible ? op.proposal.reason : 'read-only operation'}`)
  return op
}

const referencedScopes = { contact_id: { resource: 'contacts', action: 'read' }, thread_id: { resource: 'messages', action: 'read' }, interaction_id: { resource: 'interactions', action: 'read' } } as const
const evidenceScope = { message: { resource: 'messages', action: 'read' }, interaction: { resource: 'interactions', action: 'read' } } as const

function requireInteractionThread(row: Row, threadId: string | null): void {
  if (threadId && row.thread_id !== threadId) throw new ApiError(400, 'validation_error', 'interaction_id does not belong to thread_id')
}

async function createRequest(registry: Registry, env: PreparedEnv, input: unknown): Promise<PreparedOperation<ActionRequestRecord>> {
  const body = parseInput(looseCreate, input) as CreateBody
  const target = targetOf(registry, body.operation)
  // D7, D34: proposing needs the target's request_approval (write contains it); the target then validates the call as it would a direct one.
  if (!env.scopes.has(proposalScopeOf(target.scope!))) throw insufficient(proposalScopeOf(target.scope!))
  if (target.execution) {
    // [[AGT8]] D49, D51: an enqueued operation is validated against its own arguments (an idempotency_key in a proposal is ignored); the rest is the approver's
    // `authorise` at approval (D9). It has no stored record to name, so there is no target to look up.
    const args = ownArguments(target.execution, body.arguments)
    if (target.name === 'messages.send') {
      requireReplyRead(env,args)
      if (body.thread_id && args.thread_id && body.thread_id.toLowerCase() !== args.thread_id) throw new ApiError(400,'validation_error','send thread must agree with request context')
      body.arguments = {...args,body:await storeSendBody(requireSendStore(env.objects),env.organizationId,args.body as string)}
    }
    return buildCreate(env, target, body, { params: {} })
  }
  const targetInput = validateOperationInput(target, splitArguments(target, body.arguments, { keepNull: true }))
  // A target's own refusal is the proposer's refusal (D34). `prepare` may be async.
  await target.prepare({ ...env, scopes: proposerScopes(env.scopes, target) }, targetInput, noReads)
  return buildCreate(env, target, body, targetInput)
}

function buildCreate(env: PreparedEnv, target: TenantOperation, body: CreateBody, targetInput: { params: Record<string, unknown> }): PreparedOperation<ActionRequestRecord> {
  // D8: a context link or an evidence reference needs the referenced resource's own read scope.
  for (const [field, scope] of Object.entries(referencedScopes)) {
    if (body[field as keyof typeof referencedScopes] !== undefined && !env.scopes.has(scope)) throw insufficient(scope)
  }
  for (const item of body.evidence ?? []) if (!env.scopes.has(evidenceScope[item.type])) throw insufficient(evidenceScope[item.type])
  const now = env.now
  const at = codecs.timestamp.write(now)
  const expiresMs = body.expires_at !== undefined ? Date.parse(body.expires_at) : now.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS
  if (expiresMs <= now.getTime()) throw new ApiError(400, 'validation_error', 'expires_at must be in the future')
  if (expiresMs > now.getTime() + MAX_EXPIRY_DAYS * DAY_MS) throw new ApiError(400, 'validation_error', `expires_at is at most ${MAX_EXPIRY_DAYS} days ahead`)
  const expiresAt = codecs.timestamp.write(new Date(expiresMs))
  const id = env.newId()
  const createdEventId = env.newId()
  const takeoverEventId = env.newId()
  const systemId = env.newId()
  const contactId = body.contact_id?.toLowerCase() ?? null
  const threadId = body.thread_id?.toLowerCase() ?? null
  // D20/D65: send arguments are authoritative, even when the optional review thread is omitted.
  const interactionThreadId = target.name === 'messages.send' && body.arguments.mode === 'reply' ? body.arguments.thread_id as string : threadId
  const interactionId = body.interaction_id?.toLowerCase() ?? null
  const evidence = (body.evidence ?? []).map((e) => ({ type: e.type, id: e.id.toLowerCase() }))
  const rawTargetId = target.proposal?.eligible ? (target.proposal.target ? targetInput.params[target.proposal.target.idArg] : undefined) : undefined
  const targetId = typeof rawTargetId === 'string' ? rawTargetId.toLowerCase() : null
  const dedupKey = body.dedup_key ?? null
  const live = (table: 'contacts' | 'threads' | 'interactions' | 'messages', qc: QueryContext, refId: string) => {
    const hasDeleted = table === 'contacts'
    let q = qc.db.selectFrom(table as 'contacts').select(sql<number>`1`.as('one')).where(sql.ref(`${table}.id`) as never, '=', refId as never).where(sql.ref(`${table}.organization_id`) as never, '=', env.organizationId as never)
    if (hasDeleted) q = q.where(sql.ref(`${table}.deleted_at`) as never, 'is', null as never)
    return q
  }

  return defineOperation<ActionRequestRecord>({
    name: 'action_requests.create',
    mutates: true,
    reads: (qc) => {
      const reads: Record<string, ReturnType<typeof readMaybe>> = { [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc) }
      if (contactId) reads['ar:contact'] = readMaybe(live('contacts', qc, contactId))
      if (threadId) reads['ar:thread'] = readMaybe(live('threads', qc, threadId))
      if (interactionId) reads['ar:interaction'] = readMaybe(qc.db.selectFrom('interactions').select('interactions.thread_id').where('interactions.id', '=', interactionId).where('interactions.organization_id', '=', env.organizationId))
      evidence.forEach((e, i) => {
        reads[`ar:evidence:${i}`] = readMaybe(live(e.type === 'message' ? 'messages' : 'interactions', qc, e.id))
      })
      const t = target.proposal?.eligible ? target.proposal.target : undefined
      if (t && targetId) {
        let q = qc.db.selectFrom(t.table as 'tasks').select(sql<number>`1`.as('one')).where(sql.ref(`${t.table}.id`) as never, '=', targetId as never).where(sql.ref(`${t.table}.organization_id`) as never, '=', env.organizationId as never)
        if (t.live) q = q.where(sql.ref(`${t.table}.deleted_at`) as never, 'is', null as never)
        reads['ar:target'] = readMaybe(q)
      }
      if (dedupKey !== null) {
        reads['ar:holder'] = readMaybe(
          selectRecord(actionRequests, qc, env, undefined, { derived: false })
            .select(ts.exact(qc, 'action_requests.updated_at').as('__stamp'))
            .where(sql<SqlBool>`${AR('dedup_key')} = ${dedupKey}`)
            .where(sql<SqlBool>`${AR('status')} = 'pending'`),
        )
      }
      return reads
    },
    build: (found, qc) => {
      const t = target.proposal?.eligible ? target.proposal.target : undefined
      if (t) {
        // An id-bearing operation: a missing record is the target's own 404 (D34); a non-UUID id is "not found" as it is for a direct call.
        if (!targetId || !/^[0-9a-f-]{36}$/.test(targetId) || found.maybe('ar:target') === null) throw new ApiError(404, 'not_found', t.notFound)
      }
      for (const key of ['ar:contact', 'ar:thread'] as const) if ((key === 'ar:contact' ? contactId : threadId) && found.maybe(key) === null) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
      if (interactionId) {
        const row = found.maybe('ar:interaction')
        if (row === null) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
        requireInteractionThread(row, interactionThreadId)
      }
      evidence.forEach((_e, i) => {
        if (found.maybe(`ar:evidence:${i}`) === null) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
      })
      const holderRow = dedupKey !== null ? found.maybe('ar:holder') : null
      const holder: Plan | null = holderRow ? (({ __stamp, ...rest }) => ({ record: toRecord(actionRequests, rest as Row), stamp: String(__stamp) }))(holderRow as Record<string, unknown>) : null
      const steps: Step[] = []
      const events: EventReceipt[] = []
      const holderExpired = holder !== null && expiredNow(holder.record, env.now)
      const supersedes = holder !== null && !holderExpired && holder.record.created_by === env.actor.id
      if (holder !== null && !holderExpired && !supersedes) throw new ApiError(409, 'duplicate_action_request', 'another proposer already has a pending request with this dedup_key')
      // The commit-time guard on the key's holder: it is still the pending row the plan read, or there still is none.
      if (holder !== null) steps.push(stillPending(qc, holder.record.id, holder.stamp, null))
      else if (dedupKey !== null) steps.push(assertStep(qc, sql<SqlBool>`not exists (select 1 from "action_requests" where ${AR('organization_id')} = ${env.organizationId} and ${AR('dedup_key')} = ${dedupKey} and ${AR('status')} = 'pending')`))
      if (holderExpired) {
        // D37: a stale holder is marked expired by the system principal in this unit, then the new request is created.
        const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), systemId, at)
        // The system principal's own statements come first (its assertion resets `changes()`, so nothing gated may follow it directly).
        steps.unshift(...sys.steps)
        steps.push(...transition({ env, qc, plan: holder!, to: 'expired', by: sys.id, at, eventId: takeoverEventId, eventType: 'action_request.expired' }))
        events.push({ id: takeoverEventId, type: 'action_request.expired', resourceType: 'action_request', resourceId: holder!.record.id })
      }
      if (supersedes) {
        // The superseded row is released first (the unique index admits one pending row per key); its pointer to the new row is set after the new row exists.
        steps.push(
          step(
            qc.db
              .updateTable('action_requests')
              .set({ status: 'superseded', decided_by: env.actor.id, decided_at: at, updated_at: at } as never)
              .where(sql<SqlBool>`${AR('id')} = ${holder!.record.id}`)
              .where(sql<SqlBool>`${AR('organization_id')} = ${env.organizationId}`)
              .where(sql<SqlBool>`${AR('status')} = 'pending'`)
              .where(sql<SqlBool>`${ts.exact(qc, 'action_requests.updated_at')} = ${holder!.stamp}`),
            undefined,
            { expect: 'affected' },
          ),
        )
      }
      const row = {
        id,
        organization_id: env.organizationId,
        created_by: env.actor.id,
        created_at: at,
        updated_at: at,
        operation: target.name,
        arguments: JSON.stringify(body.arguments),
        edited_arguments: null,
        status: 'pending' as const,
        reason: body.reason,
        evidence: JSON.stringify(evidence),
        contact_id: contactId,
        thread_id: threadId,
        interaction_id: interactionId,
        dedup_key: dedupKey,
        expires_at: expiresAt,
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        superseded_by_id: null,
        result: null,
        error_code: null,
        error_message: null,
        executed_at: null,
      }
      steps.push(step(qc.db.insertInto('action_requests').values(row), steps.length === 0 ? 'first-mutation' : undefined))
      steps.push(
        step(
          eventStatement(qc, { id: createdEventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'action_request.created', resourceType: 'action_request', resourceId: id, before: null, after: afterOf(actionRequests) }),
          steps.length === 1 ? 'first-event' : undefined,
        ),
      )
      events.push(receipt(actionRequests, createdEventId, 'created', id))
      if (supersedes) {
        const supersededEventId = env.newId()
        steps.push(
          step(
            qc.db
              .updateTable('action_requests')
              .set({ superseded_by_id: id } as never)
              .where(sql<SqlBool>`${AR('id')} = ${holder!.record.id}`)
              .where(sql<SqlBool>`${AR('organization_id')} = ${env.organizationId}`)
              .where(sql<SqlBool>`${AR('status')} = 'superseded'`),
            undefined,
            { expect: 'affected' },
          ),
          step(
            eventStatement(qc, { id: supersededEventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'action_request.superseded', resourceType: 'action_request', resourceId: holder!.record.id, before: holder!.record, after: afterOf(actionRequests) }),
          ),
        )
        events.push({ id: supersededEventId, type: 'action_request.superseded', resourceType: 'action_request', resourceId: holder!.record.id })
      }
      steps.push(resultStep(actionRequests, qc, env, id, createdEventId))
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('action_requests.create')
          return toRecord(actionRequests, rows[0]!)
        },
      })
    },
  })
}

/** `action_requests.withdraw`: the source principal only, while the request is pending (an expired one still can be, D37). */
async function withdrawRequest(registry: Registry, env: PreparedEnv, ctx: PrepareContext, rawId: string): Promise<PreparedOperation<ActionRequestRecord>> {
  const id = canonicalId(actionRequests, rawId)
  const plan = await ctx.read(readRequest(env, id))
  if (!plan) throw notFound()
  if (plan.record.created_by !== env.actor.id && !mayKnow(env, registry, plan.record, 'request_approval')) throw notFound()
  if (plan.record.created_by !== env.actor.id) throw new ApiError(403, 'not_request_source', 'only the principal that proposed the request can withdraw it')
  if (plan.record.status !== 'pending') throw notPending(plan.record.status)
  // The source still needs proposal authority on the target as it stands now (D38).
  const target = registry.get(plan.record.operation)
  if (target?.kind === 'tenant' && target.scope !== null && !env.scopes.has(proposalScopeOf(target.scope))) throw insufficient(proposalScopeOf(target.scope))
  return decide(env, plan, 'withdrawn', 'action_request.withdrawn', null)
}

/** `action_requests.reject`: the target's write authority (for the original arguments), while pending and not expired. */
async function rejectRequest(registry: Registry, env: PreparedEnv, ctx: PrepareContext, rawId: string, input: unknown): Promise<PreparedOperation<ActionRequestRecord>> {
  const body = parseInput(decisionBody, input ?? {}) as z.infer<typeof decisionBody>
  const id = canonicalId(actionRequests, rawId)
  const plan = await ctx.read(readRequest(env, id))
  if (!plan || !mayKnow(env, registry, plan.record, 'write')) throw notFound()
  if (plan.record.status !== 'pending') throw notPending(plan.record.status)
  if (expiredNow(plan.record, env.now)) throw expired()
  const target = targetOf(registry, plan.record.operation)
  if (!env.scopes.has(target.scope!)) throw insufficient(target.scope!)
  return decide(env, plan, 'rejected', 'action_request.rejected', body.decision_reason ?? null)
}

function decide(env: PreparedEnv, plan: Plan, to: 'rejected' | 'withdrawn', eventType: string, reason: string | null): PreparedOperation<ActionRequestRecord> {
  const at = codecs.timestamp.write(env.now)
  const eventId = env.newId()
  return defineOperation<ActionRequestRecord>({
    name: `action_requests.${to === 'rejected' ? 'reject' : 'withdraw'}`,
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          stillPending(qc, plan.record.id, plan.stamp, to === 'rejected' ? at : null),
          // Not `appliedPrev`-gated: the statement after an assertion must not be.
          ...transition({ env, qc, plan, to, by: env.actor.id, at, eventId, eventType, set: reason !== null ? { decision_reason: reason } : {}, label: true }),
          resultStep(actionRequests, qc, env, plan.record.id, eventId),
        ],
        events: [receipt(actionRequests, eventId, to === 'rejected' ? 'rejected' : 'withdrawn', plan.record.id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`action_requests.${to}`)
          return toRecord(actionRequests, rows[0]!)
        },
      }),
  })
}

/**
 * `action_requests.approve` ([[AGT8]] D4, D9, D10, D23, D35, D39): the target operation runs as the approver, with the approver's scopes, on the
 * effective arguments (the request's, or the reviewer's complete replacement), composed with the decision into ONE unit. The target's refusal
 * (any ApiError from its `prepare` or plan) is the answer and writes nothing, so the request stays pending. Steps: an assertion that the
 * request is still the pending, unexpired row planned; the target's own statements (its `result` step demoted: the unit's result is the
 * request); the guarded `pending -> executed` update, gated on every event of the target having been written, so a target that drifted
 * leaves no decision; `action_request.approved` and `action_request.executed`; the request as the result, gated on the last event.
 */
async function approveRequest(registry: Registry, env: PreparedEnv, ctx: PrepareContext, rawId: string, input: unknown): Promise<PreparedOperation<ActionRequestRecord>> {
  const body = parseInput(approveBody, input ?? {}) as z.infer<typeof approveBody>
  const id = canonicalId(actionRequests, rawId)
  const plan = await ctx.read(readRequest(env, id))
  if (!plan || !mayKnow(env, registry, plan.record, 'write')) throw notFound()
  if (plan.record.status !== 'pending') throw notPending(plan.record.status)
  if (expiredNow(plan.record, env.now)) throw expired()
  const target = targetOf(registry, plan.record.operation)
  if (!env.scopes.has(target.scope!)) throw insufficient(target.scope!)
  const effective = body.edited_arguments ?? plan.record.arguments
  // [[AGT8]] D49: an enqueued operation is authorised, not run: the approval creates its execution in the same unit.
  if (target.execution) return queuedApproval(env, ctx, plan, target, target.execution, effective, body)
  const targetInput = validateOperationInput(target, splitArguments(target, effective, { keepNull: true }))
  const inner = (await target.prepare(env, targetInput, noReads)) as PreparedOperation<unknown>
  const at = codecs.timestamp.write(env.now)
  const approvedEventId = env.newId()
  const executedEventId = env.newId()
  return defineOperation<ActionRequestRecord>({
    name: 'action_requests.approve',
    mutates: true,
    reads: (qc) => inner.reads(qc),
    build: (found, qc) => {
      const built = inner.build(found, qc)
      const resultOf = { events: built.events.map((e) => ({ type: e.type, resource_type: e.resourceType, resource_id: e.resourceId })) }
      const own = transition({
        env,
        qc,
        plan,
        to: 'executed',
        by: env.actor.id,
        at,
        eventId: approvedEventId,
        eventType: 'action_request.approved',
        gate: eventsPresent(built.events),
        set: {
          executed_at: at,
          result: JSON.stringify(resultOf),
          ...(body.edited_arguments !== undefined ? { edited_arguments: JSON.stringify(body.edited_arguments) } : {}),
          ...(body.decision_reason !== undefined ? { decision_reason: body.decision_reason } : {}),
        },
      })
      const executed = step(
        eventStatement(qc, { id: executedEventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'action_request.executed', resourceType: 'action_request', resourceId: plan.record.id, before: plan.record, after: afterOf(actionRequests) }),
      )
      return unit({
        steps: [
          stillPending(qc, plan.record.id, plan.stamp, at),
          ...built.steps.map((s) => (s.label === 'result' ? { query: s.query, ...(s.expect ? { expect: s.expect } : {}) } : s)),
          ...own,
          executed,
          resultStep(actionRequests, qc, env, plan.record.id, executedEventId),
        ],
        events: [
          ...built.events,
          receipt(actionRequests, approvedEventId, 'approved', plan.record.id),
          receipt(actionRequests, executedEventId, 'executed', plan.record.id),
        ],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('action_requests.approve')
          return toRecord(actionRequests, rows[0]!)
        },
      })
    },
  })
}

/**
 * The approval of an enqueued operation ([[AGT8]] D48-D50). The operation's own arguments are validated (a schema failure is a 400) and authorised as the approver:
 * its `authorise` resolves what must be true at this instant (an anchor, D9) and may refuse; a refusal answers its error and writes nothing, so the request stays
 * pending. ONE unit then holds the guarded pending -> `approved` transition (its commit-time resolution guards in the WHERE), `action_request.approved`, the execution row
 * gated on that event, `action_execution.created` and the request as the result gated on the last event: a decision that lost a race, or a guard that failed, leaves
 * no execution at all. The request stays `approved`; the runner moves it to `executed` or `failed` with the execution's outcome.
 */
async function queuedApproval(
  env: PreparedEnv,
  ctx: PrepareContext,
  plan: Plan,
  target: TenantOperation,
  execution: ExecutionDecl,
  effective: Record<string, unknown>,
  body: z.infer<typeof approveBody>,
): Promise<PreparedOperation<ActionRequestRecord>> {
  const isSend = target.name === 'messages.send'
  const publicArgs = isSend && body.edited_arguments === undefined ? {...effective,body:await readSendBody(requireSendStore(env.objects),env.organizationId,effective.body)} : effective
  const args = ownArguments(execution, publicArgs)
  if (isSend && plan.record.thread_id && args.thread_id && plan.record.thread_id !== args.thread_id) throw new ApiError(400,'validation_error','send thread must agree with request context')
  const interactionId = isSend && args.mode === 'reply' ? plan.record.interaction_id : null
  const auth = (await execution.authorise?.(env, args, ctx)) ?? {}
  if (isSend) args.body = await storeSendBody(requireSendStore(env.objects),env.organizationId,args.body as string)
  const hash = await inputHash(target.name, args)
  const at = codecs.timestamp.write(env.now)
  const deadline = codecs.timestamp.write(new Date(env.now.getTime() + DEADLINE_MS))
  const approvedEventId = env.newId()
  const createdEventId = env.newId()
  const executionId = env.newId()
  return defineOperation<ActionRequestRecord>({
    name: 'action_requests.approve',
    mutates: true,
    reads: (qc): Record<string, ReturnType<typeof readMaybe>> => interactionId ? {
      interaction: readMaybe(qc.db.selectFrom('interactions').select('interactions.thread_id').where('interactions.id', '=', interactionId).where('interactions.organization_id', '=', env.organizationId)),
    } : {},
    build: (found, qc) => {
      if (interactionId) {
        const row = found.maybe('interaction')
        if (row === null) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
        // Revalidate immutable context against complete edited arguments and pre-fix pending rows.
        requireInteractionThread(row, args.thread_id as string)
      }
      const guards = auth.guards?.(qc) ?? []
      const own = transition({
        env,
        qc,
        plan,
        to: 'approved',
        by: env.actor.id,
        at,
        eventId: approvedEventId,
        eventType: 'action_request.approved',
        ...(guards.length > 0 ? { gate: sql<SqlBool>`${sql.join(guards, sql` and `)}` } : {}),
        set: {
          ...(body.edited_arguments !== undefined ? { edited_arguments: JSON.stringify(isSend ? args : body.edited_arguments) } : {}),
          ...(body.decision_reason !== undefined ? { decision_reason: body.decision_reason } : {}),
        },
        label: true,
      })
      return unit({
        steps: [
          ...own,
          step(
            insertExecution(
              qc,
              {
                id: executionId,
                at,
                organizationId: env.organizationId,
                createdBy: plan.record.created_by,
                authorisedBy: env.actor.id,
                actionRequestId: plan.record.id,
                operation: target.name,
                arguments: args,
                resolution: auth.resolution ?? {},
                clientRef: clientRefOf(executionId, auth.clientRefDomain),
                idempotencyKey: null,
                inputHash: hash,
                deadlineAt: deadline,
              },
              [eventExists(approvedEventId)],
              { onConflictNothing: false },
            ),
          ),
          step(eventStatement(qc, { id: createdEventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'action_execution.created', resourceType: 'action_execution', resourceId: executionId, before: null, after: afterOf(actionExecutions) })),
          resultStep(actionRequests, qc, env, plan.record.id, createdEventId),
        ],
        events: [receipt(actionRequests, approvedEventId, 'approved', plan.record.id), receipt(actionExecutions, createdEventId, 'created', executionId)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('action_requests.approve')
          return toRecord(actionRequests, rows[0]!)
        },
      })
    },
  })
}

const needCtx = (ctx: PrepareContext | undefined): PrepareContext => {
  if (!ctx) throw new Error('a decision command is prepared by the executor, which supplies its plan reads')
  return ctx
}

/**
 * The commands of the queue. `registry` is read at `prepare`: the target of a request is whatever the registry that owns these operations
 * offers. They carry no scope of their own (D7, D38): the authority is the target's, checked in `prepare` with the target's name in the answer.
 */
export function actionRequestOperations(registry: Registry): TenantOperation[] {
  const names = proposableOperations(registry).map((o) => o.name)
  const createBody = z.strictObject({
    operation: z.enum(names as [string, ...string[]]).describe('The proposal-eligible operation to run on approval, for example tasks.update. Each operation\'s metadata (x-vault-proposal in OpenAPI) says what proposing it needs.'),
    arguments: z.record(z.string(), z.unknown()).describe('The operation\'s flat arguments: its path, query and body fields in one object, exactly as its MCP tool takes them.'),
    reason: z.string().trim().min(1).max(2000).describe('Why this change is proposed, plain text, for the reviewer.'),
    evidence: z.array(evidenceItem).max(20).optional().describe('Messages and interactions the proposal rests on.'),
    contact_id: z.uuid().optional().describe('Context: the contact this is about (needs contacts:read).'),
    thread_id: z.uuid().optional().describe('Context: the thread this is about (needs messages:read).'),
    interaction_id: z.uuid().optional().describe('Context: the interaction this is about (needs interactions:read); it must belong to thread_id when both are given.'),
    dedup_key: z.string().min(1).max(200).optional().describe('At most one pending request per key: the same proposer replaces its earlier request, another proposer gets 409 duplicate_action_request.'),
    expires_at: z.iso.datetime({ offset: true }).optional().describe(`When the request stops being approvable; default ${DEFAULT_EXPIRY_DAYS} days, at most ${MAX_EXPIRY_DAYS}.`),
  })
  const base = {
    kind: 'tenant' as const,
    surface: 'api' as const,
    d1Only: true,
    tags: ['action_requests'],
    scope: null,
    replanOnDrift: true,
    proposal: { eligible: false as const, reason: 'action requests are decided through action_requests.approve and action_requests.reject, never proposed' },
  }
  return [
    {
      ...base,
      name: 'action_requests.create',
      summary: 'Propose a change for review',
      description:
        'Proposes any proposal-eligible operation with its arguments; nothing changes until a reviewer approves. Needs <resource>:request_approval (or write) on the operation\'s resource, and the operation\'s own validation applies as for a direct call. Write-capable callers may propose too, to ask for review.',
      authority: 'request_approval',
      method: 'post',
      path: '/action-requests',
      validation: 'handler',
      request: { body: createBody },
      response: { status: 201, schema: actionRequests.record },
      prepare: (env, input) => createRequest(registry, env, input.body),
    },
    {
      ...base,
      name: 'action_requests.withdraw',
      summary: 'Withdraw a pending action request',
      description: 'Only the principal that proposed it can, while it is pending.',
      authority: 'request_approval',
      method: 'post',
      path: '/action-requests/{id}/withdraw',
      validation: 'handler',
      request: { params: idParams },
      response: { status: 200, schema: actionRequests.record },
      prepare: (env, input, ctx) => withdrawRequest(registry, env, needCtx(ctx), input.params.id as string),
    },
    {
      ...base,
      name: 'action_requests.approve',
      summary: 'Approve an action request and run its operation',
      description:
        'Needs write on the operation\'s resource (a user or an agent). Runs the operation now, as you, on the request\'s arguments or your complete edited_arguments, in one step with the decision; if the operation refuses, you get its error and the request stays pending.',
      authority: 'write',
      method: 'post',
      path: '/action-requests/{id}/approve',
      validation: 'handler',
      optionalBody: true,
      request: { params: idParams, body: approveBody },
      response: { status: 200, schema: actionRequests.record },
      prepare: (env, input, ctx) => approveRequest(registry, env, needCtx(ctx), input.params.id as string, input.body),
      // [[AGT8]] D49: a queued approval starts the runner after commit, best effort; an inline one answers `executed` and starts nothing.
      after: async (value, afterCtx) => {
        const r = value as ActionRequestRecord
        if (r.status === 'approved' && r.execution_id) afterCtx.kick(r.execution_id)
        return value
      },
    },
    {
      ...base,
      name: 'action_requests.reject',
      summary: 'Reject an action request',
      description: 'Needs write on the operation\'s resource. The reason is feedback to the proposer.',
      authority: 'write',
      method: 'post',
      path: '/action-requests/{id}/reject',
      validation: 'handler',
      optionalBody: true,
      request: { params: idParams, body: decisionBody },
      response: { status: 200, schema: actionRequests.record },
      prepare: (env, input, ctx) => rejectRequest(registry, env, needCtx(ctx), input.params.id as string, input.body),
    },
  ]
}
