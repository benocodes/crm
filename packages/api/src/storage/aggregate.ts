import { sql, type AliasedRawBuilder } from 'kysely'
import { z } from 'zod'
import { codecs, type QueryContext } from '@vibase/storage'
import { ApiError } from '../errors.js'
import type { FilterKind } from './column-filters.js'
import type { PreparedResource } from './definition.js'

// [[CORE202]] ([[CORE199]] D13-D16, D19): aggregation over a list's filtered live rows. This file is the pure part: the opt-in (`withAggregate`), the
// function-by-kind table, the parse of the four function parameters, the select list, the money rule and the answer. The query itself is
// `aggregateOperation` in `crud.ts`, beside the list it shares its filters with.

export const AGGREGATE_FUNCTIONS = ['sum', 'avg', 'min', 'max'] as const
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number]
/** The ONE table of D14: which column kinds each function takes. Validation, discovery and the parameter descriptions all read it. */
export const FUNCTION_KINDS: Readonly<Record<AggregateFunction, readonly FilterKind[]>> = {
  sum: ['integer'],
  avg: ['integer'],
  min: ['integer', 'timestamp', 'text'],
  max: ['integer', 'timestamp', 'text'],
}
const KIND_PHRASE: Readonly<Record<AggregateFunction, string>> = {
  sum: 'an integer',
  avg: 'an integer',
  min: 'an integer, timestamp or text',
  max: 'an integer, timestamp or text',
}
const NO_FIELD: Readonly<Record<AggregateFunction, string>> = {
  sum: 'integer',
  avg: 'integer',
  min: 'integer, timestamp or text',
  max: 'integer, timestamp or text',
}
/** D13: at most this many field terms across the four functions. */
export const MAX_TERMS = 10
/** D14: a sum beyond this is not an exact JSON number. Spelled out as a literal in SQL, so no bind can round it. */
export const SAFE_INTEGER_LIMIT = Number.MAX_SAFE_INTEGER
/** The parameter names an aggregatable list cannot also use as a filter (D13); `count` is the answer's key. */
const RESERVED = ['count', ...AGGREGATE_FUNCTIONS, 'group_by'] as const
/** [[CORE207]] D2: the column kinds a group field may have (never `id`, whose every row would be its own group). */
export const GROUPABLE_KINDS: readonly FilterKind[] = ['uuid', 'text', 'integer', 'boolean']
/** D3: at most this many group fields. */
export const MAX_GROUP_FIELDS = 2
/** D6: more groups than this is refused, never truncated. */
export const MAX_GROUPS = 200

/** D19: the fields each function takes on a list, and its money declaration (`field -> the column that holds its currency`). */
export type AggregateSpec = {
  readonly fields: Readonly<Record<AggregateFunction, readonly string[]>>
  readonly money: Readonly<Record<string, string>>
  /** [[CORE207]] D2: the fields `group_by` takes, in record field order. */
  readonly group_by: readonly string[]
}
type Aggregatable = Pick<PreparedResource, 'name' | 'eventName'> & {
  readonly aggregate?: AggregateSpec
  readonly derived?: Readonly<Record<string, unknown>>
  readonly record: { readonly shape: Readonly<Record<string, unknown>> }
  readonly columnFilters?: Readonly<Record<string, { readonly kind: FilterKind }>>
}

/**
 * Explicit opt-in to aggregation for a list that already adopted `withColumnFilters`: the fields each function takes are the filterable columns of the
 * kinds D14 allows, in record field order. `money` declares money fields with their currency column (D15). Load errors (plain `Error`): no column
 * filters, a filter or column named `count`, `sum`, `avg`, `min` or `max`, and a money declaration that is not an integer column paired with a text column.
 */
