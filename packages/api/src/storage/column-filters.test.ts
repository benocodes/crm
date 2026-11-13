import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { COLUMN_KINDS, queryContext } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { deals } from '../resources/deals.js'
import { definePreparedResource } from './definition.js'
import { OPERATORS, compileCondition, describeColumnFilter, globPattern, likePattern, operatorsFor, parseCondition, resolveColumnFilters, withColumnFilters, type ColumnFilterSpec, type FilterKind } from './column-filters.js'

// [[CORE200]] D2-D6, pure: the grammar parser, the operand kinds, the pattern translators, the compiled SQL and the load checks.
const spec = (kind: FilterKind, nullable = true, extra: Partial<ColumnFilterSpec> = {}): ColumnFilterSpec => ({ kind, nullable, ...extra })
const parse = (kind: FilterKind, raw: string, nullable = true) => parseCondition('f', spec(kind, nullable), raw)
const refused = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(400)
    expect((e as ApiError).code).toBe('validation_error')
    return (e as ApiError).message
  }
  throw new Error('expected a 400')
}
const U = '0190b2c4-0000-7000-8000-0000000000a1'

describe('grammar (D2)', () => {
  it('a bare value is eq', () => {
    expect(parse('text', 'acme')).toEqual({ not: false, op: 'eq', value: 'acme' })
    expect(parse('integer', '42')).toEqual({ not: false, op: 'eq', value: 42 })
  })
  it.each(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const)('reads %s and not.%s', (op) => {
    expect(parse('integer', `${op}.5`)).toEqual({ not: false, op, value: 5 })
    expect(parse('integer', `not.${op}.5`)).toEqual({ not: true, op, value: 5 })
  })
  it('reads in, like, ilike and is, each negatable', () => {
    expect(parse('text', 'in.(a,b)')).toEqual({ not: false, op: 'in', value: ['a', 'b'] })
    expect(parse('text', 'not.in.(a)')).toEqual({ not: true, op: 'in', value: ['a'] })
    expect(parse('text', 'like.a*')).toEqual({ not: false, op: 'like', value: 'a*' })
    expect(parse('text', 'not.ilike.*a*')).toEqual({ not: true, op: 'ilike', value: '*a*' })
    expect(parse('text', 'is.null')).toEqual({ not: false, op: 'is', value: null })
    expect(parse('text', 'not.is.null')).toEqual({ not: true, op: 'is', value: null })
    expect(parse('boolean', 'is.true')).toEqual({ not: false, op: 'is', value: true })
    expect(parse('boolean', 'not.is.false')).toEqual({ not: true, op: 'is', value: false })
  })
  it('a value that only starts like an operator without the dot is a bare value; a literal that starts "op." is sent through eq.', () => {
    expect(parse('text', 'inside')).toEqual({ not: false, op: 'eq', value: 'inside' })
    expect(parse('text', 'island.x')).toEqual({ not: false, op: 'eq', value: 'island.x' })
    expect(parse('text', 'eq.is.gd')).toEqual({ not: false, op: 'eq', value: 'is.gd' })
    expect(parse('text', 'eq.in.x')).toEqual({ not: false, op: 'eq', value: 'in.x' })
    // Without the eq. prefix the literal is an operator expression: `is.gd` is `is` with the operand `gd`.
    expect(refused(() => parse('text', 'is.gd'))).toBe('filter f: is takes null, true or false')
  })
  it('in: PostgREST quoting for , ( ) " and \\"', () => {
    expect(parse('text', 'in.("a,b","c(d)",e)')).toMatchObject({ value: ['a,b', 'c(d)', 'e'] })
    expect(parse('text', 'in.("say \\"hi\\"","back\\\\slash")')).toMatchObject({ value: ['say "hi"', 'back\\slash'] })
    expect(parse('text', 'in.("")')).toMatchObject({ value: [''] })
    expect(parse('text', 'in.( a , b )')).toMatchObject({ value: ['a', 'b'] })
  })
  it('in: 0 and 101 items and bad quoting are refused, 100 is accepted', () => {
    expect(refused(() => parse('text', 'in.()'))).toBe('filter f: in needs at least 1 item')
    const hundred = Array.from({ length: 100 }, (_, i) => `v${i}`)
    expect((parse('text', `in.(${hundred.join(',')})`).value as unknown[]).length).toBe(100)
    expect(refused(() => parse('text', `in.(${[...hundred, 'x'].join(',')})`))).toBe('filter f: in takes at most 100 items (got 101)')
    expect(refused(() => parse('text', 'in.a,b'))).toBe('filter f: in needs a parenthesised list, as in in.(a,b)')
    expect(refused(() => parse('text', 'in.(a,,b)'))).toBe('filter f: in has an empty item')
    expect(refused(() => parse('text', 'in.("abc)'))).toBe('filter f: in has bad quoting: an item containing , ( ) or " must be double-quoted, with \\" for a quote')
    expect(refused(() => parse('text', 'in.("a"b)'))).toBe('filter f: in has bad quoting: an item containing , ( ) or " must be double-quoted, with \\" for a quote')
    expect(refused(() => parse('text', 'in.(a"b)'))).toBe('filter f: in has bad quoting: an item containing , ( ) or " must be double-quoted, with \\" for a quote')
  })
  it('is takes null, true or false; true and false only for a boolean', () => {
    expect(refused(() => parse('text', 'is.maybe'))).toBe('filter f: is takes null, true or false')
    expect(refused(() => parse('text', 'is.true'))).toBe('filter f: is.true and is.false are only for boolean fields')
    expect(refused(() => parse('integer', 'is.false'))).toBe('filter f: is.true and is.false are only for boolean fields')
  })
  it('not. alone, and not. before anything but an operator, is refused', () => {
    expect(refused(() => parse('text', 'not.'))).toBe('filter f: not. needs an operator after it, as in not.eq.x')
    expect(refused(() => parse('text', 'not.foo'))).toBe('filter f: not. needs an operator after it, as in not.eq.x')
    expect(refused(() => parse('text', 'not.not.eq.x'))).toBe('filter f: not. needs an operator after it, as in not.eq.x')
  })
  it('an over-long pattern (200) and an over-long text operand (1000) are refused, the limits themselves are accepted', () => {
    expect(parse('text', `like.${'a'.repeat(200)}`).op).toBe('like')
    expect(refused(() => parse('text', `ilike.${'a'.repeat(201)}`))).toBe('filter f: a pattern is at most 200 characters')
    expect(parse('text', `eq.${'a'.repeat(1000)}`).op).toBe('eq')
    expect(refused(() => parse('text', `eq.${'a'.repeat(1001)}`))).toBe('filter f: a text operand is at most 1000 characters')
    expect(refused(() => parse('text', `in.(${'a'.repeat(1001)})`))).toBe('filter f: a text operand is at most 1000 characters')
  })
})

