import { sql, type Kysely, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  bind,
  boundIds,
  codecs,
  exactly,
  jsonRows,
  memberOf,
  readMaybe,
  readSet,
  recordColumns,
  step,
  ts,
  unit,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Read,
  type Row,
  type Step,
  type Unit,
} from '@vibase/storage'
import { ApiError } from '../errors.js'
import { eventSetStatement, eventStatement } from '../outbox.js'
import { contacts as defaultContacts, type ContactRecord } from '../resources/contacts.js'
import { identities, type IdentityRecord } from '../resources/identities.js'
import { columnsOf, selectRecord, toRecord } from '../storage/crud.js'
import { columnKindsOf, type PreparedEnv } from '../storage/definition.js'
import { normalizeIdentityValue, type IdentityKind } from './normalize.js'
import { operationOf, type Program } from './program.js'

/**
 * `mayCreateContact` ([[CORE408]] D2, 408.16): whether this entry may give its address a contact (create one for an
 * unknown address, or promote an unattached identity). Absent means true, so every caller that passes nothing behaves
 * as before; capture's policy ([[CORE417]]) is the first to pass false. An address with several entries may if any entry may.
 */
export type ResolveEntry = { kind: IdentityKind; value: string; name?: string; mayCreateContact?: boolean }
export type ResolveResult = { identity: IdentityRecord; contact: ContactRecord | null; created: boolean }
export type EnsureOwnResult = { identity: IdentityRecord; outcome: 'created' | 'moved' | 'unchanged' }

type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as never as Loose
const KNOWN = 'resolve:known'
const OWN = 'own:existing'
const C = 'c_'

/** Display names arrive from channels: trim, treat blank as absent, cap at the contact name limit. */
export function cleanName(name: string | undefined): string | undefined {
  const t = name?.trim().slice(0, 500).trim()
  return t ? t : undefined
}

const identityColumns = columnsOf(identities)
const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

/** An identity row with its contact (columns prefixed `c_`; all null when the identity has no contact). */
function splitRow(contacts: ContactsDefinition, row: Row): { identity: IdentityRecord; contact: ContactRecord | null } {
  const contact: Record<string, unknown> = {}
  for (const c of columnsOf(contacts)) contact[c] = row[`${C}${c}`]
  return {
    identity: toRecord(identities, row),
    contact: contact.id === null || contact.id === undefined ? null : toRecord(contacts, contact as Row),
  }
}
const joinedColumns = (qc: QueryContext, contacts: ContactsDefinition) => [
  ...recordColumns(qc, 'identities', identityColumns),
  ...recordColumns(qc, 'contacts', columnsOf(contacts), C, columnKindsOf(contacts)),
]
/** The contacts definition the program renders its records and events from: the composed one of an `extend` ([[CORE559]] P2), by default the one with none. */
export type ContactsDefinition = typeof defaultContacts

/**
 * `identities.resolve` as a plan/build pair ([[CORE36]] C6, D15). Every entry is normalised first (errors carry the
 * `identities[i]: ` prefix); one plan read finds the live identities of the batch's addresses with their contacts; the
 * unit then creates ONE contact and ONE identity per distinct new address in first-occurrence order, as a constant
 * number of set statements (D5); an entry may say it may not give its address a contact ([[CORE408]]): the address then
 * becomes an unattached identity, and a known unattached identity is promoted to a new contact when an entry may. The response is in input order; `created` is true only on the first occurrence of
 * a new address; an existing contact is never renamed. Zero orphans because the unit is atomic (P4), not because of a lock.
 */
