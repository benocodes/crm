import { z } from 'zod'
import { UnitDriftError } from '@vibase/storage'
import { ApiError, mapStorageError } from '../errors.js'
import { feedVisibility } from '../events/operations.js'
import { ScopeSet } from '../scopes.js'
import type { ControlEnv, ControlOperation, Registry } from '../registry.js'
import { NIL_CURSOR, readAgent, readLatestEventId, type AgentFacts } from './crm-reads.js'
import type { WebhooksRuntime } from './config.js'
import type { WebhookDeliveryRecord, WebhookSubscriptionRecord, WebhooksPort } from './port.js'
import { ROTATION_OVERLAP_MS, mintSecret } from './secrets.js'
import { validateWebhookUrl } from './urls.js'

// [[API7]] cycle 1 (D1, D2, D3, D5, D12, D13, D16, D18, D22, D23), moved onto the control plane by [[CORE337]] ([[CORE259]] D3, D5, D9 (c), D12): the seven hand-written subscription operations of `/meta/v1` are
// control operations run against the `WebhooksPort`. Ownership is the D1 predicate, applied in every read and write by the store: an agent sees and changes only its own subscriptions (the rest are 404), an
// owner (a user holding the scope) any. A write is ONE control batch with its `control_audit` row (P1) and emits no CRM event; the CRM facts it needs (the agent's eligibility and scopes, the newest event's id) are read
// before the control call. Without a port the operations answer `501 provider_not_configured` (P5).

/** [[API7]] D16: live subscriptions per agent. */
export const MAX_SUBSCRIPTIONS_PER_AGENT = 10
/** [[API7]] D18: the default `event_types`, stored resolved. */
export const DEFAULT_EVENT_TYPES = ['interaction.created'] as const
const EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const SCOPE_STRING = /^[a-z][a-z0-9_]*:(read|request_approval|write)$/

export const webhookRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  agent_id: z
    .uuid()
    .describe('The agent that owns the subscription: it receives only event types it could read itself.'),
  url: z.string().describe('Where events are POSTed: https, a public host.'),
  event_types: z.array(z.string()).describe('The exact event types delivered, for example task.created.'),
  status: z
    .enum(['active', 'paused', 'disabled'])
    .describe('paused by a caller; disabled by Vibase after sustained failure.'),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type WebhookRecord = z.infer<typeof webhookRecord>