describe('operators by kind (D3)', () => {
  const table: Array<[FilterKind, boolean, string[]]> = [
    ['uuid', false, ['eq', 'neq', 'in']],
    ['uuid', true, ['eq', 'neq', 'in', 'is']],
    ['text', false, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike']],
    ['text', true, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike']],
    ['integer', true, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is']],
    ['timestamp', false, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']],
    ['boolean', false, ['eq', 'neq']],
    ['boolean', true, ['eq', 'neq', 'is']],
  ]
  it.each(table)('%s (nullable %s) offers %j and refuses every other operator with the list', (kind, nullable, offered) => {
    expect(operatorsFor(kind, nullable)).toEqual(offered)
    const operand = { uuid: U, text: 'x', integer: '1', timestamp: '2026-11-01', boolean: 'true' }[kind]
    for (const op of OPERATORS) {
      const raw = op === 'in' ? `in.(${operand})` : op === 'is' ? 'is.null' : `${op}.${op === 'like' || op === 'ilike' ? 'x*' : operand}`
      if (offered.includes(op)) expect(() => parse(kind, raw, nullable), `${kind} ${op}`).not.toThrow()
      else expect(refused(() => parse(kind, raw, nullable)), `${kind} ${op}`).toBe(`filter f: ${op} is not available for ${kind} (available: ${offered.join(', ')})`)
    }
  })
  it('the spec example, pinned', () => {
    expect(refused(() => parseCondition('amount_minor', spec('integer'), 'like.5*'))).toBe('filter amount_minor: like is not available for integer (available: eq, neq, gt, gte, lt, lte, in, is)')
  })
  it('json and string_array columns are not filterable kinds', () => {
    expect(() => resolveColumnFilters({ name: 'w', columns: { id: 'uuid', blob: 'json', tags: 'string_array' }, record: { shape: { id: z.uuid(), blob: z.unknown(), tags: z.array(z.string()) } } })).not.toThrow()
    expect(Object.keys(resolveColumnFilters({ name: 'w', columns: { id: 'uuid', blob: 'json', tags: 'string_array' }, record: { shape: { id: z.uuid(), blob: z.unknown(), tags: z.array(z.string()) } } }))).toEqual(['id'])
  })
})

describe('operands by kind (D3)', () => {
  it('uuid: lower-cased; anything else refused', () => {
    expect(parse('uuid', U.toUpperCase()).value).toBe(U)
    expect(refused(() => parse('uuid', 'eq.nope'))).toBe('filter f: "nope" is not a UUID')
  })
  it('integer: a safe integer only', () => {
    expect(parse('integer', 'gt.-3').value).toBe(-3)
    for (const bad of ['1.5', 'abc', '', '9007199254740993']) expect(refused(() => parse('integer', `eq.${bad}`))).toBe(`filter f: "${bad}" is not a safe integer`)
  })
  it('boolean: true or false', () => {
    expect(parse('boolean', 'eq.true').value).toBe(true)
    expect(refused(() => parse('boolean', 'eq.yes'))).toBe('filter f: "yes" is not true or false')
  })
  it('timestamp: a bare date is midnight UTC, an offset date-time is normalised, no offset is refused', () => {
    expect(parse('timestamp', 'gte.2026-11-01').value).toBe('2026-11-01T00:00:00.000Z')
    expect(parse('timestamp', 'gte.2026-11-01T10:00:00+02:00').value).toBe('2026-11-01T08:00:00.000Z')
    expect(parse('timestamp', 'in.(2026-11-01,2026-11-02T00:00:00Z)').value).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'])
    expect(refused(() => parse('timestamp', 'gt.2026-11-01T10:00:00'))).toBe('filter f: "2026-11-01T10:00:00" is not an ISO 8601 date or date-time with an offset')
    expect(refused(() => parse('timestamp', 'gt.yesterday'))).toBe('filter f: "yesterday" is not an ISO 8601 date or date-time with an offset')
  })
  it('an option normalize applies to eq, comparisons and in items but not to patterns; its schema validates each scalar operand', () => {
    const upper = spec('text', true, { normalize: (v) => (v as string).toUpperCase(), schema: z.string().max(3) })
    expect(parseCondition('c', upper, 'usd').value).toBe('USD')
    expect(parseCondition('c', upper, 'gte.usd').value).toBe('USD')
    expect(parseCondition('c', upper, 'in.(usd,eur)').value).toEqual(['USD', 'EUR'])
    expect(parseCondition('c', upper, 'ilike.us*').value).toBe('us*')
    expect(parseCondition('c', upper, 'like.us*').value).toBe('us*')
    expect(refused(() => parseCondition('c', upper, 'eq.dollars'))).toMatch(/^filter c: /)
    expect(refused(() => parseCondition('c', upper, 'in.(usd,dollars)'))).toMatch(/^filter c: /)
    const id = spec('uuid', false, { schema: z.uuid() })
    expect(refused(() => parseCondition('pipeline_id', id, 'not-a-uuid'))).toBe('filter pipeline_id: "not-a-uuid" is not a UUID')
  })
})

describe('pattern translators (D4)', () => {
  it('LIKE: * becomes %, % _ and the escape character are escaped, the rest is literal', () => {
    expect(likePattern('*acme*')).toBe('%acme%')
    expect(likePattern('100%_x')).toBe('100\\%\\_x')
    expect(likePattern('a\\b*')).toBe('a\\\\b%')
    expect(likePattern('?[x]')).toBe('?[x]')
  })
  it('GLOB: * stays, ? [ ] are bracketed, % and _ are literal', () => {
    expect(globPattern('*acme*')).toBe('*acme*')
    expect(globPattern('a?b[c]')).toBe('a[?]b[[]c[]]')
    expect(globPattern('100%_x')).toBe('100%_x')
    expect(globPattern('a\\b')).toBe('a\\b')
  })
})

describe('compiled SQL (D3, D4)', () => {
  const col = sql.ref('deals.amount_minor')
  const name = sql.ref('deals.name')
  const compile = (dialect: 'd1' | 'postgres', kind: FilterKind, column: typeof col, raw: string) => {
    const qc = queryContext(dialect)
    const c = qc.db.selectFrom('deals').select('id').where(compileCondition(qc, column, kind, parse(kind, raw))).compile()
    return { sql: c.sql.replace(/^select "id" from "deals" where /, ''), parameters: c.parameters }
  }
  it('D1: operators', () => {
    expect(compile('d1', 'integer', col, 'gt.5')).toEqual({ sql: '"deals"."amount_minor" > ?', parameters: [5] })
    expect(compile('d1', 'integer', col, 'neq.5')).toEqual({ sql: '"deals"."amount_minor" <> ?', parameters: [5] })
    expect(compile('d1', 'integer', col, 'not.gt.5')).toEqual({ sql: 'not ("deals"."amount_minor" > ?)', parameters: [5] })
    expect(compile('d1', 'integer', col, 'is.null').sql).toBe('"deals"."amount_minor" is null')
    expect(compile('d1', 'integer', col, 'not.is.null').sql).toBe('"deals"."amount_minor" is not null')
    const inSet = compile('d1', 'integer', col, 'in.(1,2)')
    expect(inSet.sql).toContain('json_each(?)')
    expect(inSet.parameters).toEqual([JSON.stringify([{ value: 1 }, { value: 2 }])])
  })
  it('D1: ilike is LIKE ... ESCAPE, like is GLOB', () => {
    expect(compile('d1', 'text', name, 'ilike.*a_b*')).toEqual({ sql: `"deals"."name" like ? escape '\\'`, parameters: ['%a\\_b%'] })
    expect(compile('d1', 'text', name, 'like.a?*')).toEqual({ sql: '"deals"."name" glob ?', parameters: ['a[?]*'] })
    expect(compile('d1', 'text', name, 'not.ilike.*a*').sql).toBe(`not ("deals"."name" like ? escape '\\')`)
  })
  it('Postgres: native LIKE and ILIKE with the same escaping, pinned (compiled, not run)', () => {
    expect(compile('postgres', 'text', name, 'ilike.*a_b*')).toEqual({ sql: `"deals"."name" ilike cast($1 as text) escape '\\'`, parameters: ['%a\\_b%'] })
    expect(compile('postgres', 'text', name, 'like.*a%*')).toEqual({ sql: `"deals"."name" like cast($1 as text) escape '\\'`, parameters: ['%a\\%%'] })
    expect(compile('postgres', 'integer', col, 'gte.7')).toEqual({ sql: '"deals"."amount_minor" >= cast($1 as bigint)', parameters: [7] })
  })
})

describe('description (D9)', () => {
  it('names the kind, the operators of the table and an example', () => {
    const d = describeColumnFilter('amount_minor', spec('integer'))
    expect(d).toContain('integer')
    expect(d).toContain(`Operators: ${operatorsFor('integer', true).join(', ')}.`)
    expect(d).toContain('amount_minor=gt.')
    expect(describeColumnFilter('name', spec('text', false))).toContain(`Operators: ${operatorsFor('text', false).join(', ')}.`)
  })
})

describe('withColumnFilters and its load checks (D6)', () => {
  const shape = { id: z.uuid(), organization_id: z.uuid(), name: z.string(), note: z.string().nullable(), n: z.number().int().nullable(), blob: z.unknown(), labels: z.array(z.string()) }
  const columns = { id: 'uuid', organization_id: 'uuid', name: 'text', note: 'text', n: 'integer', blob: 'json', labels: 'string_array', deleted_at: 'timestamp' } as const
  it('exposes exactly the record fields that are columns of a filterable kind, minus organization_id, with their nullability', () => {
    const got = resolveColumnFilters({ name: 'widgets', columns, record: { shape } })
    expect(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, [v.kind, v.nullable]]))).toEqual({ id: ['uuid', false], name: ['text', false], note: ['text', true], n: ['integer', true] })
  })
  it('keeps the option schema and normalize of a filters entry', () => {
    const schema = z.string().max(3)
    const normalize = (v: unknown) => v
    const got = resolveColumnFilters({ name: 'widgets', columns, record: { shape }, filters: { name: { schema, normalize } } })
    expect(got.name).toMatchObject({ schema, normalize })
    expect(got.note!.schema).toBeUndefined()
  })
  it('a filters key that is not a filterable column is a load error', () => {
    expect(() => resolveColumnFilters({ name: 'widgets', columns, record: { shape }, filters: { zzz: { schema: z.string() } } })).toThrow('filters key "zzz" is not a filterable column of widgets')
    expect(() => resolveColumnFilters({ name: 'widgets', columns, record: { shape }, filters: { organization_id: { schema: z.string() } } })).toThrow('filters key "organization_id" is not a filterable column of widgets')
    expect(() => resolveColumnFilters({ name: 'widgets', columns, record: { shape }, filters: { blob: { schema: z.string() } } })).toThrow('filters key "blob" is not a filterable column of widgets')
  })
  it('a column filter named like a list parameter or a custom filter is a load error', () => {
    for (const key of ['after', 'limit', 'sort', 'order']) {
      expect(() => resolveColumnFilters({ name: 'widgets', columns: { id: 'uuid', [key]: 'text' }, record: { shape: { id: z.uuid(), [key]: z.string() } } })).toThrow(`column filter "${key}" is a list parameter and cannot also be a filter (widgets)`)
    }
    expect(() => resolveColumnFilters({ name: 'widgets', columns: { id: 'uuid', tag: 'text' }, record: { shape: { id: z.uuid(), tag: z.string() } }, customFilters: { tag: {} } })).toThrow('column filter "tag" is also a custom filter (widgets)')
  })
  it('the extent on deals and on a test-only definition other than deals', () => {
    const wrapped = deals as any
    expect(Object.keys(wrapped.columnFilters).sort()).toEqual(['amount_minor', 'closed_at', 'created_at', 'created_by', 'currency', 'expected_close_date', 'id', 'name', 'owner_id', 'pipeline_id', 'stage_id', 'updated_at'])
    const widgets = definePreparedResource({
      surface: 'api',
      name: 'widgets',
      eventName: 'widget',
      table: 'tags',
      record: z.object({ id: z.uuid(), organization_id: z.uuid(), name: z.string(), description: z.string().nullable(), created_by: z.uuid(), created_at: z.string(), updated_at: z.string() }),
      create: z.strictObject({ name: z.string() }),
      update: z.strictObject({ name: z.string() }).partial(),
      filters: { name: { schema: z.string().max(10) } },
    })
    expect(Object.keys((withColumnFilters(widgets) as any).columnFilters).sort()).toEqual(['created_at', 'created_by', 'description', 'id', 'name', 'updated_at'])
    expect(COLUMN_KINDS.tags).toHaveProperty('organization_id')
  })
})
