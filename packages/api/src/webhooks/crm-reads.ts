import { sql } from 'kysely'
import { codecs, defineOperation, readAll, readMaybe, unit, type PreparedOperation } from '@vibase/storage'
import { toEvent, type FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'
import { ScopeSet } from '../scopes.js'

// [[CORE337]] P1, P3: the CRM facts the webhook code needs now that subscriptions live in the control plane. Read-only programs: they run before a control write (an agent's eligibility and scopes, the newest
// event's id) or beside a control read (agents and events by id). Nothing here writes, and no program reads a `webhook_*` table.

/** The dispatch position of a subscription created while the feed is empty: the nil UUID, "before the first event". The dispatcher reads from the start for it; it names no event, so it is never an unknown cursor. */
export const NIL_CURSOR = '00000000-0000-0000-0000-000000000000'

const SCOPE_STRING = /^[a-z][a-z0-9_]*:(read|request_approval|write)$/

/** Red-commit stub ([[API518]]): today's behaviour, unclosed. */
export const agentScopeSet = (_registry: Registry, stored: readonly string[]): ScopeSet =>
  ScopeSet.parse(stored.filter((s) => SCOPE_STRING.test(s)))

/** An agent as the webhook code judges it: live (not disabled, not delegated) and the grants it holds, filtered to well-formed scope strings. */
export interface AgentFacts {
  id: string
  disabledAt: string | null
  delegatedBy: string | null
  scopes: string[]
}
const agentOf = (r: Record<string, unknown>): AgentFacts => ({
  id: String(r.id),
  disabledAt: (r.disabled_at as string | null) ?? null,
  delegatedBy: (r.delegated_by as string | null) ?? null,
  scopes: codecs.stringArray.read(r.scopes).filter((s) => SCOPE_STRING.test(s)),
})
export const agentLive = (a: AgentFacts): boolean => a.disabledAt === null && a.delegatedBy === null

/** One agent of the organisation, or null. */
export function readAgent(organizationId: string, agentId: string): PreparedOperation<AgentFacts | null> {
  return defineOperation({
    name: 'webhooks.read_agent',
    mutates: false,
    reads: (qc) => ({
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .select(['agents.id', 'agents.scopes', 'agents.disabled_at', 'agents.delegated_by'])
          .where('agents.id', '=', agentId)
          .where('agents.organization_id', '=', organizationId),
      ),
    }),
    build: (found) =>
      unit({ steps: [], events: [], decode: () => (found.maybe('agent') ? agentOf(found.maybe('agent')!) : null) }),
  })
}

/** The id of the newest event, the dispatch position of a new subscription ([[API7]] D5); null when the feed is empty. */
export function readLatestEventId(): PreparedOperation<string | null> {
  return defineOperation({
    name: 'webhooks.read_latest_event',
    mutates: false,
    reads: (qc) => ({
      row: readMaybe(qc.db.selectFrom('events').select('events.id').orderBy('events.seq', 'desc').limit(1)),
    }),
    build: (found) =>
      unit({ steps: [], events: [], decode: () => (found.maybe('row')?.id as string | undefined) ?? null }),
  })
}

/** Every live, non-delegated agent of the organisation with its grants: the agents a subscription may be dispatched for (D1). */
export function readEligibleAgents(organizationId: string): PreparedOperation<AgentFacts[]> {
  return defineOperation({
    name: 'webhooks.read_eligible_agents',
    mutates: false,
    reads: (qc) => ({
      rows: readAll(
        sql`select id, scopes, disabled_at, delegated_by from agents where organization_id = ${organizationId} and disabled_at is null and delegated_by is null order by id`.compile(
          qc.db,
        ),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('rows').map(agentOf) }),
  })
}

/** The named agents and events, by id: the sender's reads of a claimed wave (the claim itself names ids only). An id with no row is absent from the map. */
export function readAgentsAndEvents(a: {
  organizationId: string
  agentIds: string[]
  eventIds: string[]
}): PreparedOperation<{ agents: Map<string, AgentFacts>; events: Map<string, FeedEvent> }> {
  return defineOperation({
    name: 'webhooks.read_agents_and_events',
    mutates: false,
    reads: (qc) => ({
      agents: readAll(
        sql`select id, scopes, disabled_at, delegated_by from agents where organization_id = ${a.organizationId} and id in (select value from json_each(${JSON.stringify(a.agentIds)}))`.compile(
          qc.db,
        ),
      ),
      events: readAll(
        sql`select id, created_at, type, resource_type, resource_id, actor_id, "before", "after" from events where id in (select value from json_each(${JSON.stringify(a.eventIds)}))`.compile(
          qc.db,
        ),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => ({
          agents: new Map(found.all('agents').map((r) => [String(r.id), agentOf(r)])),
          events: new Map(found.all('events').map((r) => [String(r.id), toEvent(r as never)])),
        }),
      }),
  })
}