export function resolveProgram(
  env: PreparedEnv,
  entries: readonly ResolveEntry[],
  contacts: ContactsDefinition = defaultContacts,
): Program<ResolveResult[]> {
  const contactColumns = columnsOf(contacts)
  const normalized = entries.map((e, i) => {
    try {
      return { ...e, value: normalizeIdentityValue(e.kind, e.value) }
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(err.status, err.code, `identities[${i}]: ${err.message}`)
      throw err
    }
  })
  const at = codecs.timestamp.write(env.now)
  const key = (e: { kind: string; value: string }) => `${e.kind}:${e.value}`
  return {
    reads(qc): Readonly<Record<string, Read>> {
      if (normalized.length === 0) return {}
      boundIds(
        qc,
        normalized.map((e) => e.value),
      )
      const values = [...new Set(normalized.map((e) => e.value))]
      const known = sql`
        select ${sql.join(joinedColumns(qc, contacts))} from "identities"
        left join "contacts" on "contacts"."id" = "identities"."contact_id" and "contacts"."organization_id" = "identities"."organization_id"
        where "identities"."organization_id" = ${env.organizationId} and "identities"."deleted_at" is null and ${memberOf(qc, 'identities', 'value', values)}`.compile(
        qc.db,
      )
      return { [KNOWN]: readSet(known) }
    },
    build(found, qc): Unit<ResolveResult[]> {
      if (normalized.length === 0) return unit({ steps: [], events: [], decode: () => [] })
      const known = new Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>()
      for (const row of found.all(KNOWN)) {
        const r = splitRow(contacts, row)
        known.set(key(r.identity), r)
      }
      // One decision per distinct address (408.15): it may have a contact if any entry may; the contact takes the name of
      // the first entry that may (for a call that passes no choice, the first occurrence, as always).
      const wanted = new Map<string, { kind: IdentityKind; value: string; may: boolean; name: string | null }>()
      for (const e of normalized) {
        const k = key(e)
        const may = e.mayCreateContact !== false
        const w = wanted.get(k)
        if (!w) wanted.set(k, { kind: e.kind, value: e.value, may, name: may ? (cleanName(e.name) ?? null) : null })
        else if (may && !w.may) {
          w.may = true
          w.name = cleanName(e.name) ?? null
        }
      }
      // New addresses, in first-occurrence order; each gets a contact only when it may (else an unattached identity).
      const fresh: Array<{
        kind: IdentityKind
        value: string
        name: string | null
        contactId: string | null
        identityId: string
        contactEvent: string
        identityEvent: string
      }> = []
      // Known, live, unattached identities that may now have a contact (D6): promoted in place.
      const promoted: Array<{
        key: string
        before: IdentityRecord
        name: string | null
        contactId: string
        contactEvent: string
        identityEvent: string
      }> = []
      for (const [k, w] of wanted) {
        const hit = known.get(k)
        if (!hit) {
          fresh.push({
            kind: w.kind,
            value: w.value,
            name: w.may ? w.name : null,
            contactId: w.may ? env.newId() : null,
            identityId: env.newId(),
            contactEvent: '',
            identityEvent: '',
          })
        } else if (w.may && !hit.identity.own && hit.identity.contact_id === null) {
          promoted.push({
            key: k,
            before: hit.identity,
            name: w.name,
            contactId: env.newId(),
            contactEvent: '',
            identityEvent: '',
          })
        }
      }
      for (const f of fresh) if (f.contactId) f.contactEvent = env.newId()
      for (const p of promoted) p.contactEvent = env.newId()
      for (const f of fresh) f.identityEvent = env.newId()
      for (const p of promoted) p.identityEvent = env.newId()
      const withContact = fresh.filter((f) => f.contactId !== null)
      const promotedKeys = new Set(promoted.map((p) => p.key))

      const finish = (
        created: Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>,
      ): ResolveResult[] => {
        const first = new Set<string>()
        return normalized.map((e) => {
          const k = key(e)
          const hit = known.get(k)
          if (hit && !promotedKeys.has(k)) return { identity: hit.identity, contact: hit.contact, created: false }
          const made = created.get(k)
          if (!made) throw new UnitDriftError('identities.resolve')
          if (hit) return { identity: made.identity, contact: made.contact, created: false }
          const isFirst = !first.has(k)
          first.add(k)
          return { identity: made.identity, contact: made.contact, created: isFirst }
        })
      }
      if (fresh.length === 0 && promoted.length === 0)
        return unit({ steps: [], events: [], decode: () => finish(new Map()) })

      const actor = env.actor.id
      const org = env.organizationId
      const contactRows = [
        ...withContact.map((f) => ({ id: f.contactId, name: f.name })),
        ...promoted.map((p) => ({ id: p.contactId, name: p.name })),
      ]
      const touched = [...fresh.map((f) => f.identityId), ...promoted.map((p) => p.before.id)]
      const resultSet = jsonRows(
        qc,
        'r',
        { id: 'uuid' },
        touched.map((id) => ({ id })),
      )
      const steps: Step[] = []
      if (contactRows.length > 0) {
        const contactSet = jsonRows(qc, 'r', { id: 'uuid', name: 'text' }, contactRows)
        steps.push(
          step(
            sql`insert into "contacts" ("id", "created_at", "updated_at", "organization_id", "created_by", "name")
            select ${sql.ref('r.id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', org)}, ${bind(qc, 'uuid', actor)}, ${sql.ref('r.name')}
            from ${contactSet} order by ${sql.ref('r.ord')}`.compile(qc.db),
          ),
        )
      }
      if (fresh.length > 0) {
        const identitySet = jsonRows(
          qc,
          'r',
          { id: 'uuid', kind: 'text', value: 'text', contact_id: 'uuid' },
          fresh.map((f) => ({ id: f.identityId, kind: f.kind, value: f.value, contact_id: f.contactId })),
        )
        steps.push(
          step(
            sql`insert into "identities" ("id", "created_at", "updated_at", "organization_id", "created_by", "kind", "value", "contact_id", "own")
            select ${sql.ref('r.id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', org)}, ${bind(qc, 'uuid', actor)},
              ${sql.ref('r.kind')}, ${sql.ref('r.value')}, ${sql.ref('r.contact_id')}, ${bind(qc, 'boolean', false)}
            from ${identitySet} order by ${sql.ref('r.ord')}`.compile(qc.db),
          ),
        )
      }
      if (promoted.length > 0) {
        // D6: the promotion holds only for an identity still live, not own and without a contact (the columns the plan read
        // relied on); any other state aborts the whole unit as drift, so no contact and no event survives it (408.21).
        const promoteSet = () =>
          jsonRows(
            qc,
            'r',
            { id: 'uuid', contact_id: 'uuid' },
            promoted.map((p) => ({ id: p.before.id, contact_id: p.contactId })),
          )
        steps.push(
          ...exactly(
            qc,
            step(
              sql`update "identities" set "contact_id" = (select ${sql.ref('r.contact_id')} from ${promoteSet()} where ${sql.ref('r.id')} = "identities"."id"),
                "updated_at" = ${bind(qc, 'timestamp', at)}
              where "identities"."organization_id" = ${bind(qc, 'uuid', org)} and "identities"."deleted_at" is null
                and "identities"."own" = ${bind(qc, 'boolean', false)} and "identities"."contact_id" is null
                and "identities"."id" in (select ${sql.ref('r.id')} from ${promoteSet()})`.compile(qc.db),
            ),
            promoted.length,
          ),
        )
      }
      const first = steps.findIndex(() => true)
      if (first >= 0) steps[first] = { ...steps[first]!, label: 'first-mutation' }
      const allContacts = [...withContact, ...promoted]
      const eventSteps: Step[] = []
      if (allContacts.length > 0)
        eventSteps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: org,
              actorId: actor,
              type: 'contact.created',
              resourceType: 'contact',
              after: { table: 'contacts', columns: contactColumns, kinds: columnKindsOf(contacts) },
              rows: [
                ...withContact.map((f) => ({ eventId: f.contactEvent, resourceId: f.contactId!, before: null })),
                ...promoted.map((p) => ({ eventId: p.contactEvent, resourceId: p.contactId, before: null })),
              ],
            }),
          ),
        )
      if (fresh.length > 0)
        eventSteps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: org,
              actorId: actor,
              type: 'identity.created',
              resourceType: 'identity',
              after: { table: 'identities', columns: identityColumns },
              rows: fresh.map((f) => ({ eventId: f.identityEvent, resourceId: f.identityId, before: null })),
            }),
          ),
        )
      if (promoted.length > 0)
        eventSteps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: org,
              actorId: actor,
              type: 'identity.updated',
              resourceType: 'identity',
              after: { table: 'identities', columns: identityColumns },
              rows: promoted.map((p) => ({ eventId: p.identityEvent, resourceId: p.before.id, before: p.before })),
            }),
          ),
        )
      eventSteps[0] = { ...eventSteps[0]!, label: 'first-event' }
      steps.push(
        ...eventSteps,
        step(
          sql`select ${sql.join(joinedColumns(qc, contacts))} from ${resultSet}
            join "identities" on "identities"."id" = ${sql.ref('r.id')}
            left join "contacts" on "contacts"."id" = "identities"."contact_id" and "contacts"."organization_id" = "identities"."organization_id"
            order by ${sql.ref('r.ord')}`.compile(qc.db),
          'result',
        ),
      )
      const events: EventReceipt[] = [
        ...withContact.map((f) => ({
          id: f.contactEvent,
          type: 'contact.created',
          resourceType: 'contact',
          resourceId: f.contactId!,
        })),
        ...promoted.map((p) => ({
          id: p.contactEvent,
          type: 'contact.created',
          resourceType: 'contact',
          resourceId: p.contactId,
        })),
        ...fresh.map((f) => ({
          id: f.identityEvent,
          type: 'identity.created',
          resourceType: 'identity',
          resourceId: f.identityId,
        })),
        ...promoted.map((p) => ({
          id: p.identityEvent,
          type: 'identity.updated',
          resourceType: 'identity',
          resourceId: p.before.id,
        })),
      ]
      return unit({
        steps,
        events,
        decode: (rows) => {
          const created = new Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>()
          for (const row of rows) {
            const r = splitRow(contacts, row)
            created.set(key(r.identity), r)
          }
          return finish(created)
        },
      })
    },
  }
}

