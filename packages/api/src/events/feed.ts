import { sql } from 'kysely'
import { defineOperation, readAll, unit, type PreparedOperation } from '@vibase/storage'

// [[API105]] D22: the stable feed read. On D1 every committed event is in the stable prefix (one `batch()` per unit, `seq` assigned by SQLite inside the
// single writer, reads on the primary), so the only ordering predicate is `seq > (the cursor's seq)`. INTERNAL: no registered operation, route or job calls
// it but `events.list`, `events.get` ([[API214]]) and, later, [[API7]]'s dispatcher. The organisation is implicit: one per D1 database ([[CORE35]] D18).

/** One event as the feed reads it. `seq` is deliberately absent (D2): the event id is the only cursor a caller ever sees. */
export interface FeedEvent {
  id: string
  created_at: string
  type: string
  resource_type: string
  resource_id: string
  actor_id: string
  before: unknown
  after: unknown
}

/**
 * `unknown_cursor`: `after` named no event (never a page from the start). `ok`: up to `limit` events in `seq` order; `has_more` says another page
 * follows, and the next call passes the last event's id as `after`.
 */
export type StableFeed = { status: 'unknown_cursor' } | { status: 'ok'; events: FeedEvent[]; has_more: boolean }

/** What a caller may see ([[API6]] D4): events of `readable` resource types, plus the edge type's events whose record has both endpoint types in `endpointTypes`. */
export interface FeedVisibility {
  /** Resource types the caller may read. Required: with no `edge` either, nothing is visible (fail closed). */
  readable: readonly string[]
  /**
   * An edge resource type ([[CORE62]] D11): its events are visible only when the edge record (`after`, or `before` for a delete) names a readable endpoint
   * type on both sides. An absent or unknown endpoint type is not in the list, so the event is hidden. An empty list shows no edge events.
   */
  edge?: { resourceType: string; endpointTypes: readonly string[] }
  /**
   * Per-type record predicates ([[API219]] D19): an event of `resourceType` is visible only when the record (`after`, or `before` for a delete) holds `equals` at the JSON `path`.
   * Every entry is its own alternative, so a type listed here and in `readable` is visible through `readable` (a scope-wide reader sees all of it). The general shape #217's
   * action-event predicates will use too.
   */
  owned?: readonly { resourceType: string; path: string; equals: string }[]
}

export interface StableFeedInput extends FeedVisibility {
  /** Exact event types to keep (`task.updated`), narrowing what is visible. Omitted: every type. */
  types?: readonly string[]
  /** Narrows to one resource type / one resource id (equality), within what is visible. */
  resourceType?: string
  resourceId?: string
  /** The id of the last event the caller has seen; null starts from the oldest. */
  after: string | null
  limit: number
}

const EMPTY: StableFeed = { status: 'ok', events: [], has_more: false }
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null))
const COLUMNS = sql`id, created_at, type, resource_type, resource_id, actor_id, "before", "after"`

/** The visibility predicate, or null when nothing at all is visible. */
export function visible(d: FeedVisibility) {
  const parts = []
  if (d.readable.length > 0) parts.push(sql`resource_type in (${sql.join(d.readable)})`)
  if (d.edge && d.edge.endpointTypes.length > 0) {
    const rec = sql`coalesce("after", "before")`
    parts.push(
      sql`(resource_type = ${d.edge.resourceType} and json_extract(${rec}, '$.a_type') in (${sql.join(d.edge.endpointTypes)}) and json_extract(${rec}, '$.b_type') in (${sql.join(d.edge.endpointTypes)}))`,
    )
  }
  for (const o of d.owned ?? []) parts.push(sql`(resource_type = ${o.resourceType} and json_extract(coalesce("after", "before"), ${o.path}) = ${o.equals})`)
  return parts.length > 0 ? sql`(${sql.join(parts, sql` or `)})` : null
}

export const toEvent = (r: Record<string, unknown>): FeedEvent => ({
  id: String(r.id),
  created_at: String(r.created_at),
  type: String(r.type),
  resource_type: String(r.resource_type),
  resource_id: String(r.resource_id),
  actor_id: String(r.actor_id),
  before: json(r.before),
  after: json(r.after),
})

export function readStableFeed(d: StableFeedInput): PreparedOperation<StableFeed> {
  if (!Number.isInteger(d.limit) || d.limit < 1) throw new RangeError('readStableFeed: limit must be a positive integer')
  const nothing = visible(d) === null || (d.types !== undefined && d.types.length === 0)
  return defineOperation<StableFeed>({
    name: 'events.feed',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, ReturnType<typeof readAll>> = {}
      const seen = visible(d)
      if (seen !== null && !nothing) {
        const filters = [seen]
        if (d.types) filters.push(sql`type in (${sql.join(d.types)})`)
        if (d.resourceType !== undefined) filters.push(sql`resource_type = ${d.resourceType}`)
        if (d.resourceId !== undefined) filters.push(sql`resource_id = ${d.resourceId}`)
        if (d.after !== null) filters.push(sql`seq > (select seq from events where id = ${d.after})`)
        reads.page = readAll(sql`select ${COLUMNS} from events where ${sql.join(filters, sql` and `)} order by seq limit ${d.limit + 1}`.compile(qc.db))
      }
      // The cursor check rides in the same read batch as the page: one snapshot, so a cursor that exists is never reported unknown. It ignores visibility (D2).
      if (d.after !== null) reads.cursor = readAll(sql`select 1 as found from events where id = ${d.after}`.compile(qc.db))
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          if (d.after !== null && found.all('cursor').length === 0) return { status: 'unknown_cursor' }
          if (nothing) return EMPTY
          const rows = found.all('page')
          return { status: 'ok', events: rows.slice(0, d.limit).map(toEvent), has_more: rows.length > d.limit }
        },
      }),
  })
}

/** One event by id if the caller may see it, else null: an unreadable event is indistinguishable from an absent one ([[API6]] D4, `events.get`). */
export function readFeedEvent(d: FeedVisibility & { id: string }): PreparedOperation<FeedEvent | null> {
  return defineOperation<FeedEvent | null>({
    name: 'events.get',
    mutates: false,
    reads: (qc) => {
      const seen = visible(d)
      const reads: Record<string, ReturnType<typeof readAll>> = {}
      if (seen !== null) reads.event = readAll(sql`select ${COLUMNS} from events where id = ${d.id} and ${seen}`.compile(qc.db))
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          if (visible(d) === null) return null
          const row = found.all('event')[0]
          return row ? toEvent(row) : null
        },
      }),
  })
}
