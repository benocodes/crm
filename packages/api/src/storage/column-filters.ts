import { sql, type Expression, type SqlBool } from 'kysely'
import type { z } from 'zod'
import { COLUMN_KINDS, bind, codecs, jsonRows, type ColumnKind, type QueryContext } from '@vault/storage'
import { ApiError } from '../errors.js'
import type { PreparedResource } from './definition.js'

// [[CORE199]] D2-D6, built by [[CORE200]]: the column filter grammar (`[not.]<operator>.<operand>`, or a bare value = eq), the operators of each
// column kind, the operand parsers, the pattern translators and the SQL, and `withColumnFilters`, the explicit opt-in that makes every filterable
// column of a list a filter. Parsing is pure and synchronous (no query, no clock), like every definition extension.
//
// A parsed filter is one `Condition`. A list holds one condition per field today (`Record<field, Condition>`); a later `or=(...)`/`and=(...)`
// group is a list of Conditions joined by an operator, which `compileCondition` already composes as an expression, so grouping adds a layer above
// the parser and changes neither the grammar of a single condition nor its compiled form.

export const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike'] as const
export type Operator = (typeof OPERATORS)[number]
/** The column kinds a filter can take ([[CORE199]] D3): json and string_array columns are not filterable. */
export type FilterKind = 'uuid' | 'text' | 'integer' | 'timestamp' | 'boolean'
export type Operand = string | number | boolean | null
/** One parsed condition: `value` is the list for `in`, `null`/`true`/`false` for `is`, the pattern text for `like`/`ilike`, else one operand. */
export type Condition = { readonly not: boolean; readonly op: Operator; readonly value: Operand | readonly Operand[] }

export type ColumnFilterSpec = {
  readonly kind: FilterKind
  readonly nullable: boolean
  /** Validates each scalar operand (not patterns), after it parsed as its kind. */
  readonly schema?: { safeParse(v: unknown): { success: boolean; error?: { issues: readonly { message: string }[] } } }
  /** Applied to each scalar operand (`eq`, `neq`, comparisons, `in` items), never to a pattern. */
  readonly normalize?: (value: unknown, filters: Record<string, unknown>) => unknown
  /** A sentence appended to the generated description. */
  readonly note?: string
}

const FILTERABLE: ReadonlySet<string> = new Set<FilterKind>(['uuid', 'text', 'integer', 'timestamp', 'boolean'])
const COMPARISONS: readonly Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']
const BY_KIND: Record<FilterKind, readonly Operator[]> = {
  uuid: ['eq', 'neq', 'in'],
  text: [...COMPARISONS, 'like', 'ilike'],
  integer: COMPARISONS,
  timestamp: COMPARISONS,
  boolean: ['eq', 'neq'],
}
const MAX_TEXT = 1000
const MAX_PATTERN = 200
const MAX_IN = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const OP_PREFIX = new RegExp(`^(${OPERATORS.join('|')})\\.(.*)$`, 's')
const NOT = 'not.'

/** The operators a kind offers, in the table's order; `is` is added for a nullable field ([[CORE199]] D3). */
export function operatorsFor(kind: FilterKind, nullable: boolean): readonly Operator[] {
  return OPERATORS.filter((op) => (op === 'is' ? nullable : BY_KIND[kind].includes(op)))
}

const refusal = (name: string, message: string) => new ApiError(400, 'validation_error', `filter ${name}: ${message}`)
const shown = (operand: string): string => JSON.stringify(operand.length > 40 ? `${operand.slice(0, 40)}...` : operand)

/** An operand as its kind: the stored form (lower-case UUID, safe integer, UTC ISO text). */
function scalar(name: string, kind: FilterKind, operand: string): Operand {
  switch (kind) {
    case 'uuid':
      if (!UUID.test(operand)) throw refusal(name, `${shown(operand)} is not a UUID`)
      return operand.toLowerCase()
    case 'integer': {
      const n = /^-?\d+$/.test(operand) ? Number(operand) : Number.NaN
      if (!Number.isSafeInteger(n)) throw refusal(name, `${shown(operand)} is not a safe integer`)
      return n
    }
    case 'boolean':
      if (operand !== 'true' && operand !== 'false') throw refusal(name, `${shown(operand)} is not true or false`)
      return operand === 'true'
    case 'timestamp':
      try {
        return codecs.timestamp.write(DATE.test(operand) ? `${operand}T00:00:00Z` : operand)
      } catch {
        throw refusal(name, `${shown(operand)} is not an ISO 8601 date or date-time with an offset`)
      }
    case 'text':
      if (operand.length > MAX_TEXT) throw refusal(name, `a text operand is at most ${MAX_TEXT} characters`)
      return operand
  }
}