export function withAggregate<T extends PreparedResource>(
  def: T,
  money: Readonly<Record<string, string>> = {},
): T & { readonly aggregate: AggregateSpec } {
  const columns = (def as Aggregatable).columnFilters
  if (!columns) throw new Error(`aggregate on ${def.name} needs withColumnFilters`)
  for (const name of RESERVED) {
    if (
      Object.hasOwn(columns, name) ||
      Object.hasOwn(def.customFilters ?? {}, name) ||
      Object.hasOwn(def.filters ?? {}, name)
    ) {
      throw new Error(`"${name}" is an aggregate parameter and cannot also be a filter of ${def.name}`)
    }
  }
  for (const [field, currency] of Object.entries(money)) {
    if (columns[field]?.kind !== 'integer' || columns[currency]?.kind !== 'text')
      throw new Error(
        `money declaration ${field} -> ${currency} of ${def.name} needs an integer column and a text column`,
      )
  }
  const fields = Object.fromEntries(
    AGGREGATE_FUNCTIONS.map((fn) => [
      fn,
      Object.entries(columns)
        .filter(([, c]) => FUNCTION_KINDS[fn].includes(c.kind))
        .map(([name]) => name),
    ]),
  ) as Record<AggregateFunction, string[]>
  const group_by = Object.entries(columns)
    .filter(([name, c]) => name !== 'id' && GROUPABLE_KINDS.includes(c.kind))
    .map(([name]) => name)
  return {
    ...def,
    aggregate: Object.freeze({
      fields: Object.freeze(fields),
      money: Object.freeze({ ...money }),
      group_by: Object.freeze(group_by),
    }),
  }
}

export type AggregateTerms = Record<AggregateFunction, string[]>

const refuse = (message: string) => new ApiError(400, 'validation_error', message)

/**
 * D13, D14: the four function parameters as lists of fields, each validated against the kind table. A function that is absent has no terms; one given empty,
 * with an empty term, or naming a field twice is refused (a repeat is a mistake, not a wish: folding it would hide one); more than 10 terms in all is refused.
 * Every refusal for a field names the fields the function takes.
 */
export function parseAggregateTerms(
  def: Aggregatable,
  raw: Partial<Record<AggregateFunction, unknown>>,
): AggregateTerms {
  const spec = def.aggregate
  if (!spec) throw new Error(`${def.name} does not aggregate`)
  const out: AggregateTerms = { sum: [], avg: [], min: [], max: [] }
  const text = {} as Partial<Record<AggregateFunction, string[]>>
  let total = 0
  for (const fn of AGGREGATE_FUNCTIONS) {
    const value = raw[fn]
    if (value === undefined || value === null) continue
    const parts = String(value)
      .split(',')
      .map((p) => p.trim())
    total += parts.length === 1 && parts[0] === '' ? 0 : parts.length
    text[fn] = parts
  }
  if (total > MAX_TERMS) throw refuse(`at most ${MAX_TERMS} terms in all: sum, avg, min and max name ${total}`)
  for (const fn of AGGREGATE_FUNCTIONS) {
    const parts = text[fn]
    if (!parts) continue
    // [[CORE615]] D5: a function that takes no field on this list is not one of its parameters.
    if (spec.fields[fn].length === 0) throw refuse(`${fn}: ${def.name} has no ${NO_FIELD[fn]} field`)
    const takes = `${fn} takes: ${spec.fields[fn].join(', ')}`
    if (parts.length === 1 && parts[0] === '') throw refuse(`${fn} needs at least one field; ${takes}`)
    const seen = new Set<string>()
    for (const field of parts) {
      if (field === '') throw refuse(`${fn} has an empty term`)
      if (!spec.fields[fn].includes(field)) {
        const kind =
          def.columnFilters && Object.hasOwn(def.columnFilters, field) ? def.columnFilters[field]!.kind : undefined
        const why = Object.hasOwn(def.derived ?? {}, field)
          ? `${field} is derived`
          : kind
            ? `${field} is ${kind}, not ${KIND_PHRASE[fn]}`
            : Object.hasOwn(def.record.shape, field)
              ? `${field} cannot be aggregated`
              : `unknown field ${field}`
        throw refuse(`${fn}: ${why}; ${takes}`)
      }
      if (seen.has(field)) throw refuse(`${fn} names ${field} twice`)
      seen.add(field)
      out[fn].push(field)
    }
  }
  return out
}

/**
 * [[CORE207]] D1-D3: `group_by` as a list of at most two group fields, each a groupable column (D2); absent gives none. A repeat, an empty term or an empty
 * `group_by` is refused, and every refusal for a field names the groupable fields.
 */
