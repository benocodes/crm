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
import { contactFiles } from '../resources/contact-files.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { afterOf, beforeRead, columnsOf, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { associations } from '../associations/definition.js'
import { operationOf } from './program.js'
import { touches } from './cascades.js'

export type ContactReference = {
  /** The prepared definition of the referencing table: its record is the event's `before`/`after`. */
  def: PreparedResource<any, any>
  table: PhysicalTable
  column: string
  /** true: only rows with deleted_at IS NULL move (soft-deletable tables); false: every row, deleted or not. */
  liveOnly: boolean
  /**
   * Columns that, with `column`, are unique among LIVE rows ([[CORE25]] D35): the source's rows whose values equal a live
   * survivor row's would collide with the unique index once re-pointed, so they are soft-deleted instead (a
   * `<event>.deleted` set), and only the rest move.
   */
  uniqueWith?: readonly string[]
}

/** Every FK to contacts(id) except the exemptions. [[AGT8]] appends its entries here. */
export const CONTACT_REFERENCES: readonly ContactReference[] = [
  { def: identities, table: 'identities', column: 'contact_id', liveOnly: true },
  { def: contactFiles, table: 'contact_files', column: 'contact_id', liveOnly: true, uniqueWith: ['file_id'] },
]

/**
 * Every FK onto identities(id) ([[CORE25]] D35). Merge moves identities to the survivor but never changes their ids, so
 * these rows need no re-point action; `identity-catalog.integration.test.ts` compares the list to the foreign keys on both
 * engines, so a new FK onto identities is a conscious decision (a later identity merge starts from this list).
 */
export const IDENTITY_REFERENCES: readonly { table: string; column: string }[] = [{ table: 'interaction_participants', column: 'identity_id' }]

/**
 * References to contacts that are NOT foreign keys ([[CORE62]] D16): an association endpoint is a table name plus an id, so the
 * FK scan cannot see it. `mergeOperation` re-points these itself (soft-deleting self-associations and duplicates); the
 * catalog guard finds every `<x>_type`/`<x>_id` pair on D1 and requires it here or in the exemptions.
 */
export const CONTACT_NON_FK_REFERENCES: readonly { table: string; columns: readonly { id: string; type: string }[] }[] = [
  { table: 'associations', columns: [{ id: 'a_id', type: 'a_type' }, { id: 'b_id', type: 'b_type' }] },
]
/** Polymorphic ids that merge must not touch: the audit log names records as they were. */
export const CONTACT_NON_FK_EXEMPTIONS: readonly { table: string; column: string }[] = [{ table: 'events', column: 'resource_id' }]

/** FKs to contacts(id) that merge must NOT re-point: the tombstone pointer itself (D10). */
export const CONTACT_REFERENCE_EXEMPTIONS: readonly { table: string; column: string }[] = [{ table: 'contacts', column: 'merged_into_id' }]

