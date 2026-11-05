import { sql, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  exactly,
  memberOf,
  readAll,
  readMaybe,
  readSet,
  step,
  ts,
  unit,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Found,
  type Row,
  type Step,
} from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventSetStatement, eventStatement } from '../outbox.js'
import { companies } from '../resources/companies.js'
import { companyFiles } from '../resources/company-files.js'
import { contactFiles } from '../resources/contact-files.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { notes } from '../resources/notes.js'
import { deals } from '../resources/deals.js'
import { pipelineStages } from '../resources/pipeline-stages.js'
import { pipelines } from '../resources/pipelines.js'
import { tags } from '../resources/tags.js'
import { tasks } from '../resources/tasks.js'
import { associations } from '../associations/definition.js'
import { afterOf, beforeRead, receipt, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { physicalTable } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'

// The two delete cascades ([[CORE36]] C7): the `override.delete` of companies and contacts. Each is a plan (the
// parent with its stamp, the live children as one bounded set) and one unit of a CONSTANT number of statements:
// the stamp-guarded parent tombstone, its event, ONE set statement over the PLANNED children (`id IN set`) asserted to
// touch exactly the planned count (`exactly`), an assertion that no live child of the parent remains (so on D1 a child
// added, removed or swapped between plan and commit aborts the unit, and no unplanned child changes without an event), ONE set event
// statement, and the result proof. The set statement is gated on the parent's event existing, so a parent that
// drifted makes the whole unit a no-op (or, with children, an aborted batch).

interface Cascade {
  readonly parent: PreparedResource<any, any>
  /** The dependants, handled in order (D35, P12): each keeps the three guards and gets its own set event. */
  readonly children: readonly CascadeChild[]
  /** [[CORE130]] D13: the delete is refused while live rows of another table point at the parent (planned, and asserted again at commit). */
  readonly hold?: CascadeHold
  /** [[CORE130]] D13: the children's events sort before the parent's (allocated first), as `pipeline_stage.deleted` each, then `pipeline.deleted`. */
  readonly childrenFirst?: boolean
}
interface CascadeHold {
  readonly child: PreparedResource<any, any>
  /** The child column pointing at the parent. */
  readonly column: string
  /** The `409` code of the refusal (`stage_in_use`, `pipeline_in_use`). */
  readonly code: string
  /** What the parent is called in the message ("stage", "pipeline"). */
  readonly what: string
}
const HOLD_IDS = 5
interface CascadeChild {
  readonly child: PreparedResource<any, any>
  /** The child column pointing at the parent. */
  readonly column: string
  /** What happens to the live children. */
  readonly kind: 'unlink' | 'tombstone'
}

/** A live edge of `(type, id)` on either side ([[CORE62]] D15); `type` is a registry table name, never input. */
export const touches = (type: string, id: string) =>
  sql<SqlBool>`((${sql.ref('associations.a_type')} = ${type} and ${sql.ref('associations.a_id')} = ${id}) or (${sql.ref('associations.b_type')} = ${type} and ${sql.ref('associations.b_id')} = ${id}))`
const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

function cascadeDelete(c: Cascade, env: PreparedEnv, rawId: string): PreparedOperation<void> {
  const id = canonicalId(c.parent, rawId)
  const at = codecs.timestamp.write(env.now)
  // The default allocates the parent's event id first (its goldens pin that order); `childrenFirst` allocates it in `build`, after the children's.
  let parentEventId = c.childrenFirst ? '' : env.newId()
  const parentKey = `cascade:${c.parent.name}`
  const childrenKey = (k: CascadeChild) => `cascade:${k.child.name}`
  const edgesKey = 'cascade:associations'
  return defineOperation<void>({
    name: `${c.parent.name}.delete`,
    mutates: true,
    reads: (qc) => ({
      [parentKey]: beforeRead(c.parent, qc, env, id),
      ...(c.hold ? holdReads(c.hold, qc, env, id) : {}),
      ...(c.parent.associable ? { [edgesKey]: readSet(selectRecord(associations, qc, env).where(touches(c.parent.table, id)).orderBy(sql.ref('associations.id'))) } : {}),
      ...Object.fromEntries(
        c.children.map((k) => [
          childrenKey(k),
          readSet(
            // No derived fields: these rows feed the children's events (CORE131 D2).
            selectRecord(k.child, qc, env, undefined, { derived: false })
              .where(sql<SqlBool>`${sql.ref(`${k.child.table}.${k.column}`)} = ${id}`)
              .orderBy(sql.ref(`${k.child.table}.id`)),
          ),
        ]),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe(parentKey)
      if (!row) throw new ApiError(404, 'not_found', `${c.parent.eventName} not found`)
      const { __stamp, ...rest } = row as Record<string, unknown>
      const parentBefore = toRecord(c.parent, rest as Row)
      if (c.hold) refuseHold(c.hold, found, parentBefore)
      // Event ids sort in allocation order, which is the feed order: children first means theirs are drawn before the parent's.
      const childIds = new Map<CascadeChild, string[]>()
      if (c.childrenFirst) {
        for (const k of c.children) childIds.set(k, found.all(childrenKey(k)).map(() => env.newId()))
        parentEventId = env.newId()
      }

      const tombstoneParent = qc.db
        .updateTable(c.parent.table)
        .set({ deleted_at: at, updated_at: at } as never)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.id`)} = ${id}`)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.organization_id`)} = ${env.organizationId}`)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.deleted_at`)} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, `${c.parent.table}.updated_at`)} = ${String(__stamp)}`)
      const proof = qc.db.selectNoFrom(sql<number>`1`.as('applied')).where(eventExists(parentEventId))

      const steps: Step[] = [
        step(tombstoneParent, 'first-mutation', { expect: 'affected' }),
        step(
          eventStatement(qc, {
            id: parentEventId,
            at,
            organizationId: env.organizationId,
            actorId: env.actor.id,
            type: `${c.parent.eventName}.deleted`,
            resourceType: c.parent.eventName,
            resourceId: id,
            before: parentBefore,
            after: null,
          }),
          'first-event',
        ),
      ]
      const events: EventReceipt[] = [receipt(c.parent, parentEventId, 'deleted', id)]
      // The commit-time half of the hold: a live row created against the parent since the plan read aborts the unit (nothing is deleted).
      if (c.hold) steps.push(assertStep(qc, noLiveRows(c.hold, id, env)))

      for (const k of c.children) {
        const children = found.all(childrenKey(k)).map((r) => toRecord(k.child, r))
        const ids = children.map((x) => x.id as string)
        const childEvents = children.map((x, i) => ({ eventId: childIds.get(k)?.[i] ?? env.newId(), resourceId: x.id as string, before: x as Record<string, unknown> }))
        const eventType = k.kind === 'unlink' ? `${k.child.eventName}.updated` : `${k.child.eventName}.deleted`
        const childSet: Record<string, string | null> = k.kind === 'unlink' ? { [k.column]: null, updated_at: at } : { deleted_at: at, updated_at: at }
        const changeChildren = qc.db
          .updateTable(k.child.table)
          .set(childSet as never)
          .where(sql<SqlBool>`${sql.ref(`${k.child.table}.${k.column}`)} = ${id}`)
          .where(sql<SqlBool>`${sql.ref(`${k.child.table}.organization_id`)} = ${env.organizationId}`)
          .where(sql<SqlBool>`${sql.ref(`${k.child.table}.deleted_at`)} is null`)
          .where(memberOf(qc, physicalTable(k.child), 'id', ids))
          .where(eventExists(parentEventId))
        steps.push(
          ...exactly(qc, step(changeChildren), ids.length),
          assertStep(
            qc,
            sql<SqlBool>`not exists (select 1 from ${sql.table(k.child.table)} where ${sql.ref(`${k.child.table}.${k.column}`)} = ${id} and ${sql.ref(`${k.child.table}.organization_id`)} = ${env.organizationId} and ${sql.ref(`${k.child.table}.deleted_at`)} is null)`,
          ),
          step(
            eventSetStatement(qc, {
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: eventType,
              resourceType: k.child.eventName,
              after: k.kind === 'unlink' ? afterOf(k.child) : null,
              rows: childEvents,
            }),
          ),
        )
        events.push(...childEvents.map((e) => ({ id: e.eventId, type: eventType, resourceType: k.child.eventName, resourceId: e.resourceId })))
      }
      if (c.parent.associable) {
        // [[CORE62]] D15: the parent's live edges, on either side, as one planned set with the same three guards.
        const edges = found.all(edgesKey).map((r) => toRecord(associations, r))
        const edgeIds = edges.map((x) => x.id as string)
        const edgeEvents = edges.map((x) => ({ eventId: env.newId(), resourceId: x.id as string, before: x as Record<string, unknown> }))
        const changeEdges = qc.db
          .updateTable('associations')
          .set({ deleted_at: at, updated_at: at } as never)
          .where(sql<SqlBool>`${sql.ref('associations.organization_id')} = ${env.organizationId}`)
          .where(sql<SqlBool>`${sql.ref('associations.deleted_at')} is null`)
          .where(touches(c.parent.table, id))
          .where(memberOf(qc, 'associations', 'id', edgeIds))
          .where(eventExists(parentEventId))
        steps.push(
          ...exactly(qc, step(changeEdges), edgeIds.length),
          assertStep(qc, sql<SqlBool>`not exists (select 1 from "associations" where "associations"."organization_id" = ${env.organizationId} and "associations"."deleted_at" is null and ${touches(c.parent.table, id)})`),
          step(eventSetStatement(qc, { at, organizationId: env.organizationId, actorId: env.actor.id, type: 'association.deleted', resourceType: 'association', after: null, rows: edgeEvents })),
        )
        events.push(...edgeEvents.map((e) => ({ id: e.eventId, type: 'association.deleted', resourceType: 'association', resourceId: e.resourceId })))
      }
      steps.push(step(proof, 'result'))
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`${c.parent.name}.delete`)
        },
      })
    },
  })
}

