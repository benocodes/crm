import { execute, type StorageBinding } from '@vibase/storage'
import { feedVisibility } from '../events/operations.js'
import { readStableFeed, type FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'
import type { BudgetView } from './budget.js'
import { NIL_CURSOR, agentScopeSet, readEligibleAgents } from './crm-reads.js'
import type { WebhooksPort } from './port.js'

// [[API7]] D4, D6, D17, D19, D20 ([[API219]]), moved onto the control plane by [[CORE337]] (D8): the dispatcher. For every eligible subscription it reads the agent's own view of the event feed after the subscription's cursor
// (`readStableFeed` on the CRM database, with `feedVisibility` computed from the agent's STORED scopes and identity), records one `pending` delivery row per event and moves the cursor in one control batch (the port).
// Nothing is sent here: the rows are the queue the sender (API220) works. A Node-safe module taking storage, the port, the registry, the clock and an id source; `compose.ts` wires it into the per-minute expression
// after the rail's sweeps. It writes machinery rows only, so it emits no event and no audit row (D20) and never touches `updated_at`. With no port it does nothing.

/** Events read per page, and pages per subscription per tick (D4): at most 500 rows a subscription a minute; the cursor is the backlog. */
export const PAGE_LIMIT = 100
export const MAX_PAGES = 5

export interface DispatchDeps {
  binding: StorageBinding
  /** The control-plane store; null: this composition has none and nothing is dispatched. */
  port: WebhooksPort | null
  registry: Registry
  clock: () => Date
  newId: () => string
  /** [[API7]] D24: asked before each unit; absent means unlimited (the dispatch suites). */
  budget?: BudgetView
}
/** A subscription that may be dispatched this tick, with the position it was read at and the grants of its agent as stored. */
export interface DispatchTarget {
  subscriptionId: string
  createdBy: string
  agentId: string
  eventTypes: string[]
  cursor: string
  scopes: string[]
}
/** What one read of a subscription's feed found, applied (or not) by `applyPage`. A plan carries the cursor it was read at: that is the compare-and-set value. */
export type PagePlan =
  | { kind: 'page'; target: DispatchTarget; events: FeedEvent[]; hasMore: boolean }
  | { kind: 'unknown_cursor'; target: DispatchTarget }
export interface DispatchSummary {
  /** Subscriptions that received at least one event this tick. */
  subscriptions: number
  /** Events recorded as deliveries this tick. */
  events: number
  /** Subscriptions skipped because their cursor names no event (logged by id, never restarted). */
  unknownCursor: number
  /** Subscriptions whose dispatch threw (the rest of the tick ran). */
  failed: number
  /** Subscriptions (D24) not served, or not served to the end of their backlog, because the budget could not cover another page: their cursors stay, the next tick serves them. */
  deferred: number
}

/** D24's pinned costs: the eligibility read is two queries (the CRM agents, then the control subscriptions); a page is its read and its write batch. */
export const ELIGIBLE_COST = 2
export const PAGE_COST = 2

const organizationOf = (d: DispatchDeps): string | null => (d.binding.kind === 'd1' ? d.binding.organizationId : null)

/**
 * D4: the subscriptions to dispatch: active and not deleted (the control read), the agent live and not delegated (D1) and holding `events:read` (D2), both read from the CRM by value (the agents named, the grants kept).
 * Visibility of the types themselves is judged per read, from the same stored scopes.
 */
export async function eligibleSubscriptions(d: DispatchDeps): Promise<DispatchTarget[]> {
  const organizationId = organizationOf(d)
  if (organizationId === null || d.port === null) return []
  const agents = (await execute(d.binding, { kind: 'internal', organizationId }, readEligibleAgents(organizationId)))
    .value
  const scopesOf = new Map(
    agents
      .filter((a) => agentScopeSet(d.registry, a.scopes).has({ resource: 'events', action: 'read' }))
      .map((a) => [a.id, a.scopes]),
  )
  const rows = await d.port.dispatchable({ organizationId, eligibleAgentIds: [...scopesOf.keys()] })
  return rows.map((r) => ({ ...r, scopes: scopesOf.get(r.agentId) ?? [] }))
}

/**
 * One page of the subscription's feed after `target.cursor`: what the agent could read through `events.list` (its stored scopes, D19's owner predicate with its own id), narrowed to the
 * subscription's exact types. An unknown cursor is a status, not an error (D4).
 */
export async function readPage(d: DispatchDeps, target: DispatchTarget): Promise<PagePlan> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return { kind: 'page', target, events: [], hasMore: false }
  const vis = feedVisibility(d.registry, {
    scopes: agentScopeSet(d.registry, target.scopes),
    actor: { id: target.agentId, kind: 'agent' },
  })
  const feed = (
    await execute(
      d.binding,
      { kind: 'internal', organizationId },
      readStableFeed({
        ...vis,
        types: target.eventTypes,
        after: target.cursor === NIL_CURSOR ? null : target.cursor,
        limit: PAGE_LIMIT,
      }),
    )
  ).value
  if (feed.status === 'unknown_cursor') return { kind: 'unknown_cursor', target }
  return { kind: 'page', target, events: feed.events, hasMore: feed.has_more }
}

