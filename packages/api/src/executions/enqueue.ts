import { sql, type Expression, type SqlBool } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, codecs, defineOperation, readMaybe, step, unit, type PreparedOperation, type Row } from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { noReads } from '../proposal.js'
import type { Authorisation, ExecutionDecl, PrepareContext, RetryPolicy, TenantOperation } from '../registry.js'
import { parseInput } from '../resources/define.js'
import type { Scope } from '../scopes.js'
import { afterOf, receipt, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { inputHash } from './canonical.js'
import { actionExecutions, type ExecutionRecord } from './definition.js'
import { DEADLINE_MS, clientRefOf, insertExecution } from './rows.js'
import { describeSendBody, requireSendStore, storeSendBody } from '../messaging/send-body.js'

/** What an author gives to declare an enqueued operation ([[AGT8]] D2, D51, D52, D57). */
export interface EnqueuedSpec {
  name: string
  summary: string
  description?: string
  path: string
  tags?: string[]
  /** The write scope the operation needs (and the resource its `request_approval` belongs to). */
  scope: Scope
  retry?: RetryPolicy
  transport: string
  readScope: Scope
  /** The operation's own arguments, without `idempotency_key` (the builder adds it to the direct call's body). */
  input: z.ZodObject
  authorise?: (env: PreparedEnv, args: Record<string, unknown>, ctx: PrepareContext) => Promise<Authorisation | void>
}

const idempotencyKey = z.string().min(1).max(200).describe('Your key for this call: a repeat with the same key and arguments answers the same execution, and the same key with other arguments is 409 idempotency_key_reused. Unique per caller.')

/**
 * An operation declared `execution: enqueued` ([[AGT8]] D2, D51): called directly it authorises one durable execution and answers `202` with its receipt
 * (the execution record); approved from a request it authorises the same execution (`action_requests.approve`, which builds it with `queuedApproval`).
 * `after` starts the runner on the execution, best effort ([[AGT8]] D13, D49): the cron is the guarantee.
 */
export function enqueuedOperation(spec: EnqueuedSpec): TenantOperation {
  if ('idempotency_key' in spec.input.shape) throw new Error(`operation ${spec.name}: the input declares idempotency_key, which the builder adds`)
  const body = spec.input.safeExtend({ idempotency_key: idempotencyKey })
  const execution: ExecutionDecl = { ...(spec.retry ? { retry: spec.retry } : {}), transport: spec.transport, readScope: spec.readScope, input: spec.input, ...(spec.authorise ? { authorise: spec.authorise } : {}) }
  const description = [
    spec.description,
    'Enqueued: answers 202 with the execution receipt; poll action_executions.get for the outcome. idempotency_key is required: repeating the call with the same key and arguments answers the same execution.',
  ]
    .filter(Boolean)
    .join(' ')
  return {
    kind: 'tenant',
    surface: 'api',
    name: spec.name,
    summary: spec.summary,
    description,
    tags: spec.tags ?? [spec.name.split('.')[0]!],
    method: 'post',
    path: spec.path,
    scope: spec.scope,
    d1Only: true,
    replanOnDrift: true,
    validation: 'handler',
    proposal: { eligible: true },
    request: { body },
    response: { status: 202, schema: actionExecutions.record },
    execution,
    prepare: (env, input, ctx) => directEnqueue(spec.name, execution, body, env, input.body, ctx ?? noReads),
    after: async (value, ctx) => {
      ctx.kick((value as ExecutionRecord).id)
      return value
    },
  }
}

/** The own arguments of an enqueued operation out of a request's flat arguments: validated by its input schema; `idempotency_key` is ignored (an approval carries none). */
export function ownArguments(execution: ExecutionDecl, args: Record<string, unknown>): Record<string, unknown> {
  const { idempotency_key: _ignored, ...rest } = args
  return parseInput(execution.input, rest)
}

async function directEnqueue(operation: string, execution: ExecutionDecl, bodySchema: z.ZodObject, env: PreparedEnv, rawBody: unknown, ctx: PrepareContext): Promise<PreparedOperation<ExecutionRecord>> {
  // The key first, by name: a missing key is the commonest mistake of a first call, and zod's own message would not say which field.
  const key = idempotencyKey.safeParse(rawBody !== null && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>).idempotency_key : undefined)
  if (!key.success) throw new ApiError(400, 'validation_error', `idempotency_key is required: ${key.error.issues.map((i) => i.message).join('; ')}`)
  const { idempotency_key: _key, ...args } = parseInput(bodySchema, rawBody) as { idempotency_key: string } & Record<string, unknown>
  const sendText = operation === 'messages.send' ? args.body as string : undefined
  if (sendText !== undefined) args.body = await describeSendBody(sendText)
  const hash = await inputHash(operation, args)
  const byKey = (qc: Parameters<PreparedOperation<unknown>['reads']>[0]) =>
    selectRecord(actionExecutions, qc, env, undefined, { derived: false })
      .select(sql<string>`${sql.ref('action_executions.input_hash')}`.as('__hash'))
      .where(sql<SqlBool>`${sql.ref('action_executions.created_by')} = ${env.actor.id}`)
      .where(sql<SqlBool>`${sql.ref('action_executions.idempotency_key')} = ${key.data}`)
  const replay = (existing: Row) => {
    const { __hash, ...rest } = existing
    if (__hash !== hash) throw new ApiError(409, 'idempotency_key_reused', 'this idempotency_key was used for a different call; use a new key for a different call')
    return unit({ steps: [], events: [], decode: () => toRecord(actionExecutions, rest) })
  }
  // D61: a prior receipt survives a later authorisation refusal. Only a new key reaches authorise.
  const existing = await ctx.read(defineOperation<Row | null>({
    name: `${operation}.enqueue.lookup`,
    mutates: false,
    reads: (qc) => ({ existing: readMaybe(byKey(qc)) }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.maybe('existing') }),
  }))
  if (existing) return defineOperation({ name: `${operation}.enqueue`, mutates: false, reads: () => ({}), build: () => replay(existing) })
  const auth = (await execution.authorise?.(env, args, ctx)) ?? {}
  if (sendText !== undefined) await storeSendBody(requireSendStore(env.objects), env.organizationId, sendText)
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const deadline = codecs.timestamp.write(new Date(env.now.getTime() + DEADLINE_MS))
  return defineOperation<ExecutionRecord>({
    name: `${operation}.enqueue`,
    mutates: true,
    reads: (qc) => ({ existing: readMaybe(byKey(qc)) }),
    build: (found, qc) => {
      const existing = found.maybe('existing')
      if (existing) {
        // D51: the same key and input is the same execution and writes nothing; another input under the key is a conflict.
        return replay(existing)
      }
      const guards: Expression<SqlBool>[] = auth.guards?.(qc) ?? []
      return unit({
        steps: [
          step(
            insertExecution(
              qc,
              { id, at, organizationId: env.organizationId, createdBy: env.actor.id, authorisedBy: env.actor.id, actionRequestId: null, operation, arguments: args, resolution: auth.resolution ?? {}, clientRef: clientRefOf(id, auth.clientRefDomain), idempotencyKey: key.data, inputHash: hash, deadlineAt: deadline },
              guards,
              { onConflictNothing: true },
            ),
            'first-mutation',
          ),
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'action_execution.created', resourceType: 'action_execution', resourceId: id, before: null, after: afterOf(actionExecutions) }), 'first-event'),
          step(
            selectRecord(actionExecutions, qc, env, id).where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`),
            'result',
          ),
        ],
        events: [receipt(actionExecutions, eventId, 'created', id)],
        // No row: the insert did nothing (a same-key call won the race, or a guard failed); the replan decides which.
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`${operation}.enqueue`)
          return toRecord(actionExecutions, rows[0]!)
        },
      })
    },
  })
}