const holdRows = (h: CascadeHold, id: string, env: PreparedEnv) =>
  sql<SqlBool>`${sql.ref(`${h.child.table}.${h.column}`)} = ${id} and ${sql.ref(`${h.child.table}.organization_id`)} = ${env.organizationId} and ${sql.ref(`${h.child.table}.deleted_at`)} is null`
/** The ONE predicate of a hold ([[CORE130]] D13), used by the plan reads and the commit assertion alike. */
const noLiveRows = (h: CascadeHold, id: string, env: PreparedEnv) => sql<SqlBool>`not exists (select 1 from ${sql.table(h.child.table)} where ${holdRows(h, id, env)})`

/** The plan reads of a hold: how many live rows point at the parent, and the first few ids. */
function holdReads(h: CascadeHold, qc: QueryContext, env: PreparedEnv, id: string) {
  return {
    'hold:count': readMaybe(qc.db.selectNoFrom(sql<number>`(select count(*) from ${sql.table(h.child.table)} where ${holdRows(h, id, env)})`.as('n'))),
    'hold:ids': readAll(
      selectRecord(h.child, qc, env, undefined, { derived: false })
        .where(sql<SqlBool>`${sql.ref(`${h.child.table}.${h.column}`)} = ${id}`)
        .orderBy(sql.ref(`${h.child.table}.id`))
        .limit(HOLD_IDS),
    ),
  }
}
function refuseHold(h: CascadeHold, found: Found, parent: { name?: unknown }): void {
  const count = Number(found.maybe('hold:count')?.n ?? 0)
  if (count === 0) return
  const ids = found.all('hold:ids').map((r) => String(r.id))
  const more = count > ids.length ? `, and ${count - ids.length} more` : ''
  throw new ApiError(409, h.code, `${h.what} "${String(parent.name)}" holds ${count} live ${count === 1 ? h.child.eventName : `${h.child.eventName}s`} (${ids.join(', ')}${more}); move or delete them first`)
}

