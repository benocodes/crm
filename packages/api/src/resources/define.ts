import { z } from 'zod'
import type { Database } from '@vault/db'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'

export type Reference = { table: keyof Database & string; live?: boolean }
export type Filter = {
  schema: z.ZodType
  normalize?: (value: unknown, filters: Record<string, unknown>) => unknown
}
export type CrudAction = 'list' | 'get' | 'create' | 'update' | 'delete'
export const CRUD_ACTIONS: readonly CrudAction[] = ['list', 'get', 'create', 'update', 'delete']
export interface ResourceDefinition<R extends { id: string } = { id: string }> {
  name: string
  eventName: string
  table: keyof Database & string
  record: z.ZodObject
  create?: z.ZodObject
  update?: z.ZodObject
  operations?: readonly CrudAction[]
  scopeResource?: string
  /** Extra equality conditions for list, get, update and delete (not create); null = none. [[API7]]. */
  rowFilter?: (ctx: ServiceContext) => Record<string, unknown> | null
  agentWritable?: readonly string[]
  filters?: Record<string, Filter>
  references?: Record<string, Reference>
  inputSchema?: (ctx: ServiceContext, op: 'create' | 'update') => z.ZodObject
  beforeWrite?: (
    ctx: ServiceContext,
    args: { op: 'create' | 'update'; input: Record<string, unknown>; before: R | null },
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
  overrides?: {
    create?: (
      ctx: ServiceContext,
      input: Record<string, unknown>,
      generic: (input: Record<string, unknown>) => Promise<R>,
    ) => Promise<R>
    delete?: (ctx: ServiceContext, id: string, generic: (id: string) => Promise<void>) => Promise<void>
  }
}

export const crudActions = (def: ResourceDefinition<any>): readonly CrudAction[] => def.operations ?? CRUD_ACTIONS
export const scopeResourceOf = (def: ResourceDefinition<any>): string => def.scopeResource ?? def.name
export const resourcePath = (def: ResourceDefinition<any>): string => '/' + def.name.replaceAll('_', '-')
export const readColumns = (def: ResourceDefinition<any>): string[] => Object.keys(def.record.shape)

const NAME = /^[a-z][a-z0-9_]*$/

/** Validates a definition at module load. Throws a plain Error: this is a programming mistake. */
export function defineResource<R extends { id: string }>(def: ResourceDefinition<R>): ResourceDefinition<R> {
  if (!NAME.test(def.name)) throw new Error(`invalid resource name "${def.name}" (must match ${NAME})`)
  for (const schema of [def.record, def.create, def.update]) {
    if (schema && 'custom' in schema.shape) throw new Error(`"custom" is a reserved field name (${def.name})`)
  }
  if (def.scopeResource !== undefined && !NAME.test(def.scopeResource)) {
    throw new Error(`invalid scopeResource "${def.scopeResource}" (${def.name})`)
  }
  const ops = crudActions(def)
  if (ops.length === 0 || new Set(ops).size !== ops.length || ops.some((o) => !CRUD_ACTIONS.includes(o))) {
    throw new Error(`invalid operations (${def.name})`)
  }
  if (ops.includes('create') && !def.create) throw new Error(`create schema required (${def.name})`)
  if (ops.includes('update') && !def.update) throw new Error(`update schema required (${def.name})`)
  if (def.agentWritable) {
    const known = new Set([...Object.keys(def.create?.shape ?? {}), ...Object.keys(def.update?.shape ?? {})])
    for (const f of def.agentWritable) {
      if (!known.has(f)) throw new Error(`agentWritable names unknown field "${f}" (${def.name})`)
    }
  }
  return def
}

/** Converts Date values to ISO strings, then parses with the read schema (which strips other columns). */
export function toRecord<R extends { id: string }>(def: ResourceDefinition<R>, row: Record<string, unknown>): R {
  const converted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) converted[k] = v instanceof Date ? v.toISOString() : v
  return def.record.parse(converted) as R
}

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join('; ')

/** Parses `input` with a schema, turning a zod failure into `validation_error`. */
export function parseInput(schema: z.ZodType, input: unknown): Record<string, unknown> {
  const r = schema.safeParse(input)
  if (!r.success) throw new ApiError(400, 'validation_error', issues(r.error))
  return r.data as Record<string, unknown>
}

const LIMIT = z.coerce.number().int().min(1).max(200)

export function parseListQuery(
  def: ResourceDefinition<any>,
  raw: { after?: unknown; limit?: unknown; filters?: Record<string, string> },
): { after: string | null; limit: number; filters: Record<string, unknown> } {
  let limit = 50
  if (raw.limit !== undefined) {
    const l = LIMIT.safeParse(raw.limit)
    if (!l.success) throw new ApiError(400, 'validation_error', `limit: ${issues(l.error)}`)
    limit = l.data
  }
  let after: string | null = null
  if (raw.after !== undefined && raw.after !== null) {
    const a = z.uuid().safeParse(raw.after)
    if (!a.success) throw new ApiError(400, 'validation_error', 'after must be a UUID')
    after = a.data
  }
  const declared = def.filters ?? {}
  const parsed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw.filters ?? {})) {
    const filter = declared[key]
    if (!filter) throw new ApiError(400, 'validation_error', `unknown filter: ${key}`)
    const r = filter.schema.safeParse(value)
    if (!r.success) throw new ApiError(400, 'validation_error', `filter ${key}: ${issues(r.error)}`)
    parsed[key] = r.data
  }
  const filters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const normalize = declared[key]!.normalize
    if (!normalize) {
      filters[key] = value
      continue
    }
    try {
      filters[key] = normalize(value, parsed)
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(400, 'validation_error', `filter ${key}: ${err instanceof Error ? err.message : 'invalid'}`)
    }
  }
  return { after, limit, filters }
}
