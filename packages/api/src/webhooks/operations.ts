import { sql, type SqlBool } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, appliedPrev, bind, codecs, defineOperation, readAll, readMaybe, recordColumns, step, ts, unit, type PreparedOperation, type QueryContext } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { feedVisibility } from '../events/operations.js'
import { eventStatement } from '../outbox.js'
import { ScopeSet } from '../scopes.js'
import type { Registry, TenantOperation } from '../registry.js'
import { afterOf, receipt, resultStep, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { definePreparedResource } from '../storage/definition.js'
import type { WebhooksRuntime } from './config.js'
import { ROTATION_OVERLAP_MS, mintSecret } from './secrets.js'
import { validateWebhookUrl } from './urls.js'

// [[API7]] cycle 1 (D1, D2, D3, D5, D12, D13, D16, D18, D22, D23): the six hand-written subscription operations of `/meta/v1`. Ownership is the D1 predicate, applied in every read: an
// agent sees and changes only its own subscriptions (the rest are 404), an owner (a user holding the scope) any. Every write is one unit: the row, its secret and dispatch-state
// machinery rows where it has them, and ONE event, in a single `batch()`. The machinery rows are written without events (D20).

/** [[API7]] D16: live subscriptions per agent. */
export const MAX_SUBSCRIPTIONS_PER_AGENT = 10
/** [[API7]] D18: the default `event_types`, stored resolved. */
export const DEFAULT_EVENT_TYPES = ['interaction.created'] as const

const EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const SCOPE_STRING = /^[a-z][a-z0-9_]*:(read|request_approval|write)$/

export const webhookRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  agent_id: z.uuid().describe('The agent that owns the subscription: it receives only event types it could read itself.'),
  url: z.string().describe('Where events are POSTed: https, a public host.'),
  event_types: z.array(z.string()).describe('The exact event types delivered, for example task.created.'),
  status: z.enum(['active', 'paused', 'disabled']).describe('paused by a caller; disabled by Vibase after sustained failure.'),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type WebhookRecord = z.infer<typeof webhookRecord>

/**
 * The record helper of the table: it gives the operations the projection, the event `after` and the receipts the resources use. It is NOT registered (no generic CRUD, D22):
 * it generates no operation and adds no entry to the feed's event-type map, where `webhook` is registered invisible.
 */
const webhooks = definePreparedResource({
  surface: 'meta',
  name: 'webhooks',
  eventName: 'webhook',
  table: 'webhook_subscriptions',
  scopeResource: 'webhooks',
  d1Only: true,
  operations: [],
  notProposable: 'webhook subscriptions are not proposable',
  record: webhookRecord,
})

const createBody = z.strictObject({
  url: z.string().describe('The target URL: https, a public host, at most 2048 characters.'),
  event_types: z
    .array(z.string().regex(EVENT_TYPE, 'an event type is <resource>.<action> in lower case, for example task.created'))
    .min(1)
    .max(20)
    .optional()
    .describe('Exact event types, 1 to 20. Omitted: ["interaction.created"]. Each must be a type the owning agent could read through the feed.'),
  agent_id: z.uuid().optional().describe('The agent that owns the subscription. An agent caller may omit it (it owns its own); a person must name one.'),
})
const updateBody = z.strictObject({
  url: z.string().optional(),
  event_types: z
    .array(z.string().regex(EVENT_TYPE, 'an event type is <resource>.<action> in lower case, for example task.created'))
    .min(1)
    .max(20)
    .optional()
    .describe('Replaces the list; omitted leaves it as it is. Takes effect from the current position, with no rewind.'),
  status: z.enum(['active', 'paused']).optional().describe('paused stops delivery and keeps the position; active resumes (and re-enables a subscription Vibase disabled).'),
})
const idParams = z.object({ id: z.uuid() })
const listQuery = z.object({
  after: z.uuid().optional().describe('The id of the last subscription you have seen (the previous page\'s next_cursor).'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  agent_id: z.uuid().optional().describe('Only this agent\'s subscriptions (an agent sees only its own whatever it asks).'),
})
/** [[API7]] D14: a delivery as `webhooks.deliveries` shows it: no lease columns, no organisation, no creator. */
export const deliveryRecord = z.object({
  id: z.uuid(),
  subscription_id: z.uuid(),
  event_id: z.uuid().describe('The event this delivery carries; it is the webhook-id header of the POST.'),
  event_type: z.string(),
  status: z.enum(['pending', 'delivered', 'dead', 'cancelled']).describe('pending: waiting or between attempts; delivered: a 2xx answered; dead: every attempt failed; cancelled: the subscription was deleted or its agent lost the read scope.'),
  attempts: z.number().int(),
  next_attempt_at: z.string(),
  last_attempt_at: z.string().nullable(),
  last_status_code: z.number().int().nullable(),
  last_error: z.string().nullable().describe('timeout, connection_failed, http_status, redirect, sender_failed, cancelled_subscription or cancelled_scope. A response body is never kept.'),
  delivered_at: z.string().nullable(),
  created_at: z.string(),
})
const DELIVERY_COLUMNS = ['id', 'subscription_id', 'event_id', 'event_type', 'status', 'attempts', 'next_attempt_at', 'last_attempt_at', 'last_status_code', 'last_error', 'delivered_at', 'created_at'] as const
const deliveriesQuery = z.object({
  status: z.enum(['pending', 'delivered', 'dead', 'cancelled']).optional().describe('Only deliveries in this status.'),
  after: z.uuid().optional().describe('The id of the last delivery you have seen (the previous page\'s next_cursor).'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const created = webhookRecord.extend({ secret: z.string().describe('The signing secret, whsec_ + base64. Shown only here and in rotate_secret: store it now.') })
const rotated = z.object({
  secret: z.string().describe('The new signing secret, shown only here.'),
  previous_valid_until: z.string().describe('The previous secret still signs deliveries until this time (24 hours); a receiver may accept both meanwhile.'),
})

const notFound = () => new ApiError(404, 'not_found', 'webhook not found')
const invalidReference = () => new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
const notConfigured = () => new ApiError(501, 'webhooks_not_configured', 'webhooks are not configured on this deployment: set CREDENTIALS_KEY (base64 of 32 bytes)')
const lower = (s: string) => s.toLowerCase()
const SUB = (column: string) => sql.ref(`webhook_subscriptions.${column}`)

/** D1: an agent caller sees only its own subscriptions; a user (the scope is the owner's) any. */
const ownership = (env: PreparedEnv) => (env.actor.kind === 'agent' ? sql<SqlBool>`${SUB('agent_id')} = ${env.actor.id}` : sql<SqlBool>`1 = 1`)

const unique = (types: readonly string[]) => [...new Set(types)]

/** The agent whose visibility judges the types, as the plan reads it. */
type AgentRow = { disabled_at: string | null; delegated_by: string | null; scopes: string[] }
const agentRead = (qc: QueryContext, env: PreparedEnv, agentId: string) =>
  readMaybe(qc.db.selectFrom('agents').select(['agents.id', 'agents.scopes', 'agents.disabled_at', 'agents.delegated_by']).where('agents.id', '=', agentId).where('agents.organization_id', '=', env.organizationId))
const agentOf = (row: Record<string, unknown> | null): AgentRow | null =>
  row ? { disabled_at: (row.disabled_at as string | null) ?? null, delegated_by: (row.delegated_by as string | null) ?? null, scopes: codecs.stringArray.read(row.scopes) } : null

/**
 * D3: every type must name a resource type the registry's event-type map knows (`unknown_event_type`) and the agent must be able to see it through the feed (`event_type_not_readable`):
 * the agent's own read scopes and identity (D19's owner predicate), never the caller's. A type with no entry, or an `invisible` one, is not readable (`action_request.*` today).
 */
export function checkEventTypes(registry: Registry, agent: { id: string; scopes: readonly string[] }, types: readonly string[]): void {
  const map = registry.eventTypes()
  const resourceOf = (type: string) => type.slice(0, type.indexOf('.'))
  for (const type of types) {
    if (!map.has(resourceOf(type))) throw new ApiError(400, 'unknown_event_type', `unknown event type ${type}: no resource type ${resourceOf(type)}`)
  }
  const vis = feedVisibility(registry, { scopes: ScopeSet.parse(agent.scopes.filter((s) => SCOPE_STRING.test(s))), actor: { id: agent.id, kind: 'agent' } })
  const readable = new Set(vis.readable)
  for (const o of vis.owned ?? []) readable.add(o.resourceType)
  if (vis.edge && vis.edge.endpointTypes.length > 0) readable.add(vis.edge.resourceType)
  for (const type of types) {
    if (!readable.has(resourceOf(type))) throw new ApiError(400, 'event_type_not_readable', `the agent cannot read ${type} events: it lacks the read scope of that resource, or the type is not available to subscriptions`)
  }
}

function checkUrl(runtime: WebhooksRuntime | null, raw: string): void {
  const verdict = validateWebhookUrl(raw, { allowInsecure: runtime?.allowInsecureUrls ?? false })
  if (!verdict.ok) throw new ApiError(400, 'invalid_url', verdict.reason)
}

// ---- reads ---------------------------------------------------------------------------------------------

function listOperation(env: PreparedEnv, q: z.infer<typeof listQuery>): PreparedOperation<unknown> {
  const limit = q.limit ?? 50
  return defineOperation({
    name: 'webhooks.list',
    mutates: false,
    reads: (qc) => {
      let query = selectRecord(webhooks, qc, env).where(ownership(env))
      if (q.agent_id !== undefined) query = query.where(sql<SqlBool>`${SUB('agent_id')} = ${lower(q.agent_id)}`)
      if (q.after !== undefined) query = query.where(sql<SqlBool>`${SUB('id')} > ${lower(q.after)}`)
      return { page: readAll(query.orderBy(SUB('id')).limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = found.all('page')
          const page = rows.slice(0, limit).map((r) => toRecord(webhooks, r))
          return { data: page, next_cursor: rows.length > limit ? page[page.length - 1]!.id : null }
        },
      }),
  })
}

function getOperation(env: PreparedEnv, rawId: string): PreparedOperation<unknown> {
  const id = lower(rawId)
  return defineOperation({
    name: 'webhooks.get',
    mutates: false,
    reads: (qc) => ({ row: readMaybe(selectRecord(webhooks, qc, env, id).where(ownership(env))) }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) throw notFound()
          return toRecord(webhooks, row)
        },
      }),
  })
}

/** D14: a subscription's deliveries, oldest id first (the order the dispatcher inserted them), the subscription found by the same ownership and liveness as `webhooks.get`. */
function deliveriesOperation(env: PreparedEnv, rawId: string, q: z.infer<typeof deliveriesQuery>): PreparedOperation<unknown> {
  const id = lower(rawId)
  const limit = q.limit ?? 50
  return defineOperation({
    name: 'webhooks.deliveries',
    mutates: false,
    reads: (qc) => {
      let page = qc.db
        .selectFrom('webhook_deliveries')
        .select(recordColumns(qc, 'webhook_deliveries', DELIVERY_COLUMNS))
        .where('webhook_deliveries.organization_id', '=', env.organizationId)
        .where('webhook_deliveries.subscription_id', '=', id)
      if (q.status !== undefined) page = page.where('webhook_deliveries.status', '=', q.status)
      if (q.after !== undefined) page = page.where(sql<SqlBool>`${sql.ref('webhook_deliveries.id')} > ${lower(q.after)}`)
      return { sub: readMaybe(selectRecord(webhooks, qc, env, id).where(ownership(env))), page: readAll(page.orderBy('webhook_deliveries.id').limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          if (!found.maybe('sub')) throw notFound()
          const rows = found.all('page')
          const data = rows.slice(0, limit).map((r) => deliveryRecord.parse(r))
          return { data, next_cursor: rows.length > limit ? data[data.length - 1]!.id : null }
        },
      }),
  })
}

/** The subscription as an event's `before` and as the unit's guard: the record and its exact stored `updated_at`. */
const beforeOf = (qc: QueryContext, env: PreparedEnv, id: string) => readMaybe(selectRecord(webhooks, qc, env, id, { derived: false }).where(ownership(env)).select(ts.exact(qc, 'webhook_subscriptions.updated_at').as('__stamp')))

// ---- writes --------------------------------------------------------------------------------------------

function createOperation(env: PreparedEnv, runtime: WebhooksRuntime, registry: Registry, body: z.infer<typeof createBody>, minted: { secret: string; sealed: string }): PreparedOperation<unknown> {
  const own = env.actor.kind === 'agent'
  if (own && body.agent_id !== undefined && lower(body.agent_id) !== env.actor.id) throw invalidReference()
  if (!own && body.agent_id === undefined) throw new ApiError(400, 'validation_error', 'agent_id is required: a subscription belongs to an agent')
  const agentId = own ? env.actor.id : lower(body.agent_id!)
  const types = unique(body.event_types ?? DEFAULT_EVENT_TYPES)
  const id = env.newId()
  const secretId = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation({
    name: 'webhooks.create',
    mutates: true,
    reads: (qc) => ({
      agent: agentRead(qc, env, agentId),
      live: readMaybe(qc.db.selectFrom('webhook_subscriptions').select(sql<number>`count(*)`.as('n')).where('webhook_subscriptions.organization_id', '=', env.organizationId).where('webhook_subscriptions.agent_id', '=', agentId).where('webhook_subscriptions.deleted_at', 'is', null)),
    }),
    build: (found, qc) => {
      const agent = agentOf(found.maybe('agent'))
      if (!agent || agent.disabled_at !== null) throw invalidReference()
      if (agent.delegated_by !== null) throw new ApiError(400, 'agent_not_eligible', 'a delegated agent (an OAuth client acting for a person) cannot own a webhook subscription')
      checkEventTypes(registry, { id: agentId, scopes: agent.scopes }, types)
      if (Number(found.maybe('live')?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_AGENT) throw new ApiError(409, 'webhook_limit', `an agent may have ${MAX_SUBSCRIPTIONS_PER_AGENT} webhook subscriptions`)
      // The commit-time form of the plan's checks: the agent is still live and eligible and the limit still holds, else nothing is written (the unit drifts, is planned again and refused above).
      const eligible = sql<SqlBool>`exists (select 1 from "agents" where "agents"."id" = ${agentId} and "agents"."organization_id" = ${env.organizationId} and "agents"."disabled_at" is null and "agents"."delegated_by" is null)`
      const underLimit = sql<SqlBool>`(select count(*) from "webhook_subscriptions" where "webhook_subscriptions"."organization_id" = ${env.organizationId} and "webhook_subscriptions"."agent_id" = ${agentId} and "webhook_subscriptions"."deleted_at" is null) < ${MAX_SUBSCRIPTIONS_PER_AGENT}`
      const insertSubscription = qc.db
        .insertInto('webhook_subscriptions')
        .columns(['id', 'created_at', 'updated_at', 'organization_id', 'created_by', 'agent_id', 'url', 'event_types', 'status', 'deleted_at'])
        .expression(
          qc.db
            .selectNoFrom([
              bind(qc, 'uuid', id).as('id'),
              bind(qc, 'timestamp', at).as('created_at'),
              bind(qc, 'timestamp', at).as('updated_at'),
              bind(qc, 'uuid', env.organizationId).as('organization_id'),
              bind(qc, 'uuid', env.actor.id).as('created_by'),
              bind(qc, 'uuid', agentId).as('agent_id'),
              bind(qc, 'text', body.url).as('url'),
              bind(qc, 'string_array', types).as('event_types'),
              bind(qc, 'text', 'active').as('status'),
              bind(qc, 'timestamp', null).as('deleted_at'),
            ])
            .where(eligible)
            .where(underLimit),
        )
      // Each machinery row is gated on the statement before it having applied, so a refused insert leaves nothing of the unit (D20: no events for machinery).
      const insertSecret = qc.db
        .insertInto('webhook_secrets')
        .columns(['id', 'created_at', 'organization_id', 'created_by', 'subscription_id', 'sealed', 'key_version'])
        .expression(
          qc.db
            .selectNoFrom([
              bind(qc, 'uuid', secretId).as('id'),
              bind(qc, 'timestamp', at).as('created_at'),
              bind(qc, 'uuid', env.organizationId).as('organization_id'),
              bind(qc, 'uuid', env.actor.id).as('created_by'),
              bind(qc, 'uuid', id).as('subscription_id'),
              bind(qc, 'text', minted.sealed).as('sealed'),
              bind(qc, 'integer', runtime.key!.version).as('key_version'),
            ])
            .where(appliedPrev(qc)),
        )
      // D5: the horizon is the newest event once this unit's own `webhook.created` is in, which is that event: nothing committed before creation is delivered, nothing after is lost.
      const insertState = qc.db
        .insertInto('webhook_dispatch_state')
        .columns(['subscription_id', 'created_at', 'organization_id', 'created_by', 'cursor_event_id', 'last_dispatched_at', 'last_success_at'])
        .expression(
          qc.db
            .selectNoFrom([
              bind(qc, 'uuid', id).as('subscription_id'),
              bind(qc, 'timestamp', at).as('created_at'),
              bind(qc, 'uuid', env.organizationId).as('organization_id'),
              bind(qc, 'uuid', env.actor.id).as('created_by'),
              sql<string>`(select "id" from "events" order by "seq" desc limit 1)`.as('cursor_event_id'),
              bind(qc, 'timestamp', null).as('last_dispatched_at'),
              bind(qc, 'timestamp', null).as('last_success_at'),
            ])
            .where(appliedPrev(qc)),
        )
      return unit({
        steps: [
          step(insertSubscription, 'first-mutation', { expect: 'affected' }),
          step(insertSecret),
          step(
            eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'webhook.created', resourceType: 'webhook', resourceId: id, before: null, after: afterOf(webhooks) }),
            'first-event',
          ),
          step(insertState),
          resultStep(webhooks, qc, env, id, eventId),
        ],
        events: [receipt(webhooks, eventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('webhooks.create')
          return { ...toRecord(webhooks, rows[0]!), secret: minted.secret }
        },
      })
    },
  })
}

function updateOperation(env: PreparedEnv, registry: Registry, rawId: string, body: z.infer<typeof updateBody>): PreparedOperation<unknown> {
  const id = lower(rawId)
  const types = body.event_types === undefined ? undefined : unique(body.event_types)
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const empty = body.url === undefined && types === undefined && body.status === undefined
  return defineOperation({
    name: 'webhooks.update',
    mutates: true,
    reads: (qc) => ({
      before: beforeOf(qc, env, id),
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .innerJoin('webhook_subscriptions', 'webhook_subscriptions.agent_id', 'agents.id')
          .select(['agents.id', 'agents.scopes', 'agents.disabled_at', 'agents.delegated_by'])
          .where('webhook_subscriptions.id', '=', id)
          .where('webhook_subscriptions.organization_id', '=', env.organizationId),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound()
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(webhooks, rest as never)
      if (types !== undefined) checkEventTypes(registry, { id: String(found.maybe('agent')?.id ?? ''), scopes: agentOf(found.maybe('agent'))?.scopes ?? [] }, types)
      if (empty) return unit({ steps: [], events: [], decode: () => before })
      const update = qc.db
        .updateTable('webhook_subscriptions')
        .set({ updated_at: at, ...(body.url !== undefined ? { url: body.url } : {}), ...(types !== undefined ? { event_types: types } : {}), ...(body.status !== undefined ? { status: body.status } : {}) })
        .where(sql<SqlBool>`${SUB('id')} = ${id}`)
        .where(sql<SqlBool>`${SUB('organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${SUB('deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, 'webhook_subscriptions.updated_at')} = ${String(__stamp)}`)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'webhook.updated', resourceType: 'webhook', resourceId: id, before, after: afterOf(webhooks) }),
            'first-event',
          ),
          resultStep(webhooks, qc, env, id, eventId),
        ],
        events: [receipt(webhooks, eventId, 'updated', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('webhooks.update')
          return toRecord(webhooks, rows[0]!)
        },
      })
    },
  })
}

