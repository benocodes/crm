import { sql, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  exactly,
  memberOf,
  readSet,
  step,
  ts,
  unit,
  type EventReceipt,
  type PreparedOperation,
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
}
interface CascadeChild {
  readonly child: PreparedResource<any, any>
  /** The child column pointing at the parent. */
  readonly column: string
  /** What happens to the live children. */
  readonly kind: 'unlink' | 'tombstone'
}

const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

function cascadeDelete(c: Cascade, env: PreparedEnv, rawId: string): PreparedOperation<void> {
  const id = canonicalId(c.parent, rawId)
  const at = codecs.timestamp.write(env.now)
  const parentEventId = env.newId()
  const parentKey = `cascade:${c.parent.name}`
  const childrenKey = (k: CascadeChild) => `cascade:${k.child.name}`
  return defineOperation<void>({
    name: `${c.parent.name}.delete`,
    mutates: true,
    reads: (qc) => ({
      [parentKey]: beforeRead(c.parent, qc, env, id),
      ...Object.fromEntries(
        c.children.map((k) => [
          childrenKey(k),
          readSet(
            selectRecord(k.child, qc, env)
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

      for (const k of c.children) {
        const children = found.all(childrenKey(k)).map((r) => toRecord(k.child, r))
        const ids = children.map((x) => x.id as string)
        const childEvents = children.map((x) => ({ eventId: env.newId(), resourceId: x.id as string, before: x as Record<string, unknown> }))
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

/** `companies.delete`: soft-deletes the company, unlinks its live contacts (`company_id = null`, one `contact.updated` each) then soft-deletes its file links (`company_file.deleted`), each in id order. */
export function deleteCompanyOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: companies, children: [{ child: contacts, column: 'company_id', kind: 'unlink' }, { child: companyFiles, column: 'company_id', kind: 'tombstone' }] }, env, id)
}

/** `contacts.delete`: soft-deletes the contact, tombstones its live identities (`identity.deleted`) then its file links (`contact_file.deleted`), each in id order. */
export function deleteContactOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: contacts, children: [{ child: identities, column: 'contact_id', kind: 'tombstone' }, { child: contactFiles, column: 'contact_id', kind: 'tombstone' }] }, env, id)
}

