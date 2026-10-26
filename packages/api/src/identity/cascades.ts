import { sql, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  codecs,
  defineOperation,
  exactly,
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
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { beforeRead, columnsOf, receipt, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { physicalTable } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'

// The two delete cascades ([[CORE36]] C7): the `override.delete` of companies and contacts. Each is a plan (the
// parent with its stamp, the live children as one bounded set) and one unit of a CONSTANT number of statements:
// the stamp-guarded parent tombstone, its event, ONE set statement over ALL the parent's live children asserted to
// touch exactly the planned count (`exactly`, so on D1 a child added or removed between plan and commit aborts the unit), ONE set event
// statement, and the result proof. The set statement is gated on the parent's event existing, so a parent that
// drifted makes the whole unit a no-op (or, with children, an aborted batch).

interface Cascade {
  readonly parent: PreparedResource<any, any>
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
  const childTable = physicalTable(c.child)
  const childColumns = columnsOf(c.child)
  const parentKey = `cascade:${c.parent.name}`
  const childrenKey = `cascade:${c.child.name}`
  return defineOperation<void>({
    name: `${c.parent.name}.delete`,
    mutates: true,
    reads: (qc) => ({
      [parentKey]: beforeRead(c.parent, qc, env, id),
      [childrenKey]: readSet(
        selectRecord(c.child, qc, env)
          .where(sql<SqlBool>`${sql.ref(`${c.child.table}.${c.column}`)} = ${id}`)
          .orderBy(sql.ref(`${c.child.table}.id`)),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe(parentKey)
      if (!row) throw new ApiError(404, 'not_found', `${c.parent.eventName} not found`)
      const { __stamp, ...rest } = row as Record<string, unknown>
      const parentBefore = toRecord(c.parent, rest as Row)
      const children = found.all(childrenKey).map((r) => toRecord(c.child, r))
      const ids = children.map((x) => x.id as string)
      const childEvents = children.map((x) => ({ eventId: env.newId(), resourceId: x.id as string, before: x as Record<string, unknown> }))
      const eventType = c.kind === 'unlink' ? `${c.child.eventName}.updated` : `${c.child.eventName}.deleted`

      const tombstoneParent = qc.db
        .updateTable(c.parent.table)
        .set({ deleted_at: at, updated_at: at } as never)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.id`)} = ${id}`)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.organization_id`)} = ${env.organizationId}`)
        .where(sql<SqlBool>`${sql.ref(`${c.parent.table}.deleted_at`)} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, `${c.parent.table}.updated_at`)} = ${String(__stamp)}`)
      const childSet: Record<string, string | null> = c.kind === 'unlink' ? { [c.column]: null, updated_at: at } : { deleted_at: at, updated_at: at }
      const changeChildren = qc.db
        .updateTable(c.child.table)
        .set(childSet as never)
        .where(sql<SqlBool>`${sql.ref(`${c.child.table}.${c.column}`)} = ${id}`)
        .where(sql<SqlBool>`${sql.ref(`${c.child.table}.organization_id`)} = ${env.organizationId}`)
        .where(sql<SqlBool>`${sql.ref(`${c.child.table}.deleted_at`)} is null`)
        .where(eventExists(parentEventId))
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
        ...exactly(qc, step(changeChildren), ids.length),
        step(
          eventSetStatement(qc, {
            at,
            organizationId: env.organizationId,
            actorId: env.actor.id,
            type: eventType,
            resourceType: c.child.eventName,
            after: c.kind === 'unlink' ? { table: childTable, columns: childColumns } : null,
            rows: childEvents,
          }),
        ),
        step(proof, 'result'),
      ]
      const events: EventReceipt[] = [
        receipt(c.parent, parentEventId, 'deleted', id),
        ...childEvents.map((e) => ({ id: e.eventId, type: eventType, resourceType: c.child.eventName, resourceId: e.resourceId })),
      ]
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

/** `companies.delete`: soft-deletes the company and unlinks its live contacts (`company_id = null`), one `contact.updated` each, in id order. */
export function deleteCompanyOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: companies, child: contacts, column: 'company_id', kind: 'unlink' }, env, id)
}

/** `contacts.delete`: soft-deletes the contact and tombstones its live identities, one `identity.deleted` each, in id order. */
export function deleteContactOperation(env: PreparedEnv, id: string): PreparedOperation<void> {
  return cascadeDelete({ parent: contacts, child: identities, column: 'contact_id', kind: 'tombstone' }, env, id)
}

