import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  assertStep,
  codecs,
  exactly,
  memberOf,
  readSet,
  recordColumns,
  step,
  ts,
  unit,
  type EventReceipt,
  type PhysicalTable,
  type PreparedOperation,
  type QueryContext,
  type Row,
  type Step,
  type StatementLabel,
} from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventSetStatement, eventStatement } from '../outbox.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { beforeRead, columnsOf, toRecord } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { physicalTable } from '../storage/definition.js'
import { operationOf } from './program.js'

export type ContactReference = {
  /** The prepared definition of the referencing table: its record is the event's `before`/`after`. */
  def: PreparedResource<any, any>
  table: PhysicalTable
  column: string
  /** true: only rows with deleted_at IS NULL move (soft-deletable tables); false: every row, deleted or not. */
  liveOnly: boolean
}

/** Every FK to contacts(id) except the exemptions. [[AGT8]] and [[CORE25]] append their entries here. */
export const CONTACT_REFERENCES: readonly ContactReference[] = [{ def: identities, table: 'identities', column: 'contact_id', liveOnly: true }]

/** FKs to contacts(id) that merge must NOT re-point: the tombstone pointer itself (D10). */
export const CONTACT_REFERENCE_EXEMPTIONS: readonly { table: string; column: string }[] = [{ table: 'contacts', column: 'merged_into_id' }]

/** The plan-read keys of a merge program (namespaced so it can share a unit with other programs). */
export const mergeReadKeys = { survivor: 'merge:survivor', source: 'merge:source', refs: (i: number) => `merge:refs:${i}` }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as never as Loose
const notFound = () => new ApiError(404, 'not_found', 'contact not found')
const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

/**
 * `contacts.merge` ([[CORE36]] C7, D8): moves the source's references to the survivor, fills the survivor's empty
 * fields, tombstones the source. Plan: both contacts and, per catalog entry, the source's referencing rows as a
 * bounded set. Unit: per entry ONE `exactly(n)` set update and ONE set event statement, the stamp-guarded fill and
 * tombstone, then an assertion (P7) that the survivor is still live, no catalog row still references the source and
 * the unit's own events exist (so on D1 anything that changed between plan and commit aborts the whole batch).
 */