export function parseGroupBy(def: Aggregatable, raw: unknown): string[] {
  const spec = def.aggregate
  if (!spec) throw new Error(`${def.name} does not aggregate`)
  if (raw === undefined || raw === null) return []
  const takes = `group_by takes: ${spec.group_by.join(', ')}`
  const parts = String(raw)
    .split(',')
    .map((p) => p.trim())
  if (parts.length === 1 && parts[0] === '') throw refuse(`group_by needs at least one field; ${takes}`)
  if (parts.length > MAX_GROUP_FIELDS)
    throw refuse(`group_by takes at most ${MAX_GROUP_FIELDS} fields: ${parts.length} given; ${takes}`)
  const seen = new Set<string>()
  for (const field of parts) {
    if (field === '') throw refuse(`group_by has an empty term`)
    if (!spec.group_by.includes(field)) {
      const kind =
        def.columnFilters && Object.hasOwn(def.columnFilters, field) ? def.columnFilters[field]!.kind : undefined
      const why = Object.hasOwn(def.derived ?? {}, field)
        ? `${field} is derived, not groupable`
        : field === 'id'
          ? `id is every row's own key, not groupable`
          : kind
            ? `${field} is ${kind}, not groupable`
            : Object.hasOwn(def.record.shape, field)
              ? `${field} cannot be grouped`
              : `unknown field ${field}`
      throw refuse(`group_by: ${why}; ${takes}`)
    }
    if (seen.has(field)) throw refuse(`group_by names ${field} twice`)
    seen.add(field)
  }
  return parts
}

const described = (def: Aggregatable, fn: AggregateFunction): string => {
  const spec = def.aggregate!
  const verb = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' }[fn]
  return `${verb} of fields, comma-separated: ${spec.fields[fn].join(', ')}. The answer has ${fn} as an object keyed by field. Nulls are ignored; no values gives null.`
}

/** The `sum`, `avg`, `min` and `max` query parameters (a function with no field on the list is left out, D5), described from the same field lists that validate them (D19). */
export function aggregateParams(def: Aggregatable): Partial<Record<AggregateFunction | 'group_by', z.ZodType>> {
  const params = Object.fromEntries(
    AGGREGATE_FUNCTIONS.filter((fn) => def.aggregate!.fields[fn].length > 0).map((fn) => [
      fn,
      z.string().describe(described(def, fn)).optional(),
    ]),
  ) as unknown as Record<string, z.ZodType>
  // [[CORE207]] D1, D8: a list with no groupable field has no `group_by` parameter.
  if (def.aggregate!.group_by.length > 0)
    params.group_by = z
      .string()
      .describe(
        `Group the answer by up to ${MAX_GROUP_FIELDS} fields, comma-separated: ${def.aggregate!.group_by.join(', ')}. The answer is { count, groups } with one entry per group (key, count and each function you ask for), ordered by the group fields with the null group last. More than ${MAX_GROUPS} groups is refused. A function over a money field is judged in each group.`,
      )
      .optional()
  return params as Partial<Record<AggregateFunction | 'group_by', z.ZodType>>
}

/** The answer of `<list>.aggregate` (D13): `count` always, each requested function as an object keyed by field, and `currency` beside money fields. */
const answerFields = {
  count: z.number().int().describe('The live rows that match the filters.'),
  sum: z.record(z.string(), z.number().nullable()).optional(),
  avg: z.record(z.string(), z.number().nullable()).optional(),
  min: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).optional(),
  max: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).optional(),
  currency: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe(
      'For each money field a function was asked of: the one currency of its amounts, or null when there are none.',
    ),
}
export const aggregateGroup = z.object({
  key: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).nullable())
    .describe('The value of each group field for this group, in its record form (null for the null group).'),
  ...answerFields,
  count: z.number().int().describe("The live rows in this group's key."),
})
export const aggregateAnswer = z.object({
  ...answerFields,
  groups: z
    .array(aggregateGroup)
    .optional()
    .describe(
      'With group_by: one answer per group, ordered by the group fields with the null group last. Then count is every matching row and no function key is at the top level.',
    ),
})
export type AggregateAnswer = z.infer<typeof aggregateAnswer>

