import { expressionBuilder, sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import {
  COLUMN_KINDS,
  UnitDriftError,
  bind,
  codecs,
  defineOperation,
  embedJson,
  readAll,
  readMaybe,
  type Read,
  recordColumns,
  step,
  ts,
  unit,
  type ColumnKind,
  type EmbedSpec,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Row,
  type Step,
  type StorageDatabase,
} from '@vault/storage'
import { ApiError } from '../errors.js'
import { formatScope } from '../scopes.js'
import { eventStatement } from '../outbox.js'
import { physicalTable, softDeletes, type Conflict, type PreparedEnv, type PreparedResource, type ReferenceTarget } from './definition.js'
import { canonicalId, prepareCreate, prepareListQuery, prepareUpdate } from './prepare.js'
import { encodeCursor, type SortRequest } from '../resources/sort-cursor.js'

// The generic prepared CRUD core ([[CORE35]] C4): list, get, create, update and soft delete for any
// `PreparedResource`, as pure programs over typed Kysely fragments. Every mutation is plan -> one unit:
// the write, its event (INSERT...SELECT gated on the write having applied) and the result select.

// REVIEWED ADAPTER BOUNDARY (#2 of 2, with @vault/storage helpers.ts): Kysely cannot relate a generic table
// name to its columns, so the dynamic builders go through this untyped view. Every exported signature here is
// typed by `PreparedResource<T>`, and the type fixtures prove the public helpers still reject bad input.
type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as unknown as Loose

export type ListResult<R> = { data: R[]; next_cursor: string | null }

/** The embeds of a definition (record fields rendered from a child table, [[CORE25]] D50). */
export const embedsOf = (def: PreparedResource): Readonly<Record<string, EmbedSpec>> => def.embed ?? {}
/** The physical columns of the record: its keys minus the embed and derived fields. */
export const columnsOf = (def: PreparedResource): string[] => Object.keys(def.record.shape).filter((k) => !(k in embedsOf(def)) && !(k in (def.derived ?? {})))
/** What an event's `after` is rendered from: the stored row's columns plus the embedded children (one rendering for reads and events). */
export const afterOf = (def: PreparedResource) => ({ table: physicalTable(def), columns: columnsOf(def), embeds: embedsOf(def) })
/** The parent column reference a derived expression correlates on: `parent('id')` is `<table>.id`. */
const parentOf = (def: PreparedResource) => (column: string) => sql.ref(`${def.table}.${column}`)
/** The derived fields this caller may see ([[CORE131]] D5): those whose `requires` scopes it holds all. */
export const visibleDerived = (def: PreparedResource, env: PreparedEnv): Array<[string, NonNullable<PreparedResource['derived']>[string]]> =>
  Object.entries(def.derived ?? {}).filter(([, d]) => (d.requires ?? []).every((scope) => env.scopes.has(scope)))
/** The derived fields of a record select, aliased to their names; only the ones the caller may see. */
export const derivedProjection = (def: PreparedResource, qc: QueryContext, env: PreparedEnv) =>
  visibleDerived(def, env).map(([field, d]) => sql`${d.expression(qc, parentOf(def))}`.as(field))
/** A record select's projection: the columns (timestamps as ISO text), each embed aliased to its field, and the derived fields the caller may see. */
const projection = (def: PreparedResource, qc: QueryContext, env?: PreparedEnv) => [
  ...recordColumns(qc, physicalTable(def), columnsOf(def)),
  ...Object.entries(embedsOf(def)).map(([field, spec]) => embedJson(qc, physicalTable(def), spec, 'select').as(field)),
  ...(env ? derivedProjection(def, qc, env) : []),
]
const kindsOf = (def: PreparedResource): Record<string, ColumnKind> => COLUMN_KINDS[physicalTable(def)] as Record<string, ColumnKind>
const ref = (def: PreparedResource, column: string) => sql.ref(`${def.table}.${column}`)
const notFound = (def: PreparedResource) => new ApiError(404, 'not_found', `${def.eventName} not found`)
const invalidReference = () => new ApiError(400, 'invalid_reference', 'a referenced record does not exist')

/** A stored row in its public shape: timestamps already ISO text and booleans decoded (D1 reads 0/1), parsed by the definition's record schema. */
export function toRecord<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, row: Row): R {
  const kinds = { ...kindsOf(def), ...Object.fromEntries(Object.entries(def.derived ?? {}).map(([k, d]) => [k, d.kind])) } as Record<string, ColumnKind>
  const converted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    converted[k] =
      kinds[k] === 'timestamp'
        ? codecs.timestamp.readNullable(v)
        : kinds[k] === 'boolean'
          ? codecs.boolean.readNullable(v)
          : kinds[k] === 'string_array'
            ? codecs.stringArray.readNullable(v)
            : kinds[k] === 'integer'
              ? codecs.integer.readNullable(v)
              : kinds[k] === 'json' || k in embedsOf(def)
                ? codecs.json.readNullable(v)
                : v
  }
  return def.record.parse(converted)
}

