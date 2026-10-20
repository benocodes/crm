import { sql, type Transaction } from 'kysely'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { parseInput, parseListQuery, readColumns, toRecord, type ResourceDefinition } from './define.js'

export type ListResult<R> = { data: R[]; next_cursor: string | null }
type ListQuery = { after?: unknown; limit?: unknown; filters?: Record<string, string> }
type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The layer addresses tables by name from the definition, so it works on an untyped transaction. The
// cast is confined to this one helper (api-routes: never type a wrapper callback's `trx` as `any`).
const db = (ctx: ServiceContext) => ctx.trx as unknown as Transaction<any>

/** Adds the definition's row filter (if any, for this actor) as equality conditions. */
function filtered<Q extends { where(col: string, op: '=', value: unknown): Q }>(ctx: ServiceContext, def: ResourceDefinition<any>, q: Q): Q {
  for (const [col, value] of Object.entries(def.rowFilter?.(ctx) ?? {})) q = q.where(col, '=', value)
  return q
}

/** The live-row condition, unless the table has no soft delete (P1). */
function live<Q extends { where(col: string, op: 'is', value: null): Q }>(def: ResourceDefinition<any>, q: Q): Q {
  return def.softDelete === false ? q : q.where('deleted_at', 'is', null)
}

const notFound = (def: ResourceDefinition<any>) => new ApiError(404, 'not_found', `${def.eventName} not found`)

function assertUuid(def: ResourceDefinition<any>, id: string): void {
  if (!UUID.test(id)) throw notFound(def)
}

function checkAgentFields(ctx: ServiceContext, def: ResourceDefinition<any>, input: Row): void {
  if (ctx.actor.kind !== 'agent') return
  const writable = new Set(def.agentWritable ?? [...Object.keys(def.create?.shape ?? {}), ...Object.keys(def.update?.shape ?? {})])
  const denied = Object.keys(input).filter((k) => !writable.has(k))
  if (denied.length > 0) throw new ApiError(400, 'field_not_writable', `agents may not write: ${denied.join(', ')}`)
}

async function checkReferences(ctx: ServiceContext, def: ResourceDefinition<any>, input: Row): Promise<void> {
  for (const [key, ref] of Object.entries(def.references ?? {})) {
    const value = input[key]
    if (value === undefined || value === null) continue
    const invalid = new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
    if (typeof value !== 'string' || !UUID.test(value)) throw invalid
    let q = db(ctx).selectFrom(ref.table).select(sql<number>`1`.as('one')).where('id', '=', value)
    if (ref.live) q = q.where('deleted_at', 'is', null)
    if (!(await q.executeTakeFirst())) throw invalid
  }
}

async function lockLive(ctx: ServiceContext, def: ResourceDefinition<any>, id: string): Promise<Row> {
  assertUuid(def, id)
  const row = await filtered(
    ctx,
    def,
    live(def, db(ctx).selectFrom(def.table).select(readColumns(def)).where('id', '=', id)),
  )
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound(def)
  return row as Row
}

export async function emitResourceEvent<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  action: string,
  before: R | null,
  after: R | null,
  resourceId: string,
): Promise<void> {
  await ctx.emit({
    type: `${def.eventName}.${action}`,
    resourceType: def.eventName,
    resourceId,
    before: before as Row | null,
    after: after as Row | null,
  })
}

export async function listResource<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  query: ListQuery,
): Promise<ListResult<R>> {
  const { after, limit, filters } = parseListQuery(def, query)
  let q = filtered(ctx, def, live(def, db(ctx).selectFrom(def.table).select(readColumns(def))))
  if (after) q = q.where('id', '>', after)
  for (const [key, value] of Object.entries(filters)) q = q.where(key, '=', value)
  const rows = (await q.orderBy('id').limit(limit + 1).execute()) as Row[]
  const page = rows.slice(0, limit)
  return {
    data: page.map((r) => toRecord(def, r)),
    next_cursor: rows.length > limit ? (page[page.length - 1]!.id as string) : null,
  }
}

export async function getResource<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  id: string,
): Promise<R> {
  assertUuid(def, id)
  const row = await filtered(
    ctx,
    def,
    live(def, db(ctx).selectFrom(def.table).select(readColumns(def)).where('id', '=', id)),
  ).executeTakeFirst()
  if (!row) throw notFound(def)
  return toRecord(def, row as Row)
}

export async function createResource<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  input: unknown,
): Promise<R> {
  const schema = def.inputSchema?.(ctx, 'create') ?? def.create
  if (!schema) throw new Error(`${def.name} has no create schema`)
  const parsed = parseInput(schema, input)
  checkAgentFields(ctx, def, parsed)
  await checkReferences(ctx, def, parsed)

  const generic = async (values: Row): Promise<R> => {
    const written = def.beforeWrite ? await def.beforeWrite(ctx, { op: 'create', input: values, before: null }) : values
    const row = await db(ctx)
      .insertInto(def.table)
      .values({ ...written, organization_id: ctx.organizationId, created_by: ctx.actor.id })
      .returning(readColumns(def))
      .executeTakeFirstOrThrow()
    const record = toRecord(def, row as Row)
    await emitResourceEvent(ctx, def, 'created', null, record, record.id)
    return record
  }
  return def.overrides?.create ? def.overrides.create(ctx, parsed, generic) : generic(parsed)
}

export async function updateResource<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  id: string,
  input: unknown,
): Promise<R> {
  const schema = def.inputSchema?.(ctx, 'update') ?? def.update
  if (!schema) throw new Error(`${def.name} has no update schema`)
  const parsed = parseInput(schema, input)
  checkAgentFields(ctx, def, parsed)
  const generic = async (targetId: string, values: Row): Promise<R> => {
    const current = await lockLive(ctx, def, targetId)
    const before = toRecord(def, current)
    if (Object.keys(values).length === 0) return before
    await checkReferences(ctx, def, values)
    const written = def.beforeWrite ? await def.beforeWrite(ctx, { op: 'update', input: values, before }) : values
    const row = await db(ctx).updateTable(def.table).set(written).where('id', '=', targetId).returning(readColumns(def)).executeTakeFirstOrThrow()
    const after = toRecord(def, row as Row)
    await emitResourceEvent(ctx, def, 'updated', before, after, targetId)
    return after
  }
  return def.overrides?.update ? def.overrides.update(ctx, id, parsed, generic) : generic(id, parsed)
}

export async function deleteResource<R extends { id: string }>(
  ctx: ServiceContext,
  def: ResourceDefinition<R>,
  id: string,
): Promise<void> {
  const generic = async (targetId: string): Promise<void> => {
    const before = toRecord(def, await lockLive(ctx, def, targetId))
    await db(ctx).updateTable(def.table).set({ deleted_at: sql`now()` }).where('id', '=', targetId).execute()
    await emitResourceEvent(ctx, def, 'deleted', before, null, targetId)
  }
  if (def.overrides?.delete) await def.overrides.delete(ctx, id, generic)
  else await generic(id)
}