/** D16: the operation's description. The cost sentence is generated and names no index; `aggregate-cost.integration.d1.test.ts` checks it against the plans. */
export function aggregateDescription(def: Aggregatable & { readonly eventName: string }): string {
  const spec = def.aggregate!
  const money = Object.entries(spec.money)
  const noun = def.eventName
  return [
    `Counts the live ${def.name} that match the filters, which are exactly the filters of ${def.name}.list (no after, limit, sort or order), and optionally sums, averages or takes the minimum or maximum of fields.`,
    'The answer is { count, sum?, avg?, min?, max?, currency?, groups? }: count always, and each function you ask for as an object keyed by field. Nulls are ignored, a function with no values is null, sum is refused above 9007199254740991 (the largest exact integer), avg is not rounded, min and max return the value as the record shows it. At most 10 field terms in all.',
    ...(spec.group_by.length > 0
      ? [
          `With group_by (up to ${MAX_GROUP_FIELDS} of ${spec.group_by.join(', ')}) the answer is { count, groups: [{ key, count, sum?, avg?, min?, max?, currency? }] }: count is every matching row, and each group is the answer the call would give with the key added as filters, ordered by the group fields with the null group last; more than ${MAX_GROUPS} groups is refused, never truncated.`,
        ]
      : []),
    ...money.map(
      ([field, currency]) =>
        `${field} is money in the minor units of each ${noun}'s ${currency}: sum, avg, min or max of it is refused (400) when the matching amounts are in more than one currency, naming them (add ${currency}=eq.<code> to aggregate one); otherwise the answer carries ${currency}: { ${field}: "<code>" } (null when there are no amounts). count is never refused. With group_by the rule is judged in each group, so group_by=${currency} gives one total per currency.`,
    ),
    `Cost: reads every live ${noun} that matches the filters, with no page limit; a filter schema.get marks \`indexed\` narrows that read through an index; any other filter, or none, reads every live ${noun} of the workspace.${spec.group_by.length > 0 ? ' With group_by the same rows are read and sorted by the group fields (no index).' : ''}`,
  ].join(' ')
}

/** One aliased select item per requested term, plus what the money rule and the safe-integer check need. Aliases are positional, never a field name. */
export type AggregateColumn = {
  readonly fn: AggregateFunction
  readonly field: string
  readonly kind: FilterKind
  readonly alias: string
  readonly overflow?: string
}
/** One group field: its alias in the select list and the kind its value decodes as. */
export type GroupColumn = { readonly field: string; readonly kind: FilterKind; readonly alias: string }
export type AggregatePlan = {
  readonly groups: readonly GroupColumn[]
  readonly columns: readonly AggregateColumn[]
  readonly money: ReadonlyArray<{ readonly field: string; readonly currencies: string }>
}

/** What to compute for the parsed terms: the columns in answer order, and for each money field a function is asked of, the alias of its distinct currencies. */
export function planAggregate(
  def: Aggregatable,
  terms: AggregateTerms,
  groupBy: readonly string[] = [],
): AggregatePlan {
  const spec = def.aggregate!
  const columns: AggregateColumn[] = []
  const asked = new Set<string>()
  for (const fn of AGGREGATE_FUNCTIONS) {
    for (const field of terms[fn]) {
      const n = columns.length
      columns.push({
        fn,
        field,
        kind: def.columnFilters![field]!.kind,
        alias: `v${n}`,
        ...(fn === 'sum' ? { overflow: `o${n}` } : {}),
      })
      if (Object.hasOwn(spec.money, field)) asked.add(field)
    }
  }
  return {
    groups: groupBy.map((field, i) => ({ field, kind: def.columnFilters![field]!.kind, alias: `g${i}` })),
    columns,
    money: [...asked].map((field, i) => ({ field, currencies: `c${i}` })),
  }
}

/**
 * D14, D15: the select list. `count(*)`, each function over its column, a 0/1 flag beside each `sum` that says whether it left the exact-integer range (judged
 * in SQL, before the value reaches JavaScript), and per money field the distinct currencies among the non-null amounts, so the money rule rides in the same statement.
 */