/** The columns a write may store: a field that is not a column of the table is a hook input only (CORE40 P5). */
const columnsOnly = (def: PreparedResource, values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([k]) => k in kindsOf(def)))

const live = (def: PreparedResource, env: PreparedEnv, id?: string) => [
  sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`,
  ...(softDeletes(def) ? [sql<SqlBool>`${ref(def, 'deleted_at')} is null`] : []),
  ...(id ? [sql<SqlBool>`${ref(def, 'id')} = ${id}`] : []),
]

/** A live record select. `derived: false` leaves the derived fields out: what an event's `before` is rendered from (D2). */
export const selectRecord = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id?: string, opts: { derived?: boolean } = {}) => {
  let q = loose(qc).selectFrom(def.table).select(projection(def, qc, opts.derived === false ? undefined : env))
  for (const w of live(def, env, id)) q = q.where(w)
  return q
}

/** The ONE predicate of a reference (D4), used by the plan read and the commit guard alike. */
function referencePredicates(spec: ReferenceTarget, value: string, env: PreparedEnv): Expression<SqlBool>[] {
  const kinds = COLUMN_KINDS[spec.table] as Record<string, ColumnKind>
  const preds = [sql<SqlBool>`${sql.ref(`${spec.table}.id`)} = ${value}`]
  if ('organization_id' in kinds) preds.push(sql<SqlBool>`${sql.ref(`${spec.table}.organization_id`)} = ${env.organizationId}`)
  if (spec.live && 'deleted_at' in kinds) preds.push(sql<SqlBool>`${sql.ref(`${spec.table}.deleted_at`)} is null`)
  return preds
}
const referenced = (def: PreparedResource, values: Record<string, unknown>): Array<[string, ReferenceTarget, string]> =>
  (Object.entries(def.references ?? {}) as Array<[string, ReferenceTarget | undefined]>).flatMap(([column, spec]) =>
    spec !== undefined && typeof values[column] === 'string' ? [[column, spec, values[column] as string] as [string, ReferenceTarget, string]] : [],
  )

/** The reference checks an input needs: one read per non-null referenced column. */
function referenceReads(def: PreparedResource, qc: QueryContext, env: PreparedEnv, values: Record<string, unknown>) {
  const reads: Record<string, ReturnType<typeof readMaybe>> = {}
  for (const [column, spec, value] of referenced(def, values)) {
    let q = loose(qc).selectFrom(spec.table).select(sql<number>`1`.as('one'))
    for (const p of referencePredicates(spec, value, env)) q = q.where(p)
    reads[`ref:${column}`] = readMaybe(q)
  }
  return reads
}
/** The commit-time form of the same predicates: `exists (live referenced row)`, one per non-null reference. */
function referenceGuards(def: PreparedResource, env: PreparedEnv, values: Record<string, unknown>): Expression<SqlBool>[] {
  return referenced(def, values).map(([, spec, value]) => {
    const where = sql.join(referencePredicates(spec, value, env), sql` and `)
    return sql<SqlBool>`exists (select 1 from ${sql.table(spec.table)} where ${where})`
  })
}
const conflictReads = (conflicts: readonly Conflict[]) => Object.fromEntries(conflicts.map((c, i) => [`conflict:${i}`, c.read]))
function refuseConflicts(found: { maybe(k: string): Row | null }, conflicts: readonly Conflict[]): void {
  conflicts.forEach((c, i) => c.refuse(found.maybe(`conflict:${i}`)))
}
const missingReference = (found: { maybe(k: string): Row | null }, reads: Record<string, unknown>): boolean =>
  Object.keys(reads).some((k) => found.maybe(k) === null)

/** A stored column or correlated derived expression, with the sort's text collation. */
function sortExpression(def: PreparedResource, qc: QueryContext, sort: SortRequest): Expression<unknown> {
  const value = def.derived?.[sort.field]?.expression(qc, parentOf(def)) ?? ref(def, sort.field)
  // An explicit collation also overrides a stored column's NOCASE default (e.g. pipeline names).
  return def.sortKinds && sort.kind === 'text'
    ? sql`${value} collate ${qc.dialect === 'd1' ? sql`binary` : sql`"C"`}`
    : value
}

/**
 * The keyset predicate of a sorted page ([[CORE133]] D9): rows strictly after `(value, id)`, with null lowest and direction-matched id ties.
 * Re-evaluate the expression instead of naming the select alias, which Postgres does not allow in a WHERE.
 */
function afterPosition(def: PreparedResource, qc: QueryContext, sort: SortRequest & { position: NonNullable<SortRequest['position']> }): Expression<SqlBool> {
  const v = sortExpression(def, qc, sort)
  const { value, id } = sort.position
  const idRef = ref(def, 'id')
  if (sort.field === 'id') return sort.order === 'asc' ? sql<SqlBool>`${idRef} > ${id}` : sql<SqlBool>`${idRef} < ${id}`
  if (sort.order === 'asc') {
    return value === null
      ? sql<SqlBool>`(${v} is not null or ${idRef} > ${id})`
      : sql<SqlBool>`(${v} > ${value} or (${v} = ${value} and ${idRef} > ${id}))`
  }
  return value === null
    ? sql<SqlBool>`(${v} is null and ${idRef} < ${id})`
    : sql<SqlBool>`(${v} < ${value} or ${v} is null or (${v} = ${value} and ${idRef} < ${id}))`
}

/**
 * [[CORE188]] D3: what else decides which rows a list may show, for a list whose visibility is not the table's scope (an execution is visible when
 * the caller may read its operation, [[AGT8]] D57). `'nothing'` means nothing is readable: no read is issued and the page is empty. A function
 * is a predicate ANDed into the query, on the unsorted and the sorted path alike. Validation (`400`) always precedes it.
 */
export type ListRestriction = 'nothing' | ((qc: QueryContext) => Expression<SqlBool>)

export function listOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, raw: { after?: unknown; limit?: unknown; sort?: unknown; order?: unknown; filters?: Record<string, string> }, restriction?: ListRestriction): PreparedOperation<ListResult<R>> {
  // 400s first (a malformed query is refused whatever the caller may see), then 403s ([[CORE133]] D5); both before any query is built.
  const { after, limit, filters, sort } = prepareListQuery(def, raw)
  // [[CORE129]] D12: a custom filter may need scopes beyond the list's own; refused here, before any query is built.
  for (const column of Object.keys(filters)) {
    for (const scope of def.customFilters?.[column]?.requires ?? []) {
      if (!env.scopes.has(scope)) throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(scope)} to filter ${def.name} by ${column}`)
    }
  }
  // [[CORE133]] D5: sorting by a derived field needs the scopes that show it; a caller without them never gets a cursor carrying its value.
  if (sort) {
    for (const scope of def.derived?.[sort.field]?.requires ?? []) {
      if (!env.scopes.has(scope)) throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(scope)} to sort ${def.name} by ${sort.field}`)
    }
  }
  return defineOperation<ListResult<R>>({
    name: `${def.name}.list`,
    mutates: false,
    reads: (qc): Record<string, Read> => {
      if (restriction === 'nothing') return {}
      let q = selectRecord(def, qc, env)
      if (restriction) q = q.where(restriction(qc))
      if (sort && def.sortKinds) q = q.select(sql`${sortExpression(def, qc, sort)}`.as('__vault_sort_value'))
      if (sort?.position) q = q.where(afterPosition(def, qc, { ...sort, position: sort.position }))
      else if (after) q = q.where(sql<SqlBool>`${ref(def, 'id')} > ${after}`)
      for (const [column, value] of Object.entries(filters)) {
        const join = def.customFilters?.[column]
        q = q.where(join ? join.where(qc, value) : sql<SqlBool>`${ref(def, column)} = ${value}`)
      }
      // `null` is the oldest value: first ascending, last descending. Spelled out because Postgres would put it the other way round.
      if (sort && sort.field !== 'id') q = q.orderBy(sql`${def.sortKinds ? sortExpression(def, qc, sort) : sql.ref(sort.field)} ${sort.order === 'asc' ? sql`asc nulls first` : sql`desc nulls last`}`)
      return { page: readAll(q.orderBy(ref(def, 'id'), sort?.order ?? 'asc').limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = restriction === 'nothing' ? [] : found.all('page')
          const page = rows.slice(0, limit)
          const last = page[page.length - 1]
          const cursor = (): string => {
            if (!sort) return last!.id as string
            const value = last![def.sortKinds ? '__vault_sort_value' : sort.field]
            return encodeCursor(sort.field, sort.order, value === null || value === undefined ? null : sort.kind === 'integer' ? Number(value) : String(value), last!.id as string)
          }
          return {
            data: page.map((r) => {
              if (!sort || !def.sortKinds) return toRecord(def, r)
              const { __vault_sort_value: _value, ...record } = r
              return toRecord(def, record)
            }),
            next_cursor: rows.length > limit ? cursor() : null,
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
export const resultStep = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id: string, eventId: string): Step => {
  const q = loose(qc)
    .selectFrom(def.table)
    .select(projection(def, qc, env))
    .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
    .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
    .where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`)
  return step(q, 'result')
}

