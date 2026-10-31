import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, bind, codecs, defineOperation, readAll, readMaybe, recordColumns, step, ts, unit, type PreparedOperation, type QueryContext } from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { parseInput } from '../resources/define.js'
import { formatScope } from '../scopes.js'
import type { AnyResource, TenantOperation } from '../registry.js'
import { afterOf, receipt, resultStep, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { associations, endpointTypesOf, isBefore, type AssociationRecord, type Endpoint, type EndpointType, type EndpointTypes } from './definition.js'

// The four association operations ([[CORE62]] D12, D13): hand-written units over the generic helpers. Table names reach SQL
// only from the registry's definitions (D4): input types are looked up in the associable set and refused otherwise.

type Loose = Kysely<Record<string, Record<string, unknown>>>
const loose = (qc: QueryContext): Loose => qc.db as unknown as Loose
const A = (column: string) => sql.ref(`associations.${column}`)
const notFound = () => new ApiError(404, 'not_found', 'association not found')
const invalidReference = () => new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
const lower = (s: string) => s.toLowerCase()

const idParams = z.object({ id: z.uuid() })
const createBody = z.strictObject({ a_type: z.string().max(64), a_id: z.uuid(), b_type: z.string().max(64), b_id: z.uuid(), relation: z.literal('related_to').optional() })
const listQuery = z.object({ type: z.string().max(64), id: z.uuid(), neighbour_type: z.string().max(64).optional(), after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() })
const recordSchema = associations.record
export const listItem = z.object({ id: z.uuid(), relation: z.enum(['related_to']), neighbour_type: z.string(), neighbour_id: z.uuid(), created_by: z.uuid(), created_at: z.string() })
export type AssociationListItem = z.infer<typeof listItem>

/** The type's definition, or `400 validation_error` for an unknown or non-associable name. */
function endpointType(types: EndpointTypes, name: string, field: string): EndpointType {
  const found = types.get(name)
  if (!found) throw new ApiError(400, 'validation_error', `${field}: "${name}" is not an associable type (${[...types.keys()].sort().join(', ')})`)
  return found
}
const canRead = (env: PreparedEnv, t: EndpointType) => env.scopes.has(t.read)
/** `403 insufficient_scope` naming the endpoint type and the scope that is missing. */
function requireRead(env: PreparedEnv, t: EndpointType): void {
  if (!canRead(env, t)) throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(t.read)} to associate ${t.type}`)
}
/** The types the caller may read, in a stable order. */
export const readableTypes = (env: PreparedEnv, types: EndpointTypes): string[] => [...types.values()].filter((t) => canRead(env, t)).map((t) => t.type).sort()
const inTypes = (column: string, names: readonly string[]): Expression<SqlBool> =>
  names.length === 0 ? sql<SqlBool>`1 = 0` : sql<SqlBool>`${A(column)} in (${sql.join(names)})`

/** The one predicate of "this endpoint is a live record of this organisation", for the plan read and the commit guard alike. */
function liveEndpoint(env: PreparedEnv, t: EndpointType, id: string): Expression<SqlBool> {
  const table = (c: string) => sql.ref(`${t.type}.${c}`)
  const preds = [sql<SqlBool>`${table('id')} = ${id}`]
  if (t.hasOrganization) preds.push(sql<SqlBool>`${table('organization_id')} = ${env.organizationId}`)
  if (t.softDeletes) preds.push(sql<SqlBool>`${table('deleted_at')} is null`)
  return sql<SqlBool>`exists (select 1 from ${sql.table(t.type)} where ${sql.join(preds, sql` and `)})`
}

/** `associations.create`: canonicalises the pair, checks both endpoints in the plan and again at commit (D4, D12). */
export function createAssociation(env: PreparedEnv, types: EndpointTypes, input: unknown): PreparedOperation<AssociationRecord> {
  const body = parseInput(createBody, input) as { a_type: string; a_id: string; b_type: string; b_id: string }
  const typeA = endpointType(types, body.a_type, 'a_type')
  const typeB = endpointType(types, body.b_type, 'b_type')
  requireRead(env, typeA)
  requireRead(env, typeB)
  const x: Endpoint = { type: typeA.type, id: lower(body.a_id) }
  const y: Endpoint = { type: typeB.type, id: lower(body.b_id) }
  if (x.type === y.type && x.id === y.id) throw new ApiError(400, 'self_association', 'a record cannot be associated with itself')
  const [lo, hi] = isBefore(x, y) ? [x, y] : [y, x]
  const loType = types.get(lo.type)!
  const hiType = types.get(hi.type)!
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const exists = (qc: QueryContext, t: EndpointType, e: Endpoint) => readMaybe(loose(qc).selectNoFrom(sql<number>`1`.as('one')).where(liveEndpoint(env, t, e.id)))
  const pair = (qc: QueryContext) =>
    loose(qc)
      .selectFrom('associations')
      .select(sql<string>`${A('id')}`.as('id'))
      .where(sql<SqlBool>`${A('organization_id')} = ${env.organizationId}`)
      .where(sql<SqlBool>`${A('a_type')} = ${lo.type} and ${A('a_id')} = ${lo.id} and ${A('b_type')} = ${hi.type} and ${A('b_id')} = ${hi.id} and ${A('relation')} = 'related_to'`)
      .where(sql<SqlBool>`${A('deleted_at')} is null`)
  return defineOperation<AssociationRecord>({
    name: 'associations.create',
    mutates: true,
    reads: (qc) => ({ lo: exists(qc, loType, lo), hi: exists(qc, hiType, hi), dup: readMaybe(pair(qc).limit(1)) }),
    build: (found, qc) => {
      if (found.maybe('lo') === null || found.maybe('hi') === null) throw invalidReference()
      const dup = found.maybe('dup')
      if (dup) throw new ApiError(409, 'association_exists', `an association between these records already exists (${String(dup.id)})`)
      const cols: Array<[string, Parameters<typeof bind>[1], string]> = [
        ['id', 'uuid', id], ['organization_id', 'uuid', env.organizationId], ['created_by', 'uuid', env.actor.id], ['created_at', 'timestamp', at], ['updated_at', 'timestamp', at],
        ['a_type', 'text', lo.type], ['a_id', 'uuid', lo.id], ['b_type', 'text', hi.type], ['b_id', 'uuid', hi.id], ['relation', 'text', 'related_to'],
      ]
      // The commit-time assertion (D4): both endpoints must still be live when the batch runs, or the insert applies to no row and the unit aborts.
      const insert = loose(qc)
        .insertInto('associations')
        .columns(cols.map(([c]) => c))
        .expression(loose(qc).selectNoFrom(cols.map(([c, kind, v]) => bind(qc, kind, v).as(c))).where(liveEndpoint(env, loType, lo.id)).where(liveEndpoint(env, hiType, hi.id)))
      return unit({
        steps: [
          step(insert, 'first-mutation', { expect: 'affected' }),
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'association.created', resourceType: 'association', resourceId: id, before: null, after: afterOf(associations) }), 'first-event'),
          resultStep(associations, qc, env, id, eventId),
        ],
        events: [receipt(associations, eventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('associations.create')
          return toRecord(associations, rows[0]!) as AssociationRecord
        },
      })
    },
  })
}

/** The edges the caller may see: both endpoint types readable (D13: otherwise the edge is as good as absent). */
const visible = (env: PreparedEnv, types: EndpointTypes) => {
  const readable = readableTypes(env, types)
  return [inTypes('a_type', readable), inTypes('b_type', readable)]
}

export function getAssociation(env: PreparedEnv, types: EndpointTypes, rawId: string): PreparedOperation<AssociationRecord> {
  const id = lower(rawId)
  return defineOperation<AssociationRecord>({
    name: 'associations.get',
    mutates: false,
    reads: (qc) => {
      let q = selectRecord(associations, qc, env, id)
      for (const w of visible(env, types)) q = q.where(w)
      return { row: readMaybe(q) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) throw notFound()
          return toRecord(associations, row) as AssociationRecord
        },
      }),
  })
}

export function deleteAssociation(env: PreparedEnv, types: EndpointTypes, rawId: string): PreparedOperation<void> {
  const id = lower(rawId)
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<void>({
    name: 'associations.delete',
    mutates: true,
    reads: (qc) => {
      let q = selectRecord(associations, qc, env, id).select(ts.exact(qc, 'associations.updated_at').as('__stamp'))
      for (const w of visible(env, types)) q = q.where(w)
      return { before: readMaybe(q) }
    },
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound()
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(associations, rest as never)
      const update = loose(qc)
        .updateTable('associations')
        .set({ deleted_at: at, updated_at: at })
        .where(sql<SqlBool>`${A('id')} = ${id}`)
        .where(sql<SqlBool>`${A('organization_id')} = ${env.organizationId}`)
        .where(sql<SqlBool>`${A('deleted_at')} is null`)
        .where(sql<SqlBool>`${ts.exact(qc, 'associations.updated_at')} = ${String(__stamp)}`)
      const proof = loose(qc).selectNoFrom(sql<number>`1`.as('applied')).where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: env.actor.id, type: 'association.deleted', resourceType: 'association', resourceId: id, before, after: null }), 'first-event'),
          step(proof, 'result'),
        ],
        events: [receipt(associations, eventId, 'deleted', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('associations.delete')
        },
      })
    },
  })
}

/**
 * The live edges of the anchor, oriented from it ([[CORE62]] D12), whose neighbour type is one of `readable` (D13): filtered in SQL,
 * so a page or a cap counts only edges the caller may see. Ordering and limits are the caller's.
 */
export function orientedEdges(qc: QueryContext, env: PreparedEnv, anchor: Endpoint, readable: readonly string[]) {
  const onA = sql<SqlBool>`${A('a_type')} = ${anchor.type} and ${A('a_id')} = ${anchor.id}`
  const mine = sql`(${A('a_type')} = ${anchor.type} and ${A('a_id')} = ${anchor.id})`
  return loose(qc)
    .selectFrom('associations')
    .select([
      ...recordColumns(qc, 'associations', ['id', 'relation', 'created_by', 'created_at']),
      sql<string>`case when ${mine} then ${A('b_type')} else ${A('a_type')} end`.as('neighbour_type'),
      sql<string>`case when ${mine} then ${A('b_id')} else ${A('a_id')} end`.as('neighbour_id'),
    ])
    .where(sql<SqlBool>`${A('organization_id')} = ${env.organizationId}`)
    .where(sql<SqlBool>`${A('deleted_at')} is null`)
    .where(sql<SqlBool>`((${onA} and ${inTypes('b_type', readable)}) or (${A('b_type')} = ${anchor.type} and ${A('b_id')} = ${anchor.id} and ${inTypes('a_type', readable)}))`)
}

/** `associations.list`: the anchor's edges oriented from the anchor, neighbour types the caller cannot read filtered in SQL, paged by association id. */
export function listAssociations(env: PreparedEnv, types: EndpointTypes, input: unknown): PreparedOperation<{ data: AssociationListItem[]; next_cursor: string | null }> {
  const q = parseInput(listQuery, input) as { type: string; id: string; neighbour_type?: string; after?: string; limit?: number }
  const anchorType = endpointType(types, q.type, 'type')
  if (q.neighbour_type !== undefined) endpointType(types, q.neighbour_type, 'neighbour_type')
  requireRead(env, anchorType)
  const anchor: Endpoint = { type: anchorType.type, id: lower(q.id) }
  const limit = q.limit ?? 50
  const after = q.after === undefined ? null : lower(q.after)
  const readable = readableTypes(env, types).filter((t) => q.neighbour_type === undefined || t === q.neighbour_type)
  return defineOperation({
    name: 'associations.list',
    mutates: false,
    reads: (qc) => {
      let query = orientedEdges(qc, env, anchor, readable)
      if (after) query = query.where(sql<SqlBool>`${A('id')} > ${after}`)
      return { page: readAll(query.orderBy(A('id')).limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = found.all('page')
          const page = rows.slice(0, limit)
          return {
            data: page.map((r) => listItem.parse({ ...r, created_at: codecs.timestamp.readNullable(r.created_at) ?? r.created_at })),
            next_cursor: rows.length > limit ? (page[page.length - 1]!.id as string) : null,
          }
        },
      }),
  })
}

/**
 * The four operations. `defs` is read lazily at `prepare`, so the associable set is whatever the registry that owns these
 * operations holds (a registry without a table simply has fewer types).
 */
export function associationOperations(defs: () => readonly AnyResource[]): TenantOperation[] {
  const types = () => endpointTypesOf(defs())
  const base = { kind: 'tenant' as const, surface: 'api' as const, validation: 'handler' as const, tags: ['associations'] }
  return [
    {
      ...base,
      name: 'associations.list',
      summary: 'List the associations of a record',
      description: 'The records linked to the anchor (`type`, `id`), oriented from the anchor, pages ascending by association id. Neighbours of a type the caller cannot read are omitted.',
      method: 'get',
      path: '/associations',
      scope: { resource: 'associations', action: 'read' },
      request: { query: listQuery },
      response: { status: 200, schema: z.object({ data: z.array(listItem), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => listAssociations(env, types(), input.query),
    },
    {
      ...base,
      name: 'associations.get',
      summary: 'Get an association',
      method: 'get',
      path: '/associations/{id}',
      scope: { resource: 'associations', action: 'read' },
      request: { params: idParams },
      response: { status: 200, schema: recordSchema },
      prepare: (env, input) => getAssociation(env, types(), input.params.id as string),
    },
    {
      ...base,
      name: 'associations.create',
      summary: 'Link two records',
      description: 'Links two live records of associable tables. The pair may be given in either order; the response shows the canonical order.',
      method: 'post',
      path: '/associations',
      scope: { resource: 'associations', action: 'write' },
      request: { body: createBody },
      response: { status: 201, schema: recordSchema },
      prepare: (env, input) => createAssociation(env, types(), input.body),
    },
    {
      ...base,
      name: 'associations.delete',
      summary: 'Unlink two records',
      method: 'delete',
      path: '/associations/{id}',
      scope: { resource: 'associations', action: 'write' },
      request: { params: idParams },
      response: { status: 204 },
      prepare: (env, input) => deleteAssociation(env, types(), input.params.id as string),
    },
  ]
}
