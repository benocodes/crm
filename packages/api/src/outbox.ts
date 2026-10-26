import { sql, type Kysely, type RawBuilder, type SqlBool, type Transaction } from 'kysely'
import { appliedPrev, bind, jsonRows, recordJson, type PhysicalTable, type QueryContext, type QueryLike } from '@vault/storage'
import type { Database } from '@vault/db'

export type EventInput = {
  organizationId: string
  actorId: string
  /** '<eventName>.<action>', e.g. 'task.created'. */
  type: string
  /** The definition's eventName, e.g. 'task'. */
  resourceType: string
  resourceId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

const json = (value: Record<string, unknown> | null): string | null => (value === null ? null : JSON.stringify(value))

/**
 * Appends one `events` row on the transaction it is given, so the event commits or rolls back with the
 * write. The only code that inserts into `events` (AGENTS.md invariant 5); callers use `ctx.emit`.
 */
export async function writeEvent(trx: Transaction<Database>, event: EventInput): Promise<{ id: string }> {
  return trx
    .insertInto('events')
    .values({
      organization_id: event.organizationId,
      actor_id: event.actorId,
      type: event.type,
      resource_type: event.resourceType,
      resource_id: event.resourceId,
      before: json(event.before),
      after: json(event.after),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

// ---- prepared units ([[CORE35]]) ----------------------------------------------------------------------

/**
 * The typed event statement a prepared unit composes (AGENTS.md invariant 5: the only other code that
 * inserts into `events`). It is an INSERT...SELECT gated on the previous statement having applied, so an
 * event exists exactly when its mutation did. `after` is rendered from the STORED row, never recomputed;
 * `before` is the record the plan phase read.
 */
export function eventStatement(
  qc: QueryContext,
  e: {
    id: string
    at: string
    organizationId: string
    actorId: string
    type: string
    resourceType: string
    resourceId: string
    before: Record<string, unknown> | null
    /** The table and public columns to render `after` from, or null when the resource is gone (delete). */
    after: { table: PhysicalTable; columns: readonly string[] } | null
  },
): QueryLike {
  // The one dynamic-table INSERT...SELECT: reviewed boundary, covered by the atomicity and parity suites.
  const L = qc.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const values = (afterJson: RawBuilder<string>) => [
    bind(qc, 'uuid', e.id).as('id'),
    bind(qc, 'timestamp', e.at).as('created_at'),
    bind(qc, 'uuid', e.organizationId).as('organization_id'),
    bind(qc, 'text', e.type).as('type'),
    bind(qc, 'text', e.resourceType).as('resource_type'),
    bind(qc, 'uuid', e.resourceId).as('resource_id'),
    bind(qc, 'uuid', e.actorId).as('actor_id'),
    bind(qc, 'json', e.before === null ? null : JSON.stringify(e.before)).as('before'),
    afterJson.as('after'),
  ]
  const select = e.after
    ? L.selectFrom(e.after.table)
        .select(values(recordJson(qc, e.after.table, e.after.columns)))
        .where(sql<SqlBool>`${sql.ref(`${e.after.table}.id`)} = ${e.resourceId}`)
        .where(appliedPrev(qc))
    : L.selectNoFrom(values(bind(qc, 'json', null))).where(appliedPrev(qc))
  return L.insertInto('events')
    .columns(['id', 'created_at', 'organization_id', 'type', 'resource_type', 'resource_id', 'actor_id', 'before', 'after'])
    .expression(select)
}

/**
 * The set form of the event statement ([[CORE36]] D5): ONE INSERT...SELECT for a whole set, so a cascade costs a
 * constant number of statements. The event ids and the plan's `before` records travel in ONE `jsonRows` parameter;
 * `after` is rendered from the STORED rows joined by id (null for deletes, which join nothing); rows are inserted in
 * `ord` order. Not gated on `appliedPrev`: on D1 an assertion step resets `changes()`, so the caller's `exactly(n)`
 * (which aborts the unit unless exactly these rows changed) is what guarantees the set exists.
 */
export function eventSetStatement(
  qc: QueryContext,
  e: {
    at: string
    organizationId: string
    actorId: string
    type: string
    resourceType: string
    after: { table: PhysicalTable; columns: readonly string[] } | null
    rows: readonly { eventId: string; resourceId: string; before: Record<string, unknown> | null }[]
  },
): QueryLike {
  // A labelled escape hatch: dynamic-table INSERT...SELECT from a one-parameter set (reviewed with eventStatement).
  const set = jsonRows(
    qc,
    'r',
    { event_id: 'uuid', resource_id: 'uuid', before: 'json' },
    e.rows.map((r) => ({ event_id: r.eventId, resource_id: r.resourceId, before: r.before })),
  )
  const after = e.after ? recordJson(qc, e.after.table, e.after.columns) : bind(qc, 'json', null)
  const join = e.after ? sql`join ${sql.table(e.after.table)} on ${sql.ref(`${e.after.table}.id`)} = ${sql.ref('r.resource_id')}` : sql``
  return sql`
    insert into "events" ("id", "created_at", "organization_id", "type", "resource_type", "resource_id", "actor_id", "before", "after")
    select ${sql.ref('r.event_id')}, ${bind(qc, 'timestamp', e.at)}, ${bind(qc, 'uuid', e.organizationId)}, ${bind(qc, 'text', e.type)},
      ${bind(qc, 'text', e.resourceType)}, ${sql.ref('r.resource_id')}, ${bind(qc, 'uuid', e.actorId)}, ${sql.ref('r.before')}, ${after}
    from ${set} ${join}
    order by ${sql.ref('r.ord')}`.compile(qc.db)
}
