import { sql } from 'kysely'
import { defineOperation, readAll, unit, type PreparedOperation } from '@vault/storage'

// [[API105]] D22: the stable feed read. On D1 every committed event is in the stable prefix (one `batch()` per unit, `seq` assigned by SQLite inside the
// single writer, reads on the primary), so the only ordering predicate is `seq > (the cursor's seq)`. INTERNAL: no registered operation, route or job calls
// it until [[API214]] puts the visibility map on its required `readable` list. The organisation is implicit: one per D1 database ([[CORE35]] D18).

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

export interface StableFeedInput {
  /** Resource types the caller may read. Required: an empty list returns nothing (fail closed). */
  readable: readonly string[]
  /** Exact event types to keep (`task.updated`), narrowing `readable`. Omitted: every type of a readable resource. */
  types?: readonly string[]
  /** The id of the last event the caller has seen; null starts from the oldest. */
  after: string | null
  limit: number
}

const EMPTY: StableFeed = { status: 'ok', events: [], has_more: false }
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null))

export function readStableFeed(d: StableFeedInput): PreparedOperation<StableFeed> {
  if (!Number.isInteger(d.limit) || d.limit < 1) throw new RangeError('readStableFeed: limit must be a positive integer')
  return defineOperation<StableFeed>({
    name: 'events.feed',
    mutates: false,
    reads: (qc) => {
      if (d.readable.length === 0 || (d.types !== undefined && d.types.length === 0)) return {}
      const filters = [sql`resource_type in (${sql.join(d.readable)})`]
      if (d.types) filters.push(sql`type in (${sql.join(d.types)})`)
      if (d.after !== null) filters.push(sql`seq > (select seq from events where id = ${d.after})`)
      const page = sql`select id, created_at, type, resource_type, resource_id, actor_id, "before", "after" from events where ${sql.join(filters, sql` and `)} order by seq limit ${d.limit + 1}`
      const reads: Record<string, ReturnType<typeof readAll>> = { page: readAll(page.compile(qc.db)) }
      // The cursor check rides in the same read batch as the page: one snapshot, so a cursor that exists is never reported unknown.
      if (d.after !== null) reads.cursor = readAll(sql`select 1 as found from events where id = ${d.after}`.compile(qc.db))
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          if (d.readable.length === 0 || (d.types !== undefined && d.types.length === 0)) return EMPTY
          if (d.after !== null && found.all('cursor').length === 0) return { status: 'unknown_cursor' }
          const rows = found.all('page')
          return {
            status: 'ok',
            events: rows.slice(0, d.limit).map((r) => ({
              id: String(r.id),
              created_at: String(r.created_at),
              type: String(r.type),
              resource_type: String(r.resource_type),
              resource_id: String(r.resource_id),
              actor_id: String(r.actor_id),
              before: json(r.before),
              after: json(r.after),
            })),
            has_more: rows.length > d.limit,
          }
        },
      }),
  })
}