const createBody = z.strictObject({
  url: z.string().describe('The target URL: https, a public host, at most 2048 characters.'),
  event_types: z
    .array(z.string().regex(EVENT_TYPE, 'an event type is <resource>.<action> in lower case, for example task.created'))
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Exact event types, 1 to 20. Omitted: ["interaction.created"]. Each must be a type the owning agent could read through the feed.',
    ),
  agent_id: z
    .uuid()
    .optional()
    .describe(
      'The agent that owns the subscription. An agent caller may omit it (it owns its own); a person must name one.',
    ),
})
const updateBody = z.strictObject({
  url: z.string().optional(),
  event_types: z
    .array(z.string().regex(EVENT_TYPE, 'an event type is <resource>.<action> in lower case, for example task.created'))
    .min(1)
    .max(20)
    .optional()
    .describe('Replaces the list; omitted leaves it as it is. Takes effect from the current position, with no rewind.'),
  status: z
    .enum(['active', 'paused'])
    .optional()
    .describe(
      'paused stops delivery and keeps the position; active resumes (and re-enables a subscription Vibase disabled).',
    ),
})
const idParams = z.object({ id: z.uuid() })
const listQuery = z.object({
  after: z
    .uuid()
    .optional()
    .describe("The id of the last subscription you have seen (the previous page's next_cursor)."),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  agent_id: z
    .uuid()
    .optional()
    .describe("Only this agent's subscriptions (an agent sees only its own whatever it asks)."),
})
/** [[API7]] D14: a delivery as `webhooks.deliveries` shows it: no lease columns, no organisation, no creator. */
export const deliveryRecord = z.object({
  id: z.uuid(),
  subscription_id: z.uuid(),
  event_id: z.uuid().describe('The event this delivery carries; it is the webhook-id header of the POST.'),
  event_type: z.string(),
  status: z
    .enum(['pending', 'delivered', 'dead', 'cancelled'])
    .describe(
      'pending: waiting or between attempts; delivered: a 2xx answered; dead: every attempt failed; cancelled: the subscription was deleted or its agent lost the read scope.',
    ),
  attempts: z.number().int(),
  next_attempt_at: z.string(),
  last_attempt_at: z.string().nullable(),
  last_status_code: z.number().int().nullable(),
  last_error: z
    .string()
    .nullable()
    .describe(
      'timeout, connection_failed, http_status, redirect, sender_failed, cancelled_subscription or cancelled_scope. A response body is never kept.',
    ),
  delivered_at: z.string().nullable(),
  created_at: z.string(),
})
const DELIVERY_COLUMNS = [
  'id',
  'subscription_id',
  'event_id',
  'event_type',
  'status',
  'attempts',
  'next_attempt_at',
  'last_attempt_at',
  'last_status_code',
  'last_error',
  'delivered_at',
  'created_at',
] as const
const deliveriesQuery = z.object({
  status: z.enum(['pending', 'delivered', 'dead', 'cancelled']).optional().describe('Only deliveries in this status.'),
  after: z.uuid().optional().describe("The id of the last delivery you have seen (the previous page's next_cursor)."),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const created = webhookRecord.extend({
  secret: z
    .string()
    .describe('The signing secret, whsec_ + base64. Shown only here and in rotate_secret: store it now.'),
})
const rotated = z.object({
  secret: z.string().describe('The new signing secret, shown only here.'),
  previous_valid_until: z
    .string()
    .describe(
      'The previous secret still signs deliveries until this time (24 hours); a receiver may accept both meanwhile.',
    ),
})

const notFound = () => new ApiError(404, 'not_found', 'webhook not found')
const invalidReference = () => new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
const notConfigured = () =>
  new ApiError(
    501,
    'webhooks_not_configured',
    'webhooks are not configured on this deployment: set CREDENTIALS_KEY (base64 of 32 bytes)',
  )
const noStore = () =>
  new ApiError(
    501,
    'provider_not_configured',
    'webhook subscriptions are held in the control plane; this deployment has none',
  )
const lower = (s: string) => s.toLowerCase()
const unique = (types: readonly string[]) => [...new Set(types)]

/**
 * D3: every type must name a resource type the registry's event-type map knows (`unknown_event_type`) and the agent must be able to see it through the feed (`event_type_not_readable`):
 * the agent's own read scopes and identity (D19's owner predicate), never the caller's. A type with no entry, or an `invisible` one, is not readable (`action_request.*` today).
 */
export function checkEventTypes(
  registry: Registry,
  agent: { id: string; scopes: readonly string[] },
  types: readonly string[],
): void {
  const map = registry.eventTypes()
  const resourceOf = (type: string) => type.slice(0, type.indexOf('.'))
  for (const type of types) {
    if (!map.has(resourceOf(type)))
      throw new ApiError(400, 'unknown_event_type', `unknown event type ${type}: no resource type ${resourceOf(type)}`)
  }
  const vis = feedVisibility(registry, {
    scopes: ScopeSet.parse(agent.scopes.filter((s) => SCOPE_STRING.test(s))),
    actor: { id: agent.id, kind: 'agent' },
  })
  const readable = new Set(vis.readable)
  for (const o of vis.owned ?? []) readable.add(o.resourceType)
  if (vis.edge && vis.edge.endpointTypes.length > 0) readable.add(vis.edge.resourceType)
  for (const type of types) {
    if (!readable.has(resourceOf(type)))
      throw new ApiError(
        400,
        'event_type_not_readable',
        `the agent cannot read ${type} events: it lacks the read scope of that resource, or the type is not available to subscriptions`,
      )
  }
}

function checkUrl(runtime: WebhooksRuntime | null, raw: string): void {
  const verdict = validateWebhookUrl(raw, { allowInsecure: runtime?.allowInsecureUrls ?? false })
  if (!verdict.ok) throw new ApiError(400, 'invalid_url', verdict.reason)
}

const recordOf = (r: WebhookSubscriptionRecord): z.infer<typeof webhookRecord> => ({
  id: r.id,
  organization_id: r.organizationId,
  agent_id: r.agentId,
  url: r.url,
  event_types: r.eventTypes,
  status: r.status,
  created_by: r.createdBy,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
})
const deliveryOf = (r: WebhookDeliveryRecord): z.infer<typeof deliveryRecord> =>
  deliveryRecord.parse({
    id: r.id,
    subscription_id: r.subscriptionId,
    event_id: r.eventId,
    event_type: r.eventType,
    status: r.status,
    attempts: r.attempts,
    next_attempt_at: r.nextAttemptAt,
    last_attempt_at: r.lastAttemptAt,
    last_status_code: r.lastStatusCode,
    last_error: r.lastError,
    delivered_at: r.deliveredAt,
    created_at: r.createdAt,
  })

/** D1: an agent caller's own id, folded into every store call; a user (the scope is the owner's) sees all. */
const ownerOf = (env: ControlEnv): { ownerAgentId?: string } =>
  env.actor.kind === 'agent' ? { ownerAgentId: env.actor.id } : {}

/**
 * A guarded write that reports `drifted` (the row moved between the caller's read and the write) is planned afresh and run once more; a second drift is `409 conflict`, as the storage unit's
 * `replanOnDrift` did ([[AGT8]] D28).
 */
async function replanned<T>(name: string, attempt: () => Promise<T | 'drifted'>): Promise<T> {
  for (let i = 0; i < 2; i++) {
    const out = await attempt()
    if (out !== 'drifted') return out
  }
  throw mapStorageError(new UnitDriftError(name))
}

// ---- reads ---------------------------------------------------------------------------------------------

async function listOperation(port: WebhooksPort, env: ControlEnv, q: z.infer<typeof listQuery>) {
  const limit = q.limit ?? 50
  const rows = await port.list({
    ...ownerOf(env),
    ...(q.agent_id !== undefined ? { agentId: lower(q.agent_id) } : {}),
    ...(q.after !== undefined ? { after: lower(q.after) } : {}),
    limit: limit + 1,
  })
  const page = rows.slice(0, limit).map(recordOf)
  return { data: page, next_cursor: rows.length > limit ? page[page.length - 1]!.id : null }
}

async function getOperation(port: WebhooksPort, env: ControlEnv, rawId: string) {
  const row = await port.get({ id: lower(rawId), ...ownerOf(env) })
  if (!row) throw notFound()
  return recordOf(row)
}

/** D14: a subscription's deliveries, oldest id first (the order the dispatcher inserted them), the subscription found by the same ownership and liveness as `webhooks.get`. */
async function deliveriesOperation(
  port: WebhooksPort,
  env: ControlEnv,
  rawId: string,
  q: z.infer<typeof deliveriesQuery>,
) {
  const limit = q.limit ?? 50
  const rows = await port.deliveries({
    subscriptionId: lower(rawId),
    ...ownerOf(env),
    ...(q.status !== undefined ? { status: q.status } : {}),
    ...(q.after !== undefined ? { after: lower(q.after) } : {}),
    limit: limit + 1,
  })
  if (rows === null) throw notFound()
  const data = rows.slice(0, limit).map(deliveryOf)
  return { data, next_cursor: rows.length > limit ? data[data.length - 1]!.id : null }
}

// ---- writes --------------------------------------------------------------------------------------------

async function createOperation(
  port: WebhooksPort,
  env: ControlEnv,
  runtime: WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> },
  registry: Registry,
  body: z.infer<typeof createBody>,
) {
  checkUrl(runtime, body.url)
  const minted = await mintSecret(env.randomBytes, runtime.key.bytes)
  const own = env.actor.kind === 'agent'
  if (own && body.agent_id !== undefined && lower(body.agent_id) !== env.actor.id) throw invalidReference()
  if (!own && body.agent_id === undefined)
    throw new ApiError(400, 'validation_error', 'agent_id is required: a subscription belongs to an agent')
  const agentId = own ? env.actor.id : lower(body.agent_id!)
  const types = unique(body.event_types ?? DEFAULT_EVENT_TYPES)
  const agent = await env.read(readAgent(env.organizationId, agentId))
  if (!agent || agent.disabledAt !== null) throw invalidReference()
  if (agent.delegatedBy !== null)
    throw new ApiError(
      400,
      'agent_not_eligible',
      'a delegated agent (an OAuth client acting for a person) cannot own a webhook subscription',
    )
  checkEventTypes(registry, { id: agentId, scopes: agent.scopes }, types)
  // D5: the position is the newest event now; nothing committed before creation is delivered, nothing after is lost.
  const cursorEventId = (await env.read(readLatestEventId())) ?? NIL_CURSOR
  const id = env.newId()
  const now = env.now.toISOString()
  const made = await port.create({
    id,
    secretId: env.newId(),
    auditId: env.newId(),
    organizationId: env.organizationId,
    actorId: env.actor.id,
    agentId,
    url: body.url,
    eventTypes: types,
    sealed: minted.sealed,
    keyVersion: runtime.key.version,
    cursorEventId,
    maxLivePerAgent: MAX_SUBSCRIPTIONS_PER_AGENT,
    now,
  })
  if (made === 'limit')
    throw new ApiError(409, 'webhook_limit', `an agent may have ${MAX_SUBSCRIPTIONS_PER_AGENT} webhook subscriptions`)
  return {
    id,
    organization_id: env.organizationId,
    agent_id: agentId,
    url: body.url,
    event_types: types,
    status: 'active' as const,
    created_by: env.actor.id,
    created_at: now,
    updated_at: now,
    secret: minted.secret,
  }
}

async function updateOperation(
  port: WebhooksPort,
  env: ControlEnv,
  registry: Registry,
  rawId: string,
  body: z.infer<typeof updateBody>,
) {
  const id = lower(rawId)
  const types = body.event_types === undefined ? undefined : unique(body.event_types)
  const empty = body.url === undefined && types === undefined && body.status === undefined
  return replanned('webhooks.update', async () => {
    const before = await port.get({ id, ...ownerOf(env) })
    if (!before) throw notFound()
    if (types !== undefined) {
      // The agent as the subscription's owner holds it now; one that is gone has no grants, so nothing is readable.
      const agent: AgentFacts | null = await env.read(readAgent(env.organizationId, before.agentId))
      checkEventTypes(registry, { id: agent?.id ?? '', scopes: agent?.scopes ?? [] }, types)
    }
    if (empty) return recordOf(before)
    const now = env.now.toISOString()
    const done = await port.update({
      id,
      auditId: env.newId(),
      actorId: env.actor.id,
      now,
      expectedUpdatedAt: before.updatedAt,
      ...ownerOf(env),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(types !== undefined ? { eventTypes: types } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    })
    if (done === 'not_found') throw notFound()
    if (done === 'drifted') return 'drifted' as const
    return recordOf({
      ...before,
      updatedAt: now,
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(types !== undefined ? { eventTypes: types } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    })
  })
}

async function deleteOperation(port: WebhooksPort, env: ControlEnv, rawId: string): Promise<void> {
  const id = lower(rawId)
  await replanned('webhooks.delete', async () => {
    const before = await port.get({ id, ...ownerOf(env) })
    if (!before) throw notFound()
    const done = await port.delete({
      id,
      auditId: env.newId(),
      actorId: env.actor.id,
      now: env.now.toISOString(),
      expectedUpdatedAt: before.updatedAt,
      ...ownerOf(env),
    })
    if (done === 'not_found') throw notFound()
    if (done === 'drifted') return 'drifted' as const
    return null
  })
}

async function rotateOperation(
  port: WebhooksPort,
  env: ControlEnv,
  runtime: WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> },
  rawId: string,
) {
  const minted = await mintSecret(env.randomBytes, runtime.key.bytes)
  const done = await port.rotateSecret({
    id: lower(rawId),
    secretId: env.newId(),
    auditId: env.newId(),
    actorId: env.actor.id,
    sealed: minted.sealed,
    keyVersion: runtime.key.version,
    now: env.now.toISOString(),
    ...ownerOf(env),
  })
  if (done === 'not_found') throw notFound()
  return {
    secret: minted.secret,
    previous_valid_until: new Date(env.now.getTime() + ROTATION_OVERLAP_MS).toISOString(),
  }
}

// ---- the operations ------------------------------------------------------------------------------------

/**
 * `webhooks.list`, `get`, `deliveries`, `create`, `update`, `delete` and `rotate_secret` ([[API7]] D14, D22): `/meta/v1`, scopes `webhooks:read` and `webhooks:write`, control operations ([[CORE337]]). The
 * registry carries them whatever the configuration (the CLI and MCP tool lists must not change per deployment); a deployment without a port answers `501 provider_not_configured`, and one without a usable
 * `CREDENTIALS_KEY` answers `501 webhooks_not_configured` on `create` and `rotate_secret` only (D12). `registry` is read at call time, for the feed's event-type map. They are never proposable: the
 * secret is shown once and the authority is administration.
 */
export function webhookOperations(runtime: WebhooksRuntime | null, registry: () => Registry): ControlOperation[] {
  const base = {
    kind: 'control' as const,
    surface: 'meta' as const,
    tags: ['webhooks'],
    validation: 'adapter' as const,
  }
  const readScope = { resource: 'webhooks', action: 'read' as const }
  const writeScope = { resource: 'webhooks', action: 'write' as const }
  const store = (): WebhooksPort => {
    if (!runtime?.port) throw noStore()
    return runtime.port
  }
  const keyed = (): WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> } => {
    store()
    if (!runtime?.key) throw notConfigured()
    return runtime as WebhooksRuntime & { key: NonNullable<WebhooksRuntime['key']> }
  }
  return [
    {
      ...base,
      name: 'webhooks.list',
      summary: 'List webhook subscriptions',
      description:
        "An agent sees its own subscriptions; an owner sees all. Never carries a secret. Page with after (the previous page's next_cursor).",
      method: 'get',
      path: '/webhooks',
      scope: readScope,
      request: { query: listQuery },
      response: { status: 200, schema: z.object({ data: z.array(webhookRecord), next_cursor: z.uuid().nullable() }) },
      run: (env, input) => listOperation(store(), env, input.query as z.infer<typeof listQuery>),
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
      run: (env, input) => getOperation(store(), env, String((input.params as { id: string }).id)),
    },
    {
      ...base,
      name: 'webhooks.deliveries',
      summary: "List a webhook subscription's deliveries",
      description:
        'One row per event the subscription was dispatched, oldest first: pending (waiting or between attempts), delivered, dead (every attempt failed) or cancelled, with the attempts made and the last failure (a code and an HTTP status, never a response body). ' +
        "Filter with status; page with after (the previous page's next_cursor). Answers why a hook did or did not fire. A subscription that belongs to another agent is 404 for an agent caller. Read only: there is no redelivery, recovery is the event feed.",
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      scope: readScope,
      request: { params: idParams, query: deliveriesQuery },
      response: { status: 200, schema: z.object({ data: z.array(deliveryRecord), next_cursor: z.uuid().nullable() }) },
      run: (env, input) =>
        deliveriesOperation(
          store(),
          env,
          String((input.params as { id: string }).id),
          input.query as z.infer<typeof deliveriesQuery>,
        ),
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
      request: { body: createBody },
      response: { status: 201, schema: created },
      run: (env, input) => {
        const config = keyed()
        return createOperation(store(), env, config, registry(), input.body as z.infer<typeof createBody>)
      },
    },
    {
      ...base,
      name: 'webhooks.update',
      summary: 'Change a webhook subscription: its URL, its event types, or pause and resume it',
      description:
        'Changes take effect at the next dispatch from the current position (nothing is replayed). status may be active or paused; Vibase itself sets disabled. Changed event types are checked like create.',
      method: 'patch',
      path: '/webhooks/{id}',
      scope: writeScope,
      request: { params: idParams, body: updateBody },
      response: { status: 200, schema: webhookRecord },
      run: async (env, input) => {
        const port = store()
        const body = input.body as z.infer<typeof updateBody>
        if (body.url !== undefined) checkUrl(runtime, body.url)
        return updateOperation(port, env, registry(), String((input.params as { id: string }).id), body)
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
      request: { params: idParams },
      response: { status: 204 },
      run: (env, input) => deleteOperation(store(), env, String((input.params as { id: string }).id)),
    },
    {
      ...base,
      name: 'webhooks.rotate_secret',
      summary: 'Rotate the signing secret of a webhook subscription',
      description:
        'Answers the new secret, shown only now. The previous secret keeps signing alongside it until previous_valid_until (24 hours), so a receiver can switch without dropping deliveries.',
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      scope: writeScope,
      request: { params: idParams },
      response: { status: 200, schema: rotated },
      run: (env, input) => {
        const config = keyed()
        return rotateOperation(store(), env, config, String((input.params as { id: string }).id))
      },
    },
  ]
}