export const receipt = (def: PreparedResource, eventId: string, action: string, id: string): EventReceipt => ({
  id: eventId,
  type: `${def.eventName}.${action}`,
  resourceType: def.eventName,
  resourceId: id,
})

/** A bound value for an INSERT...SELECT: Postgres needs its type cast, D1 binds the value (booleans are encoded 1/0 by its runtime). */
function boundValue(qc: QueryContext, kind: ColumnKind | undefined, value: unknown) {
  if (kind === undefined) throw new Error('unsupported column kind in a guarded insert')
  if (value === null || value === undefined) return bind(qc, kind, null)
  if (kind === 'string_array') return bind(qc, kind, value as readonly string[])
  if (kind === 'boolean') return bind(qc, kind, value === true)
  if (kind === 'json') return bind(qc, kind, JSON.stringify(value))
  if (kind === 'integer') {
    if (typeof value !== 'number') throw new Error(`an integer column needs a number, got ${typeof value}`)
    return bind(qc, kind, value)
  }
  if (typeof value !== 'string') throw new Error(`a ${kind} column needs a string, got ${typeof value}`)
  return bind(qc, kind, value)
}

/**
 * `INSERT ... SELECT <bound values> WHERE <every reference guard holds>`: a reference that vanished makes the insert a no-op (D4).
 * `fromRows` are columns whose value is an expression over other rows ([[CORE130]] `createComputed`), selected beside the bound ones.
 */