const BAD_QUOTING = 'in has bad quoting: an item containing , ( ) or " must be double-quoted, with \\" for a quote'

/** `(a,"b,c",d)`: PostgREST's list. Items containing `,` `(` `)` or `"` are double-quoted, `\"` and `\\` escape inside quotes; unquoted items are trimmed. */
function parseList(name: string, text: string): string[] {
  if (!text.startsWith('(') || !text.endsWith(')') || text.length < 2) throw refusal(name, 'in needs a parenthesised list, as in in.(a,b)')
  const body = text.slice(1, -1)
  if (body.trim() === '') throw refusal(name, 'in needs at least 1 item')
  const items: string[] = []
  let i = 0
  for (;;) {
    while (body[i] === ' ') i++
    let item = ''
    if (body[i] === '"') {
      i++
      for (;;) {
        const ch = body[i]
        if (ch === undefined) throw refusal(name, BAD_QUOTING)
        if (ch === '\\' && (body[i + 1] === '"' || body[i + 1] === '\\')) {
          item += body[i + 1]
          i += 2
        } else if (ch === '"') {
          i++
          break
        } else {
          item += ch
          i++
        }
      }
      while (body[i] === ' ') i++
      if (i < body.length && body[i] !== ',') throw refusal(name, BAD_QUOTING)
    } else {
      const start = i
      while (i < body.length && body[i] !== ',') {
        if (body[i] === '"' || body[i] === '(' || body[i] === ')') throw refusal(name, BAD_QUOTING)
        i++
      }
      item = body.slice(start, i).trim()
      if (item === '') throw refusal(name, 'in has an empty item')
    }
    items.push(item)
    if (items.length > MAX_IN) throw refusal(name, `in takes at most ${MAX_IN} items (got ${countItems(body)})`)
    if (i >= body.length) return items
    i++ // the comma
    if (i >= body.length) throw refusal(name, 'in has an empty item')
  }
}

/** The item count of an over-long list, for the message only (quote-aware, so it agrees with the parser). */
function countItems(body: string): number {
  let n = 1
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && quoted) i++
    else if (body[i] === '"') quoted = !quoted
    else if (body[i] === ',' && !quoted) n++
  }
  return n
}

/** Parses one filter value against the field's kind: the grammar, the operator's availability, each operand, then the field's options. */
export function parseCondition(name: string, spec: ColumnFilterSpec, raw: string): Condition {
  let rest = raw
  let not = false
  if (raw.startsWith(NOT)) {
    not = true
    rest = raw.slice(NOT.length)
    if (!OP_PREFIX.test(rest)) throw refusal(name, 'not. needs an operator after it, as in not.eq.x')
  }
  const m = OP_PREFIX.exec(rest)
  const op: Operator = m ? (m[1] as Operator) : 'eq'
  const operand = m ? m[2]! : raw
  const available = operatorsFor(spec.kind, spec.nullable)
  if (!available.includes(op)) throw refusal(name, `${op} is not available for ${spec.kind} (available: ${available.join(', ')})`)
  const each = (text: string): Operand => {
    let v = scalar(name, spec.kind, text)
    if (spec.schema) {
      const r = spec.schema.safeParse(v)
      if (!r.success) throw refusal(name, (r.error?.issues ?? []).map((i) => i.message).join('; ') || 'invalid')
    }
    if (spec.normalize) {
      try {
        v = spec.normalize(v, {}) as Operand
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw refusal(name, err instanceof Error ? err.message : 'invalid')
      }
    }
    return v
  }
  switch (op) {
    case 'in':
      return { not, op, value: parseList(name, operand).map(each) }
    case 'is':
      if (operand === 'null') return { not, op, value: null }
      if (operand === 'true' || operand === 'false') {
        if (spec.kind !== 'boolean') throw refusal(name, 'is.true and is.false are only for boolean fields')
        return { not, op, value: operand === 'true' }
      }
      throw refusal(name, 'is takes null, true or false')
    case 'like':
    case 'ilike':
      if (operand.length > MAX_PATTERN) throw refusal(name, `a pattern is at most ${MAX_PATTERN} characters`)
      return { not, op, value: operand }
    default:
      return { not, op, value: each(operand) }
  }
}

