import { expressionBuilder, sql, type Kysely, type SqlBool } from 'kysely'
import {
  COLUMN_KINDS,
  UnitDriftError,
  codecs,
  defineOperation,
  readAll,
  readMaybe,
  recordColumns,
  step,
  ts,
  unit,
  type ColumnKind,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Row,
  type Step,
  type StorageDatabase,
} from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import type { ListResult } from '../resources/crud.js'
import type { PreparedEnv, PreparedResource } from './definition.js'
import { canonicalId, prepareCreate, prepareListQuery, prepareUpdate } from './prepare.js'

// The generic prepared CRUD core ([[CORE35]] C4): list, get, create, update and soft delete for any
// `PreparedResource`, as pure programs over typed Kysely fragments. Every mutation is plan -> one unit:
// the write, its event (INSERT...SELECT gated on the write having applied) and the result select.

// REVIEWED ADAPTER BOUNDARY (#2 of 2, with @vault/storage helpers.ts): Kysely cannot relate a generic table
// name to its columns, so the dynamic builders go through this untyped view. Every exported signature here is
// typed by `PreparedResource<T>`, and the type fixtures prove the public helpers still reject bad input.
type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as unknown as Loose

const columnsOf = (def: PreparedResource): string[] => Object.keys(def.record.shape)
const kindsOf = (def: PreparedResource): Record<string, ColumnKind> => COLUMN_KINDS[def.table] as Record<string, ColumnKind>
const ref = (def: PreparedResource, column: string) => sql.ref(`${def.table}.${column}`)
const notFound = (def: PreparedResource) => new ApiError(404, 'not_found', `${def.eventName} not found`)
const invalidReference = () => new ApiError(400, 'invalid_reference', 'a referenced record does not exist')

/** A stored row in its public shape: timestamps already ISO text, parsed by the definition's record schema. */
function toRecord<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, row: Row): R {
  const kinds = kindsOf(def)
  const converted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) converted[k] = kinds[k] === 'timestamp' ? codecs.timestamp.readNullable(v) : v
  return def.record.parse(converted)
}

const live = (def: PreparedResource, env: PreparedEnv, id?: string) => [
  sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`,
  sql<SqlBool>`${ref(def, 'deleted_at')} is null`,
  ...(id ? [sql<SqlBool>`${ref(def, 'id')} = ${id}`] : []),
]

const selectRecord = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id?: string) => {
  let q = loose(qc).selectFrom(def.table).select(recordColumns(qc, def.table, columnsOf(def)) as never)
  for (const w of live(def, env, id)) q = q.where(w)
  return q
}

/** The reference checks an input needs: one read per non-null referenced column (visible principals only). */
function referenceReads(def: PreparedResource, qc: QueryContext, values: Record<string, unknown>) {
  const reads: Record<string, ReturnType<typeof readMaybe>> = {}
  for (const [column, spec] of Object.entries(def.references ?? {})) {
    const value = values[column]
    if (typeof value !== 'string' || spec === undefined) continue
    reads[`ref:${column}`] = readMaybe(loose(qc).selectFrom(spec.table).select(sql<number>`1`.as('one') as never).where(sql<SqlBool>`${sql.ref(`${spec.table}.id`)} = ${value}`))
  }
  return reads
}
const missingReference = (found: { maybe(k: string): Row | null }, reads: Record<string, unknown>): boolean =>
  Object.keys(reads).some((k) => found.maybe(k) === null)

export function listOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, raw: { after?: unknown; limit?: unknown; filters?: Record<string, string> }): PreparedOperation<ListResult<R>> {
  const { after, limit, filters } = prepareListQuery(def, raw)
  return defineOperation<ListResult<R>>({
    name: `${def.name}.list`,
    mutates: false,
    reads: (qc) => {
      let q = selectRecord(def, qc, env)
      if (after) q = q.where(sql<SqlBool>`${ref(def, 'id')} > ${after}`)
      for (const [column, value] of Object.entries(filters)) q = q.where(sql<SqlBool>`${ref(def, column)} = ${value}`)
      return { page: readAll(q.orderBy(ref(def, 'id') as never).limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = found.all('page')
          const page = rows.slice(0, limit)
          return {
            data: page.map((r) => toRecord(def, r)),
            next_cursor: rows.length > limit ? (page[page.length - 1]!.id as string) : null,
          }
        },
      }),
  })
}

export function getOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, rawId: string): PreparedOperation<R> {
  const id = canonicalId(def, rawId)
  return defineOperation<R>({
    name: `${def.name}.get`,
    mutates: false,
    reads: (qc) => ({ row: readMaybe(selectRecord(def, qc, env, id)) }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) throw notFound(def)
          return toRecord(def, row)
        },
      }),
  })
}

/** Result select, gated on this unit's event having been written, so a drifted (no-op) unit returns nothing. */
const resultStep = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id: string, eventId: string): Step => {
  const q = loose(qc)
    .selectFrom(def.table)
    .select(recordColumns(qc, def.table, columnsOf(def)) as never)
    .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
    .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
    .where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`)
  return step(q, 'result')
}