/**
 * D4, invariant 3: ONE control batch per page (the port). It records the page's delivery rows `ON CONFLICT (subscription_id, event_id) DO NOTHING` and moves the cursor compare-and-set (to the page's last event, only
 * while the state still holds the cursor the page was read at). Overlapping ticks are harmless: the loser writes nothing (`moved` false). An empty page writes nothing.
 */
export async function applyPage(d: DispatchDeps, plan: PagePlan): Promise<{ moved: boolean }> {
  const organizationId = organizationOf(d)
  if (organizationId === null || d.port === null || plan.kind !== 'page' || plan.events.length === 0)
    return { moved: false }
  const { target, events } = plan
  return d.port.applyPage({
    organizationId,
    subscriptionId: target.subscriptionId,
    createdBy: target.createdBy,
    expectedCursor: target.cursor,
    events: events.map((e) => ({ id: d.newId(), eventId: e.id, eventType: e.type })),
    now: d.clock().toISOString(),
  })
}

/**
 * The dispatch half of the per-minute tick (D4, D6): every eligible subscription, up to `MAX_PAGES` pages each. A subscription that fails (a throw) or whose cursor is unknown does not
 * stop the others; it is retried by the next tick from the same cursor, and logged by id and error class (never a value).
 */
export async function dispatchWebhooks(d: DispatchDeps): Promise<DispatchSummary> {
  const out: DispatchSummary = { subscriptions: 0, events: 0, unknownCursor: 0, failed: 0, deferred: 0 }
  if (organizationOf(d) === null || d.port === null) return out
  const affords = (cost: number) => d.budget === undefined || d.budget.remaining() >= cost
  if (!affords(ELIGIBLE_COST)) return out
  const targets = await eligibleSubscriptions(d)
  for (const [index, target] of targets.entries()) {
    if (!affords(PAGE_COST)) {
      // Nothing is read or written for a subscription the budget cannot finish a page of: it keeps its cursor, and so do all after it (they cost the same).
      out.deferred += targets.length - index
      break
    }
    try {
      let at = target
      let received = false
      for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0 && !affords(PAGE_COST)) {
          out.deferred++
          break
        }
        const plan = await readPage(d, at)
        if (plan.kind === 'unknown_cursor') {
          out.unknownCursor++
          console.warn(
            `[webhooks] subscription ${target.subscriptionId}: its cursor names no event, skipped (never restarted)`,
          )
          break
        }
        if (plan.events.length === 0) break
        const { moved } = await applyPage(d, plan)
        if (moved) {
          out.events += plan.events.length
          received = true
        }
        if (!moved || !plan.hasMore) break
        at = { ...at, cursor: plan.events[plan.events.length - 1]!.id }
      }
      if (received) out.subscriptions++
    } catch (err) {
      out.failed++
      console.error(
        `[webhooks] dispatch for subscription ${target.subscriptionId} failed: ${err instanceof Error ? err.name : 'error'}`,
      )
    }
  }
  return out
}