export function resolveOperation(
  env: PreparedEnv,
  entries: readonly ResolveEntry[],
  contacts: ContactsDefinition = defaultContacts,
): PreparedOperation<ResolveResult[]> {
  return operationOf('identities.resolve', resolveProgram(env, entries, contacts))
}

/**
 * [[CHN5]] D10: makes an address one of the organisation's own. Not an operation: a service function that
 * [[CORE25]]'s capture unit composes. None -> insert an own identity; already own -> nothing; on a contact -> the
 * identity moves to own (the contact stays live).
 */
export function ensureOwnProgram(
  env: PreparedEnv,
  address: { kind: IdentityKind; value: string },
): Program<EnsureOwnResult> {
  const value = normalizeIdentityValue(address.kind, address.value)
  const at = codecs.timestamp.write(env.now)
  const newId = env.newId()
  const eventId = env.newId()
  return {
    reads: (qc) => ({
      [OWN]: readMaybe(
        selectRecord(identities, qc, env)
          .where(sql<SqlBool>`${sql.ref('identities.kind')} = ${address.kind}`)
          .where(sql<SqlBool>`${sql.ref('identities.value')} = ${value}`)
          .select(ts.exact(qc, 'identities.updated_at').as('__stamp')),
      ),
    }),
    build(found, qc): Unit<EnsureOwnResult> {
      const row = found.maybe(OWN)
      const resultOf = (id: string): Step =>
        step(selectRecord(identities, qc, env, id).where(eventExists(eventId)), 'result')
      const eventFor = (type: 'created' | 'updated', id: string, before: IdentityRecord | null): Step =>
        step(
          eventStatement(qc, {
            id: eventId,
            at,
            organizationId: env.organizationId,
            actorId: env.actor.id,
            type: `identity.${type}`,
            resourceType: 'identity',
            resourceId: id,
            before,
            after: { table: 'identities', columns: identityColumns },
          }),
          'first-event',
        )
      const receiptOf = (type: 'created' | 'updated', id: string): EventReceipt => ({
        id: eventId,
        type: `identity.${type}`,
        resourceType: 'identity',
        resourceId: id,
      })
      if (!row) {
        const insert = loose(qc).insertInto('identities').values({
          id: newId,
          created_at: at,
          updated_at: at,
          organization_id: env.organizationId,
          created_by: env.actor.id,
          kind: address.kind,
          value,
          contact_id: null,
          own: true,
        })
        return unit({
          steps: [step(insert, 'first-mutation'), eventFor('created', newId, null), resultOf(newId)],
          events: [receiptOf('created', newId)],
          decode: (rows) => {
            if (rows.length === 0) throw new UnitDriftError('identities.ensure_own')
            return { identity: toRecord(identities, rows[0]!), outcome: 'created' }
          },
        })
      }
      const { __stamp, ...rest } = row as Record<string, unknown>
      const existing = toRecord(identities, rest as Row)
      if (existing.own)
        return unit({ steps: [], events: [], decode: () => ({ identity: existing, outcome: 'unchanged' }) })
      const move = loose(qc)
        .updateTable('identities')
        .set({ contact_id: null, own: true, updated_at: at })
        .where(sql<SqlBool>`${sql.ref('identities.id')} = ${existing.id}`)
        .where(sql<SqlBool>`${sql.ref('identities.organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${sql.ref('identities.deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, 'identities.updated_at')} = ${String(__stamp)}`)
      return unit({
        steps: [
          step(move, 'first-mutation', { expect: 'affected' }),
          eventFor('updated', existing.id, existing),
          resultOf(existing.id),
        ],
        events: [receiptOf('updated', existing.id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('identities.ensure_own')
          return { identity: toRecord(identities, rows[0]!), outcome: 'moved' }
        },
      })
    },
  }
}

export function ensureOwnIdentity(
  env: PreparedEnv,
  address: { kind: IdentityKind; value: string },
): PreparedOperation<EnsureOwnResult> {
  return operationOf('identities.ensure_own', ensureOwnProgram(env, address))
}