function deleteOperation(env: PreparedEnv, rawId: string): PreparedOperation<void> {
  const id = lower(rawId)
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<void>({
    name: 'webhooks.delete',
    mutates: true,
    reads: (qc) => ({ before: beforeOf(qc, env, id) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound()
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(webhooks, rest as never)
      const update = qc.db
        .updateTable('webhook_subscriptions')
        .set({ deleted_at: at, updated_at: at })
        .where(sql<SqlBool>`${SUB('id')} = ${id}`)
        .where(sql<SqlBool>`${SUB('organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${SUB('deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, 'webhook_subscriptions.updated_at')} = ${String(__stamp)}`)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'webhook.deleted', resourceType: 'webhook', resourceId: id, before, after: null }), 'first-event'),
          step(qc.db.selectNoFrom(sql<number>`1`.as('applied')).where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`), 'result'),
        ],
        events: [receipt(webhooks, eventId, 'deleted', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('webhooks.delete')
        },
      })
    },
  })
}

function rotateOperation(env: PreparedEnv, runtime: WebhooksRuntime, rawId: string, minted: { secret: string; sealed: string }): PreparedOperation<unknown> {
  const id = lower(rawId)
  const secretId = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const previousValidUntil = new Date(env.now.getTime() + ROTATION_OVERLAP_MS).toISOString()
  return defineOperation({
    name: 'webhooks.rotate_secret',
    mutates: true,
    reads: (qc) => ({ before: beforeOf(qc, env, id) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound()
      const { __stamp: _stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(webhooks, rest as never)
      const live = sql<SqlBool>`exists (select 1 from "webhook_subscriptions" where ${SUB('id')} = ${id} and ${SUB('organization_id')} = ${env.organizationId} and ${SUB('deleted_at')} is null)`
      // Append-only (D12): a rotation is an insert; the subscription row is not touched, so its updated_at stays.
      const insertSecret = qc.db
        .insertInto('webhook_secrets')
        .columns(['id', 'created_at', 'organization_id', 'created_by', 'subscription_id', 'sealed', 'key_version'])
        .expression(
          qc.db
            .selectNoFrom([
              bind(qc, 'uuid', secretId).as('id'),
              bind(qc, 'timestamp', at).as('created_at'),
              bind(qc, 'uuid', env.organizationId).as('organization_id'),
              bind(qc, 'uuid', env.actor.id).as('created_by'),
              bind(qc, 'uuid', id).as('subscription_id'),
              bind(qc, 'text', minted.sealed).as('sealed'),
              bind(qc, 'integer', runtime.key!.version).as('key_version'),
            ])
            .where(live),
        )
      return unit({
        steps: [
          step(insertSecret, 'first-mutation', { expect: 'affected' }),
          // The record, never the secret: before and after are the same row.
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'webhook.secret_rotated', resourceType: 'webhook', resourceId: id, before, after: afterOf(webhooks) }), 'first-event'),
          resultStep(webhooks, qc, env, id, eventId),
        ],
        events: [receipt(webhooks, eventId, 'secret_rotated', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('webhooks.rotate_secret')
          return { secret: minted.secret, previous_valid_until: previousValidUntil }
        },
      })
    },
  })
}

// ---- the operations ------------------------------------------------------------------------------------

const WRITE_NOT_PROPOSABLE = 'webhook subscriptions carry a signing secret shown once and are administered directly, never proposed'

/**
 * `webhooks.list`, `get`, `deliveries`, `create`, `update`, `delete` and `rotate_secret` ([[API7]] D14, D22): `/meta/v1`, `d1Only`, scopes `webhooks:read` and `webhooks:write`. The registry carries them
 * whatever the configuration (the CLI and MCP tool lists must not change per deployment); a deployment without a usable `CREDENTIALS_KEY` answers `501 webhooks_not_configured`
 * on `create` and `rotate_secret` only (D12). `registry` is read at call time, for the feed's event-type map.
 */
export function webhookOperations(runtime: WebhooksRuntime | null, registry: () => Registry): TenantOperation[] {
  const base = { kind: 'tenant' as const, surface: 'meta' as const, tags: ['webhooks'], validation: 'adapter' as const, d1Only: true, replanOnDrift: true }
  const readScope = { resource: 'webhooks', action: 'read' as const }
  const writeScope = { resource: 'webhooks', action: 'write' as const }
  const proposal = { eligible: false as const, reason: WRITE_NOT_PROPOSABLE }
  const keyed = (): WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> } => {
    if (!runtime?.key) throw notConfigured()
    return runtime as WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> }
  }
  return [
    {
      ...base,
      name: 'webhooks.list',
      summary: 'List webhook subscriptions',
      description: 'An agent sees its own subscriptions; an owner sees all. Never carries a secret. Page with after (the previous page\'s next_cursor).',
      method: 'get',
      path: '/webhooks',
      scope: readScope,
      request: { query: listQuery },
      response: { status: 200, schema: z.object({ data: z.array(webhookRecord), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => listOperation(env, input.query as z.infer<typeof listQuery>),
    },
    {
      ...base,
      name: 'webhooks.get',
      summary: 'Get a webhook subscription',
      description: 'A subscription that belongs to another agent is 404 for an agent caller. Never carries a secret.',
      method: 'get',
      path: '/webhooks/{id}',
      scope: readScope,
      request: { params: idParams },
      response: { status: 200, schema: webhookRecord },
      prepare: (env, input) => getOperation(env, String((input.params as { id: string }).id)),
    },
    {
      ...base,
      name: 'webhooks.deliveries',
      summary: "List a webhook subscription's deliveries",
      description:
        'One row per event the subscription was dispatched, oldest first: pending (waiting or between attempts), delivered, dead (every attempt failed) or cancelled, with the attempts made and the last failure (a code and an HTTP status, never a response body). ' +
        'Filter with status; page with after (the previous page\'s next_cursor). Answers why a hook did or did not fire. A subscription that belongs to another agent is 404 for an agent caller. Read only: there is no redelivery, recovery is the event feed.',
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      scope: readScope,
      request: { params: idParams, query: deliveriesQuery },
      response: { status: 200, schema: z.object({ data: z.array(deliveryRecord), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => deliveriesOperation(env, String((input.params as { id: string }).id), input.query as z.infer<typeof deliveriesQuery>),
    },
    {
      ...base,
      name: 'webhooks.create',
      summary: 'Subscribe an agent to event types: signed POSTs to an https URL',
      description:
        'Creates a subscription for an agent and answers it with the signing secret, shown only now. Delivery starts from events committed after this call. event_types default to ["interaction.created"]; each type must be one the owning agent could read through the feed (400 event_type_not_readable otherwise), and the agent may hold 10 subscriptions (409 webhook_limit). 501 webhooks_not_configured when the deployment has no CREDENTIALS_KEY.',
      method: 'post',
      path: '/webhooks',
      scope: writeScope,
      proposal,
      request: { body: createBody },
      response: { status: 201, schema: created },
      prepare: async (env, input) => {
        const config = keyed()
        const body = input.body as z.infer<typeof createBody>
        checkUrl(config, body.url)
        return createOperation(env, config, registry(), body, await mintSecret(env.randomBytes, config.key.bytes))
      },
    },
    {
      ...base,
      name: 'webhooks.update',
      summary: 'Change a webhook subscription: its URL, its event types, or pause and resume it',
      description: 'Changes take effect at the next dispatch from the current position (nothing is replayed). status may be active or paused; Vibase itself sets disabled. Changed event types are checked like create.',
      method: 'patch',
      path: '/webhooks/{id}',
      scope: writeScope,
      proposal,
      request: { params: idParams, body: updateBody },
      response: { status: 200, schema: webhookRecord },
      prepare: (env, input) => {
        const body = input.body as z.infer<typeof updateBody>
        if (body.url !== undefined) checkUrl(runtime, body.url)
        return updateOperation(env, registry(), String((input.params as { id: string }).id), body)
      },
    },
    {
      ...base,
      name: 'webhooks.delete',
      summary: 'Delete a webhook subscription',
      description: 'Soft delete: the subscription stops delivering at once and is 404 afterwards.',
      method: 'delete',
      path: '/webhooks/{id}',
      scope: writeScope,
      proposal,
      request: { params: idParams },
      response: { status: 204 },
      prepare: (env, input) => deleteOperation(env, String((input.params as { id: string }).id)),
    },
    {
      ...base,
      name: 'webhooks.rotate_secret',
      summary: 'Rotate the signing secret of a webhook subscription',
      description: 'Answers the new secret, shown only now. The previous secret keeps signing alongside it until previous_valid_until (24 hours), so a receiver can switch without dropping deliveries.',
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      scope: writeScope,
      proposal,
      request: { params: idParams },
      response: { status: 200, schema: rotated },
      prepare: async (env, input) => {
        const config = keyed()
        return rotateOperation(env, config, String((input.params as { id: string }).id), await mintSecret(env.randomBytes, config.key.bytes))
      },
    },
  ]
}
