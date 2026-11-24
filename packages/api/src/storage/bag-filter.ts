import { sql, type Expression, type SqlBool } from 'kysely'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { keyProblem } from './additional-props.js'
import { parseCondition } from './column-filters.js'
import type { CustomFilter, PreparedResource } from './definition.js'

// [[CORE318]] D10 built by [[CORE549]]: the list filter on the property bag, `additional_props=<key>.<condition>`. One condition per request (a repeated query parameter is refused before this runs, [[CORE129]] D10a).
// The operators are `eq` (also a bare value), `neq`, `in`, `is.null` and `not.is.null` (P2). A stored string matches by its text, a stored number or boolean by its compact JSON literal, case-sensitively (P1), so
// `employees.eq.40` matches 40 and "40". An absent key behaves as a null column (P3): `eq`, `neq` and `in` never match it. D1 only, like the column: a custom filter reads the live rows, no index serves a bag key.

export type BagCondition =
  | { readonly key: string; readonly op: 'eq' | 'neq'; readonly value: string }
  | { readonly key: string; readonly op: 'in'; readonly value: readonly string[] }
  | { readonly key: string; readonly op: 'is_null' | 'not_null' }

const AVAILABLE = 'eq (or a bare value), neq, in, is.null, not.is.null'
const refuse = (message: string) => new ApiError(400, 'validation_error', `filter additional_props: ${message}`)

/** The grammar of one bag condition: `<key>.<condition>`; the key is D7's pattern, the condition the column grammar narrowed to P2's operators. */
export function parseBagFilter(raw: string): BagCondition {
  const dot = raw.indexOf('.')
  if (dot < 0) throw refuse('needs <key>.<condition>, as in additional_props=employees.eq.40')
  const key = raw.slice(0, dot)
  const problem = keyProblem(key)
  if (problem) throw refuse(problem)
  const rest = raw.slice(dot + 1)
  if (rest === '') throw refuse('needs a condition after the key, as in employees.eq.40')
  const c = parseCondition('additional_props', { kind: 'text', nullable: true }, rest)
  if (c.op === 'is') {
    if (c.value === null) return { key, op: c.not ? 'not_null' : 'is_null' }
  } else if (!c.not) {
    if (c.op === 'eq' || c.op === 'neq') return { key, op: c.op, value: String(c.value) }
    if (c.op === 'in') return { key, op: 'in', value: (c.value as readonly unknown[]).map(String) }
  }
  throw refuse(`${c.not ? 'not.' : ''}${c.op} is not available on a bag key (available: ${AVAILABLE})`)
}

/** The stored value as the text P1 compares: a string as it is, a number as its JSON text as stored (SQLite's -> operator, not a cast, which re-renders a real), a boolean as its word, null when the key is absent. */
const literalOf = (column: Expression<unknown>, path: string) =>
  sql`(case json_type(${column}, ${path}) when 'text' then json_extract(${column}, ${path}) when 'integer' then ${column} -> ${path} when 'real' then ${column} -> ${path} when 'true' then 'true' when 'false' then 'false' end)`

export function bagPredicate(table: string, c: BagCondition): Expression<SqlBool> {
  const column = sql.ref(`${table}.additional_props`)
  const path = `$."${c.key}"`
  switch (c.op) {
    case 'is_null':
      return sql<SqlBool>`json_type(${column}, ${path}) is null`
    case 'not_null':
      return sql<SqlBool>`json_type(${column}, ${path}) is not null`
    case 'eq':
      return sql<SqlBool>`${literalOf(column, path)} = ${c.value}`
    case 'neq':
      return sql<SqlBool>`${literalOf(column, path)} <> ${c.value}`
    case 'in':
      return sql<SqlBool>`${literalOf(column, path)} in (select value from json_each(${JSON.stringify(c.value)}))`
  }
}

/** The stated cost of the filter in discovery: no index serves a key of the bag. */
export const BAG_FILTER_COST =
  "no index serves a bag key (the bag is a JSON column): the filter reads the organisation's live rows; promote a key that is filtered often to a typed field"

export const BAG_FILTER_DESCRIPTION =
  'Filter by one key of additional_props: additional_props=<key>.<condition>, once per request. ' +
  `Conditions: ${AVAILABLE}. Example: additional_props=employees.eq.40. ` +
  'A stored string matches by its text and a stored number or boolean by its JSON literal (employees.eq.40 matches 40 and "40", verified.eq.true matches true and "true"), case-sensitively. ' +
  'An absent key matches only is.null: eq, neq and in never match it. ' +
  `Reads every live row of the organisation, whatever the index. Other operators and not. forms are refused; list the keys in use with the property_keys read.`

export const bagFilter = (table: string): CustomFilter => ({
  schema: z.string().describe(BAG_FILTER_DESCRIPTION),
  normalize: (value) => parseBagFilter(String(value)),
  where: (_qc, value) => bagPredicate(table, value as BagCondition),
  cost: BAG_FILTER_COST,
})

/** A definition whose list takes the bag filter: the filter is a custom filter named `additional_props`, so a list and an aggregate (the same filters, [[CORE202]] D13) both take it. */
export function withPropertyBag<T extends PreparedResource>(def: T): T {
  return { ...def, customFilters: { ...(def.customFilters ?? {}), additional_props: bagFilter(def.table) } }
}