export function mergeOperation(
  env: PreparedEnv,
  survivorIdIn: string,
  sourceIdIn: string,
  opts: { catalog?: readonly ContactReference[] } = {},
): PreparedOperation<ContactRecord> {
  // z.uuid() accepts upper case; compare and sort on the canonical lower-case form.
  const survivorId = survivorIdIn.toLowerCase()
  const sourceId = sourceIdIn.toLowerCase()
  if (sourceId === survivorId) throw new ApiError(400, 'merge_into_self', 'a contact cannot be merged into itself')
  if (!UUID.test(survivorId) || !UUID.test(sourceId)) throw notFound()
  const catalog = opts.catalog ?? CONTACT_REFERENCES
  const at = codecs.timestamp.write(env.now)
  return operationOf<ContactRecord>('contacts.merge', {
    reads: (qc) => ({
      [mergeReadKeys.survivor]: beforeRead(contacts, qc, env, survivorId),
      [mergeReadKeys.source]: beforeRead(contacts, qc, env, sourceId),
      ...Object.fromEntries(
        catalog.map((entry, i) => {
          let q = loose(qc)
            .selectFrom(entry.table)
            .select(recordColumns(qc, entry.table, columnsOf(entry.def)))
            .where(sql<SqlBool>`${sql.ref(`${entry.table}.${entry.column}`)} = ${sourceId}`)
            .where(sql<SqlBool>`${sql.ref(`${entry.table}.organization_id`)} = ${env.organizationId}`)
          if (entry.liveOnly) q = q.where(sql<SqlBool>`${sql.ref(`${entry.table}.deleted_at`)} is null`)
          return [mergeReadKeys.refs(i), readSet(q.orderBy(sql.ref(`${entry.table}.id`)))] as const
        }),
      ),
    }),
    build: (found, qc) => {
      const survivorRow = found.maybe(mergeReadKeys.survivor)
      const sourceRow = found.maybe(mergeReadKeys.source)
      if (!survivorRow || !sourceRow) throw notFound()
      const { __stamp: survivorStamp, ...survivorRest } = survivorRow as Record<string, unknown>
      const { __stamp: sourceStamp, ...sourceRest } = sourceRow as Record<string, unknown>
      const survivor = toRecord(contacts, survivorRest as Row)
      const source = toRecord(contacts, sourceRest as Row)

      // Labels mark the first statement of each stage of the unit, wherever it falls.
      const used = new Set<StatementLabel>()
      const label = (l: 'first-mutation' | 'first-event'): StatementLabel | undefined => (used.has(l) ? undefined : (used.add(l), l))
      const steps: Step[] = []
      const events: EventReceipt[] = []

      catalog.forEach((entry, i) => {
        const rows = found.all(mergeReadKeys.refs(i)).map((r) => toRecord(entry.def, r))
        const ids = rows.map((r) => r.id as string)
        let move = loose(qc)
          .updateTable(entry.table)
          .set({ [entry.column]: survivorId, updated_at: at })
          .where(sql<SqlBool>`${sql.ref(`${entry.table}.${entry.column}`)} = ${sourceId}`)
          .where(sql<SqlBool>`${sql.ref(`${entry.table}.organization_id`)} = ${env.organizationId}`)
          .where(memberOf(qc, entry.table, 'id' as never, ids))
        if (entry.liveOnly) move = move.where(sql<SqlBool>`${sql.ref(`${entry.table}.deleted_at`)} is null`)
        steps.push(...exactly(qc, step(move, label('first-mutation')), ids.length))
        const evs = rows.map((r) => ({ eventId: env.newId(), resourceId: r.id as string, before: r as Record<string, unknown> }))
        steps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: `${entry.def.eventName}.updated`,
              resourceType: entry.def.eventName,
              after: { table: physicalTable(entry.def), columns: columnsOf(entry.def) },
              rows: evs,
            }),
            label('first-event'),
          ),
        )
        events.push(...evs.map((e) => ({ id: e.eventId, type: `${entry.def.eventName}.updated`, resourceType: entry.def.eventName, resourceId: e.resourceId })))
      })

      // Fill the survivor's empty fields from the source; never overwrite.
      const fill: Record<string, unknown> = {}
      for (const f of Object.keys(contacts.update!.shape)) {
        const key = f as 'name' | 'company_id'
        if (survivor[key] === null && source[key] !== null) fill[f] = source[key]
      }
      const contactColumns = columnsOf(contacts)
      const guard = (id: string, stamp: unknown) => [
        sql<SqlBool>`${sql.ref('contacts.id')} = ${id}`,
        sql<SqlBool>`${sql.ref('contacts.organization_id')} = ${env.organizationId}`,
        sql<SqlBool>`${sql.ref('contacts.deleted_at')} is null`,
        sql<SqlBool>`${ts.exact(qc, 'contacts.updated_at')} = ${String(stamp)}`,
      ]
      let fillEventId: string | null = null
      if (Object.keys(fill).length > 0) {
        fillEventId = env.newId()
        let q = qc.db.updateTable('contacts').set({ ...fill, updated_at: at } as never)
        for (const g of guard(survivorId, survivorStamp)) q = q.where(g)
        steps.push(step(q, label('first-mutation'), { expect: 'affected' }))
        steps.push(
          step(
            eventStatement(qc, {
              id: fillEventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'contact.updated',
              resourceType: 'contact',
              resourceId: survivorId,
              before: survivor,
              after: { table: 'contacts', columns: contactColumns },
            }),
            label('first-event'),
          ),
        )
        events.push({ id: fillEventId, type: 'contact.updated', resourceType: 'contact', resourceId: survivorId })
      }

      // Tombstone the source.
      const mergedEventId = env.newId()
      let tomb = qc.db.updateTable('contacts').set({ deleted_at: at, updated_at: at, merged_into_id: survivorId } as never)
      for (const g of guard(sourceId, sourceStamp)) tomb = tomb.where(g)
      steps.push(step(tomb, label('first-mutation'), { expect: 'affected' }))
      steps.push(
        step(
          eventStatement(qc, {
            id: mergedEventId,
            at,
            organizationId: env.organizationId,
            actorId: env.actor.id,
            type: 'contact.merged',
            resourceType: 'contact',
            resourceId: sourceId,
            before: source,
            after: { table: 'contacts', columns: contactColumns },
          }),
          label('first-event'),
        ),
      )
      events.push({ id: mergedEventId, type: 'contact.merged', resourceType: 'contact', resourceId: sourceId })

      // P7: the commit-time assertion. D1 cannot see the plan's facts change; this aborts the whole batch if they did.
      const stillReferenced = catalog.map(
        (entry) =>
          sql<SqlBool>`not exists (select 1 from ${sql.table(entry.table)} where ${sql.ref(`${entry.table}.${entry.column}`)} = ${sourceId}${
            entry.liveOnly ? sql` and ${sql.ref(`${entry.table}.deleted_at`)} is null` : sql``
          })`,
      )
      const holds: Expression<SqlBool>[] = [
        sql<SqlBool>`exists (select 1 from "contacts" where "contacts"."id" = ${survivorId} and "contacts"."organization_id" = ${env.organizationId} and "contacts"."deleted_at" is null)`,
        ...stillReferenced,
        eventExists(mergedEventId),
        ...(fillEventId ? [eventExists(fillEventId)] : []),
      ]
      steps.push(assertStep(qc, sql<SqlBool>`${sql.join(holds, sql` and `)}`))
      steps.push(
        step(
          qc.db
            .selectFrom('contacts')
            .select(recordColumns(qc, 'contacts', contactColumns))
            .where(sql<SqlBool>`${sql.ref('contacts.id')} = ${survivorId}`)
            .where(sql<SqlBool>`${sql.ref('contacts.organization_id')} = ${env.organizationId}`)
            .where(eventExists(mergedEventId)),
          'result',
        ),
      )
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('contacts.merge')
          return toRecord(contacts, rows[0]!)
        },
      })
    },
  })
}

