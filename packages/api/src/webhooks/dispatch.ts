import { sql } from 'kysely'
import { appliedPrev, codecs, defineOperation, execute, readAll, step, unit, type PreparedOperation, type StorageBinding } from '@vault/storage'
import { feedVisibility } from '../events/operations.js'
import { readStableFeed, type FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'
import { ScopeSet } from '../scopes.js'

// [[API7]] D4, D6, D17, D19, D20 ([[API219]]): the dispatcher. For every eligible subscription it reads the agent's own view of the event feed after the subscription's cursor
// (`readStableFeed`, with `feedVisibility` computed from the agent's STORED scopes and identity), inserts one `pending` delivery row per event and moves the cursor in one `batch()`.
// Nothing is sent here: the rows are the queue the sender (API220) works. A Node-safe module taking storage, the registry, the clock and an id source; `compose.ts` wires it into the
// per-minute expression after the rail's sweeps. It writes machinery rows only, so it emits no event (D20) and never touches `updated_at`.

/** Events read per page, and pages per subscription per tick (D4): at most 500 rows a subscription a minute; the cursor is the backlog. */
export const PAGE_LIMIT = 100
export const MAX_PAGES = 5

const SCOPE_STRING = /^[a-z][a-z0-9_]*:(read|request_approval|write)$/

export interface DispatchDeps {
  binding: StorageBinding
  registry: Registry
  clock: () => Date
  newId: () => string
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
export type PagePlan = { kind: 'page'; target: DispatchTarget; events: FeedEvent[]; hasMore: boolean } | { kind: 'unknown_cursor'; target: DispatchTarget }
export interface DispatchSummary {
  /** Subscriptions that received at least one event this tick. */
  subscriptions: number
  /** Events recorded as deliveries this tick. */
  events: number
  /** Subscriptions skipped because their cursor names no event (logged by id, never restarted). */
  unknownCursor: number
  /** Subscriptions whose dispatch threw (the rest of the tick ran). */
  failed: number
}

const organizationOf = (d: DispatchDeps): string | null => (d.binding.kind === 'd1' ? d.binding.organizationId : null)
const ts = (d: DispatchDeps) => codecs.timestamp.write(d.clock())

/**
 * D4: the subscriptions to dispatch: active and not deleted, the agent live and not delegated (D1) and holding `events:read` (D2). Visibility of the types themselves is judged
 * per read, from the same stored scopes.
 */
export async function eligibleSubscriptions(d: DispatchDeps): Promise<DispatchTarget[]> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return []
  const read: PreparedOperation<DispatchTarget[]> = defineOperation({
    name: 'webhooks.dispatch_targets',
    mutates: false,
    reads: (qc) => ({
      rows: readAll(
        sql`select s.id as id, s.created_by as created_by, s.agent_id as agent_id, s.event_types as event_types, st.cursor_event_id as cursor_event_id, a.scopes as scopes
          from webhook_subscriptions s
          join webhook_dispatch_state st on st.subscription_id = s.id and st.organization_id = s.organization_id
          join agents a on a.id = s.agent_id and a.organization_id = s.organization_id
          where s.organization_id = ${organizationId} and s.status = 'active' and s.deleted_at is null and a.disabled_at is null and a.delegated_by is null
          order by s.id`.compile(qc.db),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () =>
          found
            .all('rows')
            .map((r) => ({
              subscriptionId: String(r.id),
              createdBy: String(r.created_by),
              agentId: String(r.agent_id),
              eventTypes: codecs.stringArray.read(r.event_types),
              cursor: String(r.cursor_event_id),
              scopes: codecs.stringArray.read(r.scopes).filter((s) => SCOPE_STRING.test(s)),
            }))
            .filter((t) => ScopeSet.parse(t.scopes).has({ resource: 'events', action: 'read' })),
      }),
  })
  return (await execute(d.binding, { kind: 'internal', organizationId }, read)).value
}

/**
 * One page of the subscription's feed after `target.cursor`: what the agent could read through `events.list` (its stored scopes, D19's owner predicate with its own id), narrowed to the
 * subscription's exact types. An unknown cursor is a status, not an error (D4).
 */
export async function readPage(d: DispatchDeps, target: DispatchTarget): Promise<PagePlan> {
  const organizationId = organizationOf(d)
  if (organizationId === null) return { kind: 'page', target, events: [], hasMore: false }
  const vis = feedVisibility(d.registry, { scopes: ScopeSet.parse(target.scopes), actor: { id: target.agentId, kind: 'agent' } })
  const feed = (await execute(d.binding, { kind: 'internal', organizationId }, readStableFeed({ ...vis, types: target.eventTypes, after: target.cursor, limit: PAGE_LIMIT }))).value
  if (feed.status === 'unknown_cursor') return { kind: 'unknown_cursor', target }
  return { kind: 'page', target, events: feed.events, hasMore: feed.has_more }
}

/**
 * D4, invariant 3: ONE unit per page. It inserts the page's delivery rows `ON CONFLICT (subscription_id, event_id) DO NOTHING` and moves the cursor compare-and-set (`WHERE cursor_event_id =
 * the cursor the page was read at`). Overlapping ticks are harmless: the loser's inserts are duplicates and its cursor update matches no row, which does NOT fail a `batch()`, so the
 * result step reports whether the update changed a row (`moved`). `last_dispatched_at` is stamped with the cursor, so an empty read writes nothing.
 */
export async function applyPage(d: DispatchDeps, plan: PagePlan): Promise<{ moved: boolean }> {
  const organizationId = organizationOf(d)
  if (organizationId === null || plan.kind !== 'page' || plan.events.length === 0) return { moved: false }
  const { target, events } = plan
  const at = ts(d)
  const last = events[events.length - 1]!.id
  // One JSON parameter carries the page (D1 allows 100 bound parameters a statement, a page is 100 events of 3 fields each).
  const page = JSON.stringify(events.map((e) => ({ id: d.newId(), event_id: e.id, event_type: e.type })))
  const program: PreparedOperation<boolean> = defineOperation({
    name: 'webhooks.dispatch_page',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(
            sql`insert into "webhook_deliveries" ("id", "created_at", "organization_id", "created_by", "subscription_id", "event_id", "event_type", "status", "attempts", "next_attempt_at")
              select json_extract(value, '$.id'), ${at}, ${organizationId}, ${target.createdBy}, ${target.subscriptionId}, json_extract(value, '$.event_id'), json_extract(value, '$.event_type'), 'pending', 0, ${at}
              from json_each(${page}) where true
              on conflict ("subscription_id", "event_id") do nothing`.compile(qc.db),
            'first-mutation',
          ),
          step(
            sql`update "webhook_dispatch_state" set "cursor_event_id" = ${last}, "last_dispatched_at" = ${at}
              where "subscription_id" = ${target.subscriptionId} and "organization_id" = ${organizationId} and "cursor_event_id" = ${target.cursor}`.compile(qc.db),
          ),
          step(qc.db.selectNoFrom(sql<number>`1`.as('moved')).where(appliedPrev(qc)), 'result'),
        ],
        events: [],
        decode: (rows) => rows.length > 0,
      }),
  })
  return { moved: (await execute(d.binding, { kind: 'internal', organizationId }, program)).value }
}

/**
 * The dispatch half of the per-minute tick (D4, D6): every eligible subscription, up to `MAX_PAGES` pages each. A subscription that fails (a throw) or whose cursor is unknown does not
 * stop the others; it is retried by the next tick from the same cursor, and logged by id and error class (never a value).
 */
export async function dispatchWebhooks(d: DispatchDeps): Promise<DispatchSummary> {
  const out: DispatchSummary = { subscriptions: 0, events: 0, unknownCursor: 0, failed: 0 }
  if (organizationOf(d) === null) return out
  for (const target of await eligibleSubscriptions(d)) {
    try {
      let at = target
      let received = false
      for (let page = 0; page < MAX_PAGES; page++) {
        const plan = await readPage(d, at)
        if (plan.kind === 'unknown_cursor') {
          out.unknownCursor++
          console.warn(`[webhooks] subscription ${target.subscriptionId}: its cursor names no event, skipped (never restarted)`)
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
      console.error(`[webhooks] dispatch for subscription ${target.subscriptionId} failed: ${err instanceof Error ? err.name : 'error'}`)
    }
  }
  return out
}