const receipt = (def: PreparedResource, eventId: string, action: string, id: string): EventReceipt => ({
  id: eventId,
  type: `${def.eventName}.${action}`,
  resourceType: def.eventName,
  resourceId: id,
})

export function createOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, input: unknown): PreparedOperation<R> {
  const values = prepareCreate(def, env.actor, input)
  const stored = { ...values, ...(def.prepare?.({ values, meta: { op: 'create', now: env.now } }) ?? {}) }
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<R>({
    name: `${def.name}.create`,
    mutates: true,
    reads: (qc) => referenceReads(def, qc, stored),
    build: (found, qc) => {
      if (missingReference(found, referenceReads(def, qc, stored))) throw invalidReference()
      const insert = loose(qc)
        .insertInto(def.table)
        .values({ ...stored, id, organization_id: env.organizationId, created_by: env.actor.id, created_at: at, updated_at: at })
      return unit({
        steps: [
          step(insert, 'first-mutation'),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: `${def.eventName}.created`,
              resourceType: def.eventName,
              resourceId: id,
              before: null,
              after: { table: def.table, columns: columnsOf(def) },
            }),
            'first-event',
          ),
          resultStep(def, qc, env, id, eventId),
          ...(def.after?.({ qc, env, op: 'create', id }) ?? []),
        ],
        events: [receipt(def, eventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`${def.name}.create`)
          return toRecord(def, rows[0]!)
        },
      })
    },
  })
}

/** The before row, plus its exact stored `updated_at` for the drift guard. */
const beforeRead = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id: string) =>
  readMaybe(selectRecord(def, qc, env, id).select(ts.exact(qc, `${def.table}.updated_at`).as('__stamp') as never))

export function updateOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, rawId: string, input: unknown): PreparedOperation<R> {
  const values = prepareUpdate(def, env.actor, input)
  const id = canonicalId(def, rawId)
  const empty = Object.keys(values).length === 0
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const stored = { ...values, ...(def.prepare?.({ values, meta: { op: 'update', now: env.now } }) ?? {}) }
  return defineOperation<R>({
    name: `${def.name}.update`,
    mutates: !empty,
    reads: (qc) => ({ before: beforeRead(def, qc, env, id), ...referenceReads(def, qc, stored) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound(def)
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(def, rest)
      // An empty patch checks existence and writes nothing (old behaviour). A same-value patch is a real update.
      if (empty) return unit({ steps: [], events: [], decode: () => before })
      if (missingReference(found, referenceReads(def, qc, stored))) throw invalidReference()
      const computed = def.computed?.({ eb: expressionBuilder<StorageDatabase, PreparedResource['table']>(), qc, values: stored, now: env.now }) ?? {}
      let update = loose(qc)
        .updateTable(def.table)
        .set({ ...stored, ...computed, updated_at: at } as never)
        .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
        .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${ref(def, 'deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, `${def.table}.updated_at`)} = ${String(__stamp)}`)
      for (const g of def.guards?.(expressionBuilder<StorageDatabase, PreparedResource['table']>(), env) ?? []) update = update.where(g)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: `${def.eventName}.updated`,
              resourceType: def.eventName,
              resourceId: id,
              before,
              after: { table: def.table, columns: columnsOf(def) },
            }),
            'first-event',
          ),
          resultStep(def, qc, env, id, eventId),
          ...(def.after?.({ qc, env, op: 'update', id }) ?? []),
        ],
        events: [receipt(def, eventId, 'updated', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`${def.name}.update`)
          return toRecord(def, rows[0]!)
        },
      })
    },
  })
}

export function deleteOperation(def: PreparedResource, env: PreparedEnv, rawId: string): PreparedOperation<void> {
  const id = canonicalId(def, rawId)
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<void>({
    name: `${def.name}.delete`,
    mutates: true,
    reads: (qc) => ({ before: beforeRead(def, qc, env, id) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound(def)
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(def, rest)
      let update = loose(qc)
        .updateTable(def.table)
        .set({ deleted_at: at, updated_at: at } as never)
        .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
        .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${ref(def, 'deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, `${def.table}.updated_at`)} = ${String(__stamp)}`)
      for (const g of def.guards?.(expressionBuilder<StorageDatabase, PreparedResource['table']>(), env) ?? []) update = update.where(g)
      const proof = loose(qc)
        .selectNoFrom(sql<number>`1`.as('applied') as never)
        .where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: `${def.eventName}.deleted`,
              resourceType: def.eventName,
              resourceId: id,
              before,
              after: null,
            }),
            'first-event',
          ),
          step(proof, 'result'),
          ...(def.after?.({ qc, env, op: 'delete', id }) ?? []),
        ],
        events: [receipt(def, eventId, 'deleted', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError(`${def.name}.delete`)
        },
      })
    },
  })
}