export function aggregateSelect(
  qc: QueryContext,
  table: string,
  plan: AggregatePlan,
  money: Readonly<Record<string, string>>,
): AliasedRawBuilder<unknown, string>[] {
  const ref = (c: string) => sql.ref(`${table}.${c}`)
  const out: AliasedRawBuilder<unknown, string>[] = [sql`count(*)`.as('count')]
  for (const g of plan.groups) out.push(sql`${ref(g.field)}`.as(g.alias))
  for (const c of plan.columns) {
    out.push(sql`${sql.raw(c.fn)}(${ref(c.field)})`.as(c.alias))
    if (c.overflow)
      out.push(
        sql`case when abs(sum(${ref(c.field)})) > ${sql.raw(String(SAFE_INTEGER_LIMIT))} then 1 else 0 end`.as(
          c.overflow,
        ),
      )
  }
  for (const m of plan.money) {
    const code = sql`case when ${ref(m.field)} is not null then ${ref(money[m.field]!)} end`
    out.push(
      (qc.dialect === 'd1' ? sql`group_concat(distinct ${code})` : sql`string_agg(distinct ${code}, ',')`).as(
        m.currencies,
      ),
    )
  }
  return out
}

/** [[CORE207]] D7: how a group is named in a message: its fields and values, `stage_id=<id>,currency=EUR`. */
const groupLabel = (plan: AggregatePlan, key: Record<string, unknown>): string =>
  plan.groups.map((g) => `${g.field}=${key[g.field] === null ? 'null' : String(key[g.field])}`).join(',')

/** One row's answer (`count` and the functions): the money rule first (D15, per group under D7), then the exact-integer limit (D14), then each value in its record form. */
function decodeRow(plan: AggregatePlan, row: Record<string, unknown>, group?: string): AggregateAnswer {
  const currency: Record<string, string | null> = {}
  for (const m of plan.money) {
    const codes =
      typeof row[m.currencies] === 'string' ? [...new Set((row[m.currencies] as string).split(','))].sort() : []
    if (codes.length > 1)
      throw refuse(
        group === undefined
          ? `${m.field} is in ${codes.length} currencies here (${codes.join(', ')}): add currency=eq.<code> to aggregate one`
          : `${m.field} is in ${codes.length} currencies in group ${group} (${codes.join(', ')}): add currency to group_by, or add currency=eq.<code>`,
      )
    currency[m.field] = codes[0] ?? null
  }
  const answer: Record<string, unknown> = { count: Number(row.count) }
  for (const c of plan.columns) {
    if (c.overflow && Number(row[c.overflow]) === 1)
      throw refuse(
        `sum of ${c.field}${group === undefined ? '' : ` in group ${group}`} is above ${SAFE_INTEGER_LIMIT}, the largest exact integer; add filters to sum fewer rows`,
      )
    const raw = row[c.alias]
    const value =
      raw === null || raw === undefined
        ? null
        : c.fn === 'avg'
          ? Number(raw)
          : c.kind === 'timestamp'
            ? codecs.timestamp.readNullable(raw)
            : c.kind === 'integer'
              ? codecs.integer.readNullable(raw)
              : String(raw)
    const bucket = (answer[c.fn] ??= {}) as Record<string, unknown>
    bucket[c.field] = value
  }
  if (plan.money.length > 0) answer.currency = currency
  return answer as AggregateAnswer
}

/** The answer from the one row of an ungrouped call. */
export const decodeAggregate = (plan: AggregatePlan, row: Record<string, unknown>): AggregateAnswer =>
  decodeRow(plan, row)

/** A group field's value in its record form (D4). */
function keyValue(kind: FilterKind, raw: unknown): string | number | boolean | null {
  if (raw === null || raw === undefined) return null
  if (kind === 'integer') return codecs.integer.readNullable(raw)
  if (kind === 'boolean') return codecs.boolean.readNullable(raw)
  return String(raw)
}

/**
 * [[CORE207]] D4, D6, D7: the answer of a grouped call from its rows (the statement asked for one more than the cap): refused when it holds more than 200 groups,
 * otherwise `count` (the sum of the groups') and one ungrouped answer per group beside its `key`.
 */
export function decodeGrouped(plan: AggregatePlan, rows: readonly Record<string, unknown>[]): AggregateAnswer {
  if (rows.length > MAX_GROUPS)
    throw refuse(
      `group_by ${plan.groups.map((g) => g.field).join(',')} gives more than ${MAX_GROUPS} groups: add filters or group by a field with fewer values`,
    )
  let count = 0
  const groups = rows.map((row) => {
    const key: Record<string, string | number | boolean | null> = {}
    for (const g of plan.groups) key[g.field] = keyValue(g.kind, row[g.alias])
    const answer = decodeRow(plan, row, groupLabel(plan, key))
    count += answer.count
    return { key, ...answer }
  })
  return { count, groups }
}
