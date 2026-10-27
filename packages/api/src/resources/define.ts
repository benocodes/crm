import { z } from 'zod'
import { ApiError } from '../errors.js'

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

export function parseListQuery(
  def: { filters?: Record<string, Filter> },
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