/** The plan-read keys of a merge program (namespaced so it can share a unit with other programs). */
export const mergeReadKeys = { survivor: 'merge:survivor', source: 'merge:source', refs: (i: number) => `merge:refs:${i}`, dups: (i: number) => `merge:dups:${i}`, edges: 'merge:edges' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as never as Loose
const notFound = () => new ApiError(404, 'not_found', 'contact not found')
// [[CORE62]] D16: the edge's other end, and the canonical pair after the source is replaced by the survivor, computed in SQL from the old row.
const isSource = (src: string) => sql`(${sql.ref('associations.a_type')} = 'contacts' and ${sql.ref('associations.a_id')} = ${src})`
const otherType = (src: string) => sql`(case when ${isSource(src)} then ${sql.ref('associations.b_type')} else ${sql.ref('associations.a_type')} end)`
const otherId = (src: string) => sql`(case when ${isSource(src)} then ${sql.ref('associations.b_id')} else ${sql.ref('associations.a_id')} end)`
const otherFirst = (src: string, survivor: string) => sql`(${otherType(src)} < 'contacts' or (${otherType(src)} = 'contacts' and ${otherId(src)} < ${survivor}))`
function newSide(src: string, survivor: string, column: 'a_type' | 'a_id' | 'b_type' | 'b_id') {
  const first = otherFirst(src, survivor)
  const [own, other] = column.endsWith('type') ? [sql`'contacts'`, otherType(src)] : [sql`${survivor}`, otherId(src)]
  return column.startsWith('a') ? sql`(case when ${first} then ${other} else ${own} end)` : sql`(case when ${first} then ${own} else ${other} end)`
}
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
      [mergeReadKeys.edges]: readSet(
        selectRecord(associations, qc, env)
          .select([
            sql<number>`case when ${otherType(sourceId)} = 'contacts' and ${otherId(sourceId)} = ${survivorId} then 1 else 0 end`.as('__self'),
            sql<number>`exists (select 1 from "associations" as "s" where "s"."organization_id" = ${env.organizationId} and "s"."deleted_at" is null and "s"."relation" = "associations"."relation" and "s"."a_type" = ${newSide(sourceId, survivorId, 'a_type')} and "s"."a_id" = ${newSide(sourceId, survivorId, 'a_id')} and "s"."b_type" = ${newSide(sourceId, survivorId, 'b_type')} and "s"."b_id" = ${newSide(sourceId, survivorId, 'b_id')})`.as('__dup'),
          ])
          .where(touches('contacts', sourceId))
          .orderBy(sql.ref('associations.id')),
      ),
      ...Object.fromEntries(
        catalog.flatMap((entry, i) => {
          const referencing = (holder: string) => {
            let q = loose(qc)
              .selectFrom(entry.table)
              .select(recordColumns(qc, entry.table, columnsOf(entry.def)))
              .where(sql<SqlBool>`${sql.ref(`${entry.table}.${entry.column}`)} = ${holder}`)
              .where(sql<SqlBool>`${sql.ref(`${entry.table}.organization_id`)} = ${env.organizationId}`)
            if (entry.liveOnly) q = q.where(sql<SqlBool>`${sql.ref(`${entry.table}.deleted_at`)} is null`)
            return readSet(q.orderBy(sql.ref(`${entry.table}.id`)))
          }
          // A `uniqueWith` entry also reads the SURVIVOR's live rows, to find the source rows that would collide.
          return [[mergeReadKeys.refs(i), referencing(sourceId)] as const, ...(entry.uniqueWith ? [[mergeReadKeys.dups(i), referencing(survivorId)] as const] : [])]
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
        let duplicates: typeof rows = []
        let moving = rows
        if (entry.uniqueWith) {
          const unique = entry.uniqueWith
          const keyOf = (r: Record<string, unknown>) => JSON.stringify(unique.map((c) => r[c]))
          const taken = new Set(found.all(mergeReadKeys.dups(i)).map((r) => keyOf(toRecord(entry.def, r) as Record<string, unknown>)))
          duplicates = rows.filter((r) => taken.has(keyOf(r as Record<string, unknown>)))
          moving = rows.filter((r) => !taken.has(keyOf(r as Record<string, unknown>)))
        }
        const eventType = (action: string) => `${entry.def.eventName}.${action}`
        const where = (ids: readonly string[]) => {
          let q = loose(qc)
            .updateTable(entry.table)
            .where(sql<SqlBool>`${sql.ref(`${entry.table}.${entry.column}`)} = ${sourceId}`)
            .where(sql<SqlBool>`${sql.ref(`${entry.table}.organization_id`)} = ${env.organizationId}`)
            .where(memberOf(qc, entry.table, 'id' as never, ids))
          if (entry.liveOnly) q = q.where(sql<SqlBool>`${sql.ref(`${entry.table}.deleted_at`)} is null`)
          return q
        }
        const eventsFor = (set: typeof rows) => set.map((r) => ({ eventId: env.newId(), resourceId: r.id as string, before: r as Record<string, unknown> }))
        const receipts = (evs: ReturnType<typeof eventsFor>, type: string): EventReceipt[] =>
          evs.map((e) => ({ id: e.eventId, type, resourceType: entry.def.eventName, resourceId: e.resourceId }))

        if (entry.uniqueWith) {
          // Always emitted, even for an empty set: the unit's statement count does not depend on the data (D5).
          const dupIds = duplicates.map((r) => r.id as string)
          steps.push(...exactly(qc, step(where(dupIds).set({ deleted_at: at, updated_at: at }), label('first-mutation')), dupIds.length))
          const evs = eventsFor(duplicates)
          steps.push(
            step(
              eventSetStatement(qc, { at, organizationId: env.organizationId, actorId: env.actor.id, type: eventType('deleted'), resourceType: entry.def.eventName, after: null, rows: evs }),
              label('first-event'),
            ),
          )
          events.push(...receipts(evs, eventType('deleted')))
        }

        const ids = moving.map((r) => r.id as string)
        steps.push(...exactly(qc, step(where(ids).set({ [entry.column]: survivorId, updated_at: at }), label('first-mutation')), ids.length))
        const evs = eventsFor(moving)
        steps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: eventType('updated'),
              resourceType: entry.def.eventName,
              after: afterOf(entry.def),
              rows: evs,
            }),
            label('first-event'),
          ),
        )
        events.push(...receipts(evs, eventType('updated')))
      })

      // Associations: the source's live edges. A self-association or a duplicate of a live survivor edge is soft-deleted; the rest move.
      {
        const edges = found.all(mergeReadKeys.edges).map((r) => {
          const { __self, __dup, ...rest } = r as Record<string, unknown>
          return { rec: toRecord(associations, rest as Row), drop: Number(__self) === 1 || Number(__dup) === 1 }
        })
        const base = (ids: readonly string[]) =>
          qc.db
            .updateTable('associations')
            .where(sql<SqlBool>`${sql.ref('associations.organization_id')} = ${env.organizationId}`)
            .where(sql<SqlBool>`${sql.ref('associations.deleted_at')} is null`)
            .where(touches('contacts', sourceId))
            .where(memberOf(qc, 'associations', 'id', ids))
        const evs = (set: typeof edges) => set.map((x) => ({ eventId: env.newId(), resourceId: x.rec.id as string, before: x.rec as Record<string, unknown> }))
        const rec = (set: ReturnType<typeof evs>, type: string): EventReceipt[] => set.map((x) => ({ id: x.eventId, type, resourceType: 'association', resourceId: x.resourceId }))
        const dropped = edges.filter((x) => x.drop)
        const moving = edges.filter((x) => !x.drop)
        const dropIds = dropped.map((x) => x.rec.id as string)
        steps.push(...exactly(qc, step(base(dropIds).set({ deleted_at: at, updated_at: at } as never), label('first-mutation')), dropIds.length))
        const dropEvents = evs(dropped)
        steps.push(step(eventSetStatement(qc, { at, organizationId: env.organizationId, actorId: env.actor.id, type: 'association.deleted', resourceType: 'association', after: null, rows: dropEvents }), label('first-event')))
        events.push(...rec(dropEvents, 'association.deleted'))
        const moveIds = moving.map((x) => x.rec.id as string)
        steps.push(
          ...exactly(
            qc,
            step(
              base(moveIds).set({
                a_type: newSide(sourceId, survivorId, 'a_type'),
                a_id: newSide(sourceId, survivorId, 'a_id'),
                b_type: newSide(sourceId, survivorId, 'b_type'),
                b_id: newSide(sourceId, survivorId, 'b_id'),
                updated_at: at,
              } as never),
              label('first-mutation'),
            ),
            moveIds.length,
          ),
        )
        const moveEvents = evs(moving)
        steps.push(step(eventSetStatement(qc, { at, organizationId: env.organizationId, actorId: env.actor.id, type: 'association.updated', resourceType: 'association', after: afterOf(associations), rows: moveEvents }), label('first-event')))
        events.push(...rec(moveEvents, 'association.updated'))
      }

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
        sql<SqlBool>`not exists (select 1 from "associations" where "associations"."organization_id" = ${env.organizationId} and "associations"."deleted_at" is null and ${touches('contacts', sourceId)})`,
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