function guardedInsert(def: PreparedResource, qc: QueryContext, row: Record<string, unknown>, guards: Expression<SqlBool>[], fromRows: Record<string, unknown> = {}) {
  const kinds = kindsOf(def)
  const columns = [...Object.keys(row), ...Object.keys(fromRows)]
  let select = loose(qc).selectNoFrom([
    ...Object.keys(row).map((c) => boundValue(qc, kinds[c], row[c]).as(c)),
    ...Object.entries(fromRows).map(([c, v]) => sql`${v as Expression<unknown>}`.as(c)),
  ])
  for (const g of guards) select = select.where(g)
  return loose(qc).insertInto(def.table).columns(columns).expression(select)
}

export function createOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, input: unknown): PreparedOperation<R> {
  const values = prepareCreate(def, env.actor, input)
  const stored = { ...values, ...(def.prepare?.({ values, meta: { op: 'create', now: env.now } }) ?? {}) }
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const conflictsOf = (qc: QueryContext) => def.conflicts?.({ qc, env, op: 'create', id: null, values: stored }) ?? []
  return defineOperation<R>({
    name: `${def.name}.create`,
    mutates: true,
    reads: (qc) => ({ ...referenceReads(def, qc, env, stored), ...conflictReads(conflictsOf(qc)) }),
    build: (found, qc) => {
      if (missingReference(found, referenceReads(def, qc, env, stored))) throw invalidReference()
      refuseConflicts(found, conflictsOf(qc))
      const row: Record<string, unknown> = { ...columnsOnly(def, stored), id, organization_id: env.organizationId, created_by: env.actor.id, created_at: at, updated_at: at }
      const guards = referenceGuards(def, env, stored)
      const fromRows = (def.createComputed?.({ eb: expressionBuilder<StorageDatabase, PreparedResource['table']>(), qc, env, values: stored }) ?? {}) as Record<string, unknown>
      const guarded = guards.length > 0 || Object.keys(fromRows).length > 0
      return unit({
        steps: [
          step(!guarded ? loose(qc).insertInto(def.table).values(row) : guardedInsert(def, qc, row, guards, fromRows), 'first-mutation', !guarded ? {} : { expect: 'affected' }),
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
              after: afterOf(def),
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

/** The before row, plus its exact stored `updated_at` for the drift guard. Without derived fields: it feeds events (D2). */
export const beforeRead = (def: PreparedResource, qc: QueryContext, env: PreparedEnv, id: string, opts: { derived?: boolean } = { derived: false }) =>
  readMaybe(selectRecord(def, qc, env, id, opts).select(ts.exact(qc, `${def.table}.updated_at`).as('__stamp')))

/**
 * A value that depends on the before row ([[AGT186]] D5/D6): `merge` runs in `build` on the one `before` read whose stamp guards the
 * UPDATE, and returns the values to add to the patch, or `null` for an empty patch (no UPDATE, no event, the record as read).
 */
export type UpdateMerge<R> = (before: R) => Record<string, unknown> | null

export function updateOperation<R extends { id: string }>(def: PreparedResource<PreparedResource['table'], R>, env: PreparedEnv, rawId: string, input: unknown, merge?: UpdateMerge<R>): PreparedOperation<R> {
  const values = prepareUpdate(def, env.actor, input)
  const id = canonicalId(def, rawId)
  const empty = merge === undefined && Object.keys(values).length === 0
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const prepared = { ...values, ...(def.prepare?.({ values, meta: { op: 'update', now: env.now } }) ?? {}) }
  const conflictsOf = (qc: QueryContext) => def.conflicts?.({ qc, env, op: 'update', id, values: prepared }) ?? []
  return defineOperation<R>({
    name: `${def.name}.update`,
    mutates: !empty,
    // An empty patch writes nothing and answers with the record as read, derived fields included; otherwise `before` feeds the event and carries none.
    reads: (qc) => ({ before: beforeRead(def, qc, env, id, { derived: empty }), ...referenceReads(def, qc, env, prepared), ...(empty ? {} : conflictReads(conflictsOf(qc))) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound(def)
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(def, rest)
      // An empty patch checks existence and writes nothing (old behaviour). A same-value patch is a real update.
      if (empty) return unit({ steps: [], events: [], decode: () => before })
      const merged = merge ? merge(before) : {}
      if (merged === null) return unit({ steps: [], events: [], decode: () => before })
      const stored = { ...prepared, ...merged }
      if (missingReference(found, referenceReads(def, qc, env, stored))) throw invalidReference()
      refuseConflicts(found, conflictsOf(qc))
      const computed = def.computed?.({ eb: expressionBuilder<StorageDatabase, PreparedResource['table']>(), qc, values: stored, now: env.now }) ?? {}
      let update = loose(qc)
        .updateTable(def.table)
        .set({ ...columnsOnly(def, stored), ...computed, updated_at: at })
        .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
        .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${ts.exact(qc, `${def.table}.updated_at`)} = ${String(__stamp)}`)
      if (softDeletes(def)) update = update.where(sql<SqlBool>`${ref(def, 'deleted_at')} is null`)
      for (const g of def.guards?.(expressionBuilder<StorageDatabase, PreparedResource['table']>(), env) ?? []) update = update.where(g)
      for (const g of referenceGuards(def, env, stored)) update = update.where(g)
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
              after: afterOf(def),
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
        .set({ deleted_at: at, updated_at: at })
        .where(sql<SqlBool>`${ref(def, 'id')} = ${id}`)
        .where(sql<SqlBool>`${ref(def, 'organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${ref(def, 'deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, `${def.table}.updated_at`)} = ${String(__stamp)}`)
      for (const g of def.guards?.(expressionBuilder<StorageDatabase, PreparedResource['table']>(), env) ?? []) update = update.where(g)
      const proof = loose(qc)
        .selectNoFrom(sql<number>`1`.as('applied'))
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