/** `companies.delete`: soft-deletes the company, unlinks its live contacts (`company_id = null`, one `contact.updated` each) then soft-deletes its file links (`company_file.deleted`), each in id order. */
export function deleteCompanyOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: companies, children: [{ child: contacts, column: 'company_id', kind: 'unlink' }, { child: companyFiles, column: 'company_id', kind: 'tombstone' }] }, env, id)
}

/** `contacts.delete`: soft-deletes the contact, tombstones its live identities (`identity.deleted`) then its file links (`contact_file.deleted`), each in id order. */
export function deleteContactOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: contacts, children: [{ child: identities, column: 'contact_id', kind: 'tombstone' }, { child: contactFiles, column: 'contact_id', kind: 'tombstone' }] }, env, id)
}


/** `tasks.delete`: soft-deletes the task and its live edges (`association.deleted` each, in id order). */
export function deleteTaskOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: tasks, children: [] }, env, id)
}

/** `deals.delete`: soft-deletes the deal and its live edges (`association.deleted` each, in id order). The parent is read without derived fields, so `status` never reaches `deal.deleted` ([[CORE130]] D8). */
export function deleteDealOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: deals, children: [] }, env, id)
}

/** `notes.delete`: soft-deletes the note and its live edges (`association.deleted` each, in id order). */
export function deleteNoteOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: notes, children: [] }, env, id)
}

/** `tags.delete`: soft-deletes the tag and its live edges (`association.deleted` each, in id order); members are untouched ([[CORE129]] D11). */
export function deleteTagOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: tags, children: [] }, env, id)
}

/** `pipeline_stages.delete`: refused `409 stage_in_use` while a live deal is in the stage, else soft-deletes it ([[CORE130]] D13). */
export function deleteStageOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: pipelineStages, children: [], hold: { child: deals, column: 'stage_id', code: 'stage_in_use', what: 'stage' } }, env, id)
}

/** `pipelines.delete`: refused `409 pipeline_in_use` while a live deal is in the pipeline, else soft-deletes its live stages (`pipeline_stage.deleted` each) then the pipeline ([[CORE130]] D13). */
export function deletePipelineOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete(
    { parent: pipelines, children: [{ child: pipelineStages, column: 'pipeline_id', kind: 'tombstone' }], hold: { child: deals, column: 'pipeline_id', code: 'pipeline_in_use', what: 'pipeline' }, childrenFirst: true },
    env,
    id,
  )
}