/** [[CORE199]] D4: the operand's `*` is the wildcard of `ilike`; `%`, `_` and the escape character are literal (LIKE ... ESCAPE '\'). */
export const likePattern = (p: string): string => p.replace(/[\\%_*]/g, (c) => (c === '*' ? '%' : `\\${c}`))
/** [[CORE199]] D4: the operand's `*` is the wildcard of `like` (GLOB); `?`, `[` and `]` are bracketed to match themselves. */
export const globPattern = (p: string): string => p.replace(/[?[\]]/g, (c) => `[${c}]`)

const ESCAPE = sql.raw("escape '\\'")
const COMPARATORS = { eq: sql.raw('='), neq: sql.raw('<>'), gt: sql.raw('>'), gte: sql.raw('>='), lt: sql.raw('<'), lte: sql.raw('<=') } as const

/**
 * The predicate for one condition on `column`. SQL null semantics ([[CORE199]] D3): a comparison, `in` and `not.` never match a null; only `is.null`
 * does (and `not.is.null` is its complement). `ilike` is `LIKE` on D1 (ASCII case folding only) and `ILIKE` on Postgres, `like` is `GLOB` on D1 (case
 * sensitive) and `LIKE` on Postgres, each with the same literal treatment of every character but `*`.
 */
export function compileCondition(qc: QueryContext, column: Expression<unknown>, kind: FilterKind, c: Condition): Expression<SqlBool> {
  const bound = (v: unknown) => bind(qc, kind as ColumnKind, v as string | number | boolean | null)
  const d1 = qc.dialect === 'd1'
  let e: Expression<SqlBool>
  switch (c.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      e = sql<SqlBool>`${column} ${COMPARATORS[c.op]} ${bound(c.value)}`
      break
    case 'in': {
      const rows = (c.value as readonly Operand[]).map((value) => ({ value }))
      e = sql<SqlBool>`${column} in (select ${sql.ref('s.value')} from ${jsonRows(qc, 's', { value: kind as ColumnKind }, rows)})`
      break
    }
    case 'is':
      if (c.value === null) return c.not ? sql<SqlBool>`${column} is not null` : sql<SqlBool>`${column} is null`
      e = sql<SqlBool>`${column} = ${bound(c.value)}`
      break
    case 'like':
      e = d1 ? sql<SqlBool>`${column} glob ${globPattern(c.value as string)}` : sql<SqlBool>`${column} like ${bind(qc, 'text', likePattern(c.value as string))} ${ESCAPE}`
      break
    case 'ilike':
      e = sql<SqlBool>`${column} ${sql.raw(d1 ? 'like' : 'ilike')} ${bind(qc, 'text', likePattern(c.value as string))} ${ESCAPE}`
      break
  }
  return c.not ? sql<SqlBool>`not (${e})` : e
}

const EXAMPLES: Record<FilterKind, (name: string) => string> = {
  uuid: (n) => `${n}=in.(<uuid>,<uuid>)`,
  text: (n) => `${n}=ilike.*acme*`,
  integer: (n) => `${n}=gt.500000`,
  timestamp: (n) => `${n}=gte.2026-11-01`,
  boolean: (n) => `${n}=eq.true`,
}
const KIND_LABEL: Record<FilterKind, string> = { uuid: 'uuid', text: 'text', integer: 'integer', timestamp: 'timestamp', boolean: 'boolean' }

