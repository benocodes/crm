import { z } from 'zod'
import { defineOperation, unit, type PreparedOperation } from '@vault/storage'
import { endpointTypesOf } from '../associations/definition.js'
import { ApiError } from '../errors.js'
import { parseInput } from '../resources/define.js'
import type { Registry, TenantOperation } from '../registry.js'
import type { PreparedEnv } from '../storage/definition.js'
import { readFeedEvent, readStableFeed, type FeedEvent, type FeedVisibility } from './feed.js'

// [[API6]] D2, D4, D5, D6, D17: the event feed's two operations. Hand-written, tenant kind, D1 only. `events` is not a resource definition: no generic
// CRUD, sort or filter rollout applies. What a caller sees is decided by the registry's event-type map ([[API214]]).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const eventRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  type: z.string(),
  resource_type: z.string(),
  resource_id: z.uuid(),
  actor_id: z.uuid(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
})
const listQuery = z.object({
  after: z.string().optional().describe('The id of the last event you have seen (the previous page\'s next_cursor); omit to start from the oldest.'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  type: z.string().min(1).max(128).optional().describe('An exact event type, e.g. task.updated.'),
  resource_type: z.string().min(1).max(128).optional().describe('The type of the resource the event is about, e.g. task.'),
  resource_id: z.uuid().optional().describe('The id of the resource the event is about.'),
})

/**
 * What the principal may see, from its scopes and the registry's event-type map ([[API6]] D4). The principal matters only for a type with an `owner` predicate ([[API219]] D19): an
 * agent sees that type's events only for its own records, a user holding the scope sees all. Dispatch passes the subscription's agent with its stored scopes.
 */
export function feedVisibility(registry: Registry, env: Pick<PreparedEnv, 'scopes' | 'actor'>): FeedVisibility {
  const can = (resource: string) => env.scopes.has({ resource, action: 'read' })
  const readable: string[] = []
  const owned: NonNullable<FeedVisibility['owned']>[number][] = []
  let edge: FeedVisibility['edge']
  for (const [type, decl] of registry.eventTypes()) {
    if (!('scope' in decl) || !can(decl.scope)) continue
    if (decl.owner && env.actor.kind === 'agent') {
      owned.push({ resourceType: type, path: decl.owner.path, equals: env.actor.id })
      continue
    }
    if (decl.edge) {
      // The edge's own scope is held; each endpoint type must be readable too, checked on the stored edge record.
      edge = { resourceType: type, endpointTypes: [...endpointTypesOf(registry.resources()).values()].filter((t) => can(t.read.resource)).map((t) => t.type).sort() }
    } else readable.push(type)
  }
  return { readable: readable.sort(), ...(edge ? { edge } : {}), ...(owned.length > 0 ? { owned } : {}) }
}

const record = (organizationId: string, ev: FeedEvent) => ({
  id: ev.id,
  organization_id: organizationId,
  type: ev.type,
  resource_type: ev.resource_type,
  resource_id: ev.resource_id,
  actor_id: ev.actor_id,
  before: ev.before as Record<string, unknown> | null,
  after: ev.after as Record<string, unknown> | null,
  created_at: ev.created_at,
})

function listOperation(registry: Registry, env: PreparedEnv, rawQuery: Record<string, unknown>): PreparedOperation<unknown> {
  const q = parseInput(listQuery, rawQuery) as z.infer<typeof listQuery>
  const limit = q.limit ?? 50
  // D2: a non-UUID `after` can name no event; it is refused before any read, whatever the caller may see.
  if (q.after !== undefined && !UUID.test(q.after)) throw new ApiError(400, 'invalid_cursor', 'after is not the id of an event')
  const inner = readStableFeed({
    ...feedVisibility(registry, env),
    after: q.after?.toLowerCase() ?? null,
    limit,
    ...(q.type !== undefined ? { types: [q.type] } : {}),
    ...(q.resource_type !== undefined ? { resourceType: q.resource_type } : {}),
    ...(q.resource_id !== undefined ? { resourceId: q.resource_id.toLowerCase() } : {}),
  })
  return defineOperation({
    ...inner,
    name: 'events.list',
    build: (found, qc) => {
      const u = inner.build(found, qc)
      return unit({
        steps: u.steps,
        events: u.events,
        decode: (rows, f) => {
          const feed = u.decode(rows, f)
          if (feed.status === 'unknown_cursor') throw new ApiError(400, 'invalid_cursor', 'after is not the id of an event')
          const data = feed.events.map((ev) => record(env.organizationId, ev))
          return { data, next_cursor: feed.has_more ? data[data.length - 1]!.id : null }
        },
      })
    },
  })
}

function getOperation(registry: Registry, env: PreparedEnv, rawId: string): PreparedOperation<unknown> {
  const notFound = () => new ApiError(404, 'not_found', 'event not found')
  if (!UUID.test(rawId)) throw notFound()
  const inner = readFeedEvent({ ...feedVisibility(registry, env), id: rawId.toLowerCase() })
  return defineOperation({
    ...inner,
    build: (found, qc) => {
      const u = inner.build(found, qc)
      return unit({
        steps: u.steps,
        events: u.events,
        decode: (rows, f) => {
          const ev = u.decode(rows, f)
          if (ev === null) throw notFound()
          return record(env.organizationId, ev)
        },
      })
    },
  })
}

/** `events.list` and `events.get` ([[API6]] D2, D5, D6, D17): scope `events:read`, plus the per-type visibility of D4 inside the read. */
export function eventOperations(registry: () => Registry): TenantOperation[] {
  const base = { kind: 'tenant' as const, surface: 'api' as const, validation: 'handler' as const, tags: ['events'], d1Only: true, scope: { resource: 'events', action: 'read' as const } }
  return [
    {
      ...base,
      name: 'events.list',
      summary: "List the workspace's events in commit order",
      description:
        'The change feed: every write emits an event, served oldest first. Pass the previous page\'s next_cursor as after to continue; next_cursor is null when nothing more is stored. ' +
        'You see an event only if you could read its resource through that resource\'s own operations; hidden events are skipped, and a filter on a type you cannot read returns an empty page. An unknown after is 400 invalid_cursor.',
      method: 'get',
      path: '/events',
      request: { query: listQuery },
      response: { status: 200, schema: z.object({ data: z.array(eventRecord), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => listOperation(registry(), env, input.query),
    },
    {
      ...base,
      name: 'events.get',
      summary: 'Get one event',
      description: 'An event you may not read is 404, the same as an event that does not exist.',
      method: 'get',
      path: '/events/{id}',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: eventRecord },
      prepare: (env, input) => getOperation(registry(), env, String(input.params.id)),
    },
  ]
}
