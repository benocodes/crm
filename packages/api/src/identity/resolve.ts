import { sql, type Kysely, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  bind,
  boundIds,
  codecs,
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
} from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventSetStatement, eventStatement } from '../outbox.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { identities, type IdentityRecord } from '../resources/identities.js'
import { columnsOf, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { normalizeIdentityValue, type IdentityKind } from './normalize.js'
import { operationOf, type Program } from './program.js'

export type ResolveEntry = { kind: IdentityKind; value: string; name?: string }
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
const contactColumns = columnsOf(contacts)
const eventExists = (eventId: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`

/** An identity row with its contact (columns prefixed `c_`; all null when the identity has no contact). */
function splitRow(row: Row): { identity: IdentityRecord; contact: ContactRecord | null } {
  const contact: Record<string, unknown> = {}
  for (const c of contactColumns) contact[c] = row[`${C}${c}`]
  return { identity: toRecord(identities, row), contact: contact.id === null || contact.id === undefined ? null : toRecord(contacts, contact as Row) }
}
const joinedColumns = (qc: QueryContext) => [...recordColumns(qc, 'identities', identityColumns), ...recordColumns(qc, 'contacts', contactColumns, C)]

/**
 * `identities.resolve` as a plan/build pair ([[CORE36]] C6, D15). Every entry is normalised first (errors carry the
 * `identities[i]: ` prefix); one plan read finds the live identities of the batch's addresses with their contacts; the
 * unit then creates ONE contact and ONE identity per distinct new address in first-occurrence order, as a constant
 * number of set statements (D5). The response is in input order; `created` is true only on the first occurrence of
 * a new address; an existing contact is never renamed. Zero orphans because the unit is atomic (P4), not because of a lock.
 */
export function resolveProgram(env: PreparedEnv, entries: readonly ResolveEntry[]): Program<ResolveResult[]> {
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
      boundIds(qc, normalized.map((e) => e.value))
      const values = [...new Set(normalized.map((e) => e.value))]
      const known = sql`
        select ${sql.join(joinedColumns(qc))} from "identities"
        left join "contacts" on "contacts"."id" = "identities"."contact_id" and "contacts"."organization_id" = "identities"."organization_id"
        where "identities"."organization_id" = ${env.organizationId} and "identities"."deleted_at" is null and ${memberOf(qc, 'identities', 'value', values)}`.compile(qc.db)
      return { [KNOWN]: readSet(known) }
    },
    build(found, qc): Unit<ResolveResult[]> {
      if (normalized.length === 0) return unit({ steps: [], events: [], decode: () => [] })
      const known = new Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>()
      for (const row of found.all(KNOWN)) {
        const r = splitRow(row)
        known.set(key(r.identity), r)
      }
      // One new contact + identity per distinct unknown address, in first-occurrence order.
      const fresh: Array<{ kind: IdentityKind; value: string; name: string | null; contactId: string; identityId: string; contactEvent: string; identityEvent: string }> = []
      const seen = new Set<string>()
      for (const e of normalized) {
        const k = key(e)
        if (known.has(k) || seen.has(k)) continue
        seen.add(k)
        fresh.push({ kind: e.kind, value: e.value, name: cleanName(e.name) ?? null, contactId: env.newId(), identityId: env.newId(), contactEvent: '', identityEvent: '' })
      }
      for (const f of fresh) f.contactEvent = env.newId()
      for (const f of fresh) f.identityEvent = env.newId()

      const finish = (created: Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>): ResolveResult[] => {
        const first = new Set<string>()
        return normalized.map((e) => {
          const k = key(e)
          const hit = known.get(k)
          if (hit) return { identity: hit.identity, contact: hit.contact, created: false }
          const made = created.get(k)
          if (!made) throw new UnitDriftError('identities.resolve')
          const isFirst = !first.has(k)
          first.add(k)
          return { identity: made.identity, contact: made.contact, created: isFirst }
        })
      }
      if (fresh.length === 0) return unit({ steps: [], events: [], decode: () => finish(new Map()) })

      const actor = env.actor.id
      const org = env.organizationId
      const contactSet = jsonRows(qc, 'r', { id: 'uuid', name: 'text' }, fresh.map((f) => ({ id: f.contactId, name: f.name })))
      const identitySet = jsonRows(qc, 'r', { id: 'uuid', kind: 'text', value: 'text', contact_id: 'uuid' }, fresh.map((f) => ({ id: f.identityId, kind: f.kind, value: f.value, contact_id: f.contactId })))
      const resultSet = jsonRows(qc, 'r', { id: 'uuid' }, fresh.map((f) => ({ id: f.identityId })))
      const steps: Step[] = [
        step(
          sql`insert into "contacts" ("id", "created_at", "updated_at", "organization_id", "created_by", "name")
            select ${sql.ref('r.id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', org)}, ${bind(qc, 'uuid', actor)}, ${sql.ref('r.name')}
            from ${contactSet} order by ${sql.ref('r.ord')}`.compile(qc.db),
          'first-mutation',
        ),
        step(
          sql`insert into "identities" ("id", "created_at", "updated_at", "organization_id", "created_by", "kind", "value", "contact_id", "own")
            select ${sql.ref('r.id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', org)}, ${bind(qc, 'uuid', actor)},
              ${sql.ref('r.kind')}, ${sql.ref('r.value')}, ${sql.ref('r.contact_id')}, ${bind(qc, 'boolean', false)}
            from ${identitySet} order by ${sql.ref('r.ord')}`.compile(qc.db),
        ),
        step(
          eventSetStatement(qc, {
            at,
            organizationId: org,
            actorId: actor,
            type: 'contact.created',
            resourceType: 'contact',
            after: { table: 'contacts', columns: contactColumns },
            rows: fresh.map((f) => ({ eventId: f.contactEvent, resourceId: f.contactId, before: null })),
          }),
          'first-event',
        ),
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
        step(
          sql`select ${sql.join(joinedColumns(qc))} from ${resultSet}
            join "identities" on "identities"."id" = ${sql.ref('r.id')}
            join "contacts" on "contacts"."id" = "identities"."contact_id"
            order by ${sql.ref('r.ord')}`.compile(qc.db),
          'result',
        ),
      ]
      const events: EventReceipt[] = [
        ...fresh.map((f) => ({ id: f.contactEvent, type: 'contact.created', resourceType: 'contact', resourceId: f.contactId })),
        ...fresh.map((f) => ({ id: f.identityEvent, type: 'identity.created', resourceType: 'identity', resourceId: f.identityId })),
      ]
      return unit({
        steps,
        events,
        decode: (rows) => {
          const created = new Map<string, { identity: IdentityRecord; contact: ContactRecord | null }>()
          for (const row of rows) {
            const r = splitRow(row)
            created.set(key(r.identity), r)
          }
          return finish(created)
        },
      })
    },
  }
}

export function resolveOperation(env: PreparedEnv, entries: readonly ResolveEntry[]): PreparedOperation<ResolveResult[]> {
  return operationOf('identities.resolve', resolveProgram(env, entries))
}

/**
 * [[CHN5]] D10: makes an address one of the organisation's own. Not an operation: a service function that
 * [[CORE25]]'s capture unit composes. None -> insert an own identity; already own -> nothing; on a contact -> the
 * identity moves to own (the contact stays live).
 */
export function ensureOwnProgram(env: PreparedEnv, address: { kind: IdentityKind; value: string }): Program<EnsureOwnResult> {
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
      const resultOf = (id: string): Step => step(selectRecord(identities, qc, env, id).where(eventExists(eventId)), 'result')
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
      const receiptOf = (type: 'created' | 'updated', id: string): EventReceipt => ({ id: eventId, type: `identity.${type}`, resourceType: 'identity', resourceId: id })
      if (!row) {
        const insert = loose(qc)
          .insertInto('identities')
          .values({ id: newId, created_at: at, updated_at: at, organization_id: env.organizationId, created_by: env.actor.id, kind: address.kind, value, contact_id: null, own: true })
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
      if (existing.own) return unit({ steps: [], events: [], decode: () => ({ identity: existing, outcome: 'unchanged' }) })
      const move = loose(qc)
        .updateTable('identities')
        .set({ contact_id: null, own: true, updated_at: at })
        .where(sql<SqlBool>`${sql.ref('identities.id')} = ${existing.id}`)
        .where(sql<SqlBool>`${sql.ref('identities.organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${sql.ref('identities.deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, 'identities.updated_at')} = ${String(__stamp)}`)
      return unit({
        steps: [step(move, 'first-mutation', { expect: 'affected' }), eventFor('updated', existing.id, existing), resultOf(existing.id)],
        events: [receiptOf('updated', existing.id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('identities.ensure_own')
          return { identity: toRecord(identities, rows[0]!), outcome: 'moved' }
        },
      })
    },
  }
}

export function ensureOwnIdentity(env: PreparedEnv, address: { kind: IdentityKind; value: string }): PreparedOperation<EnsureOwnResult> {
  return operationOf('identities.ensure_own', ensureOwnProgram(env, address))
}