/** The parameter description, from the same table that validates the operator ([[CORE199]] D9), so the text cannot drift from the parser. */
export function describeColumnFilter(name: string, spec: ColumnFilterSpec): string {
  const parts = [
    `Filter by ${name} (${KIND_LABEL[spec.kind]}${spec.nullable ? ', can be null' : ''}). A bare value means equals; otherwise [not.]<operator>.<value>, once per field.`,
    `Operators: ${operatorsFor(spec.kind, spec.nullable).join(', ')}.`,
    `Example: ${EXAMPLES[spec.kind](name)}.`,
    'Comparisons, neq and not. never match a null value; is.null does.',
  ]
  if (spec.kind === 'text') parts.push('Patterns: * is the wildcard; like is case-sensitive, ilike folds ASCII case only. Comparison is by byte order.')
  if (spec.kind === 'timestamp') parts.push('A value is a date (midnight UTC) or an ISO 8601 date-time with an offset.')
  if (spec.note) parts.push(spec.note)
  parts.push(`A value that starts with not. or an operator name and a dot is read as an operator: send ${name}=eq.<value> for a literal.`)
  return parts.join(' ')
}

const LIST_PARAMETERS: readonly string[] = ['after', 'limit', 'sort', 'order']

type Metadata = {
  readonly name: string
  readonly columns: Readonly<Record<string, ColumnKind>>
  readonly record: { readonly shape: Readonly<Record<string, unknown>> }
  readonly filters?: Readonly<Record<string, unknown>>
  readonly customFilters?: Readonly<Record<string, unknown>>
}

/**
 * [[CORE199]] D6: every record field that is a column of a filterable kind, except `organization_id` (always the caller's), in record field order.
 * `filters` supplies per-column options (`schema`, `normalize`); a key there that is not such a column, a column named like a list parameter, and a
 * column named like a custom filter are load errors. Nullability is read from the record schema (a field that accepts null).
 */
export function resolveColumnFilters(meta: Metadata, notes: Readonly<Record<string, string>> = {}): Readonly<Record<string, ColumnFilterSpec>> {
  const out: Record<string, ColumnFilterSpec> = {}
  for (const [field, schema] of Object.entries(meta.record.shape)) {
    const kind = Object.hasOwn(meta.columns, field) ? meta.columns[field] : undefined
    if (field === 'organization_id' || !kind || !FILTERABLE.has(kind)) continue
    if (LIST_PARAMETERS.includes(field)) throw new Error(`column filter "${field}" is a list parameter and cannot also be a filter (${meta.name})`)
    if (Object.hasOwn(meta.customFilters ?? {}, field)) throw new Error(`column filter "${field}" is also a custom filter (${meta.name})`)
    const option = (meta.filters?.[field] ?? {}) as { schema?: ColumnFilterSpec['schema']; normalize?: ColumnFilterSpec['normalize'] }
    out[field] = {
      kind: kind as FilterKind,
      nullable: (schema as z.ZodType).safeParse(null).success,
      ...(option.schema ? { schema: option.schema } : {}),
      ...(option.normalize ? { normalize: option.normalize } : {}),
      ...(notes[field] ? { note: notes[field] } : {}),
    }
  }
  for (const key of Object.keys(meta.filters ?? {})) {
    if (!Object.hasOwn(out, key)) throw new Error(`filters key "${key}" is not a filterable column of ${meta.name}`)
  }
  for (const key of Object.keys(notes)) {
    if (!Object.hasOwn(out, key)) throw new Error(`filter note "${key}" is not a filterable column of ${meta.name}`)
  }
  return Object.freeze(out)
}

/**
 * Explicit opt-in to the column filter grammar for a list (the counterpart of `withColumnSorts`). `notes` adds a sentence to a column's generated
 * description (deals: the money recipe on `amount_minor`).
 */
export function withColumnFilters<T extends PreparedResource>(def: T, notes: Readonly<Record<string, string>> = {}): T & { readonly columnFilters: Readonly<Record<string, ColumnFilterSpec>> } {
  const columnFilters = resolveColumnFilters(
    { name: def.name, columns: COLUMN_KINDS[def.table as keyof typeof COLUMN_KINDS] as Readonly<Record<string, ColumnKind>>, record: def.record, filters: def.filters, customFilters: def.customFilters },
    notes,
  )
  return { ...def, columnFilters }
}
