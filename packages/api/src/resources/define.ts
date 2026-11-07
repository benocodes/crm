import { z } from 'zod'
import { ApiError } from '../errors.js'
import { SORT_ORDERS, decodeCursor, type SortKind, type SortOrder, type SortRequest } from './sort-cursor.js'

export type Filter = {
  schema: z.ZodType
  normalize?: (value: unknown, filters: Record<string, unknown>) => unknown
}
export type CrudAction = 'list' | 'get' | 'create' | 'update' | 'delete'
export const CRUD_ACTIONS: readonly CrudAction[] = ['list', 'get', 'create', 'update', 'delete']
type Named = { name: string; operations?: readonly CrudAction[]; scopeResource?: string }
export const crudActions = (def: Named): readonly CrudAction[] => def.operations ?? CRUD_ACTIONS
export const scopeResourceOf = (def: Named): string => def.scopeResource ?? def.name
export const resourcePath = (def: Named): string => '/' + def.name.replaceAll('_', '-')
const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join('; ')

/** Parses `input` with a schema, turning a zod failure into `validation_error`. */
export function parseInput(schema: z.ZodType, input: unknown): Record<string, unknown> {
  const r = schema.safeParse(input)
  if (!r.success) throw new ApiError(400, 'validation_error', issues(r.error))
  return r.data as Record<string, unknown>
}

const LIMIT = z.coerce.number().int().min(1).max(200)

/**
 * What parseListQuery needs of a definition. `sorts` names derived fields ([[CORE133]] D8): only a list that declares them takes `sort` and
 * `order`; on any other list those are not parameters, so `sort` is an unknown filter as it always was.
 */
type ListDef = { filters?: Record<string, Filter>; joinFilters?: Record<string, Filter>; sorts?: readonly string[]; sortKinds?: Readonly<Record<string, SortKind>>; derived?: Record<string, { kind: string }> }

export function parseListQuery(
  def: ListDef,
  raw: { after?: unknown; limit?: unknown; sort?: unknown; order?: unknown; filters?: Record<string, string> },
): { after: string | null; limit: number; filters: Record<string, unknown>; sort: SortRequest | null } {
  let limit = 50
  if (raw.limit !== undefined) {
    const l = LIMIT.safeParse(raw.limit)
    if (!l.success) throw new ApiError(400, 'validation_error', `limit: ${issues(l.error)}`)
    limit = l.data
  }
  const sorts = def.sorts ?? []
  for (const key of ['sort', 'order'] as const) if (sorts.length === 0 && raw[key] !== undefined) throw new ApiError(400, 'validation_error', `unknown filter: ${key}`)
  let sort: SortRequest | null = null
  if (raw.sort !== undefined) {
    if (typeof raw.sort !== 'string' || !sorts.includes(raw.sort)) throw new ApiError(400, 'validation_error', `sort must be one of: ${sorts.join(', ')}`)
    let order: SortOrder = 'asc'
    if (raw.order !== undefined) {
      if (typeof raw.order !== 'string' || !(SORT_ORDERS as readonly string[]).includes(raw.order)) throw new ApiError(400, 'validation_error', `order must be one of: ${SORT_ORDERS.join(', ')}`)
      order = raw.order as SortOrder
    }
    const kind = (def.sortKinds?.[raw.sort] ?? def.derived?.[raw.sort]?.kind) as SortKind
    sort = { field: raw.sort, order, kind, position: raw.after === undefined || raw.after === null ? null : decodeCursor(raw.after, raw.sort, order, kind) }
  } else if (raw.order !== undefined) throw new ApiError(400, 'validation_error', 'order needs sort')
  let after: string | null = null
  if (sort === null && raw.after !== undefined && raw.after !== null) {
    const a = z.uuid().safeParse(raw.after)
    if (!a.success) throw new ApiError(400, 'validation_error', sorts.length > 0 ? 'after must be a UUID (a sorted cursor needs the sort and order it came from)' : 'after must be a UUID')
    after = a.data
  }
  const declared = { ...(def.filters ?? {}), ...(def.joinFilters ?? {}) }
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
  return { after, limit, filters, sort }
}
