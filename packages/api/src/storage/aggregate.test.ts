import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import { deals } from '../resources/deals.js'
import { contacts } from '../resources/contacts.js'
import { tagNameFilter } from '../resources/tag-filter.js'
import { createVaultRegistry } from '../operations.js'
import { withAggregate, parseAggregateTerms } from './aggregate.js'

// [[CORE202]] D13, D14, D19: the aggregate declaration, its load errors and the parse of the four function parameters. Pure: no query.
const spec = (deals as unknown as { aggregate: { fields: Record<string, string[]>; money: Record<string, string> } }).aggregate

describe('deals declares its aggregate fields from the kind table (D14, D19)', () => {
  it('sum and avg take the integer fields; min and max take integer, timestamp and text fields, in record field order', () => {
    expect(spec.fields.sum).toEqual(['amount_minor'])
    expect(spec.fields.avg).toEqual(['amount_minor'])
    expect(spec.fields.min).toEqual(['name', 'amount_minor', 'currency', 'expected_close_date', 'closed_at', 'created_at', 'updated_at'])
    expect(spec.fields.max).toEqual(spec.fields.min)
  })
  it('uuid fields, the derived status and the organisation are not aggregatable', () => {
    for (const fn of ['sum', 'avg', 'min', 'max']) for (const f of ['id', 'owner_id', 'pipeline_id', 'stage_id', 'created_by', 'organization_id', 'status']) expect(spec.fields[fn], `${fn} ${f}`).not.toContain(f)
  })
  it('the money declaration is amount_minor to currency', () => {
    expect(spec.money).toEqual({ amount_minor: 'currency' })
  })
  it('only deals opts in: no other registered resource has an aggregate declaration', () => {
    const others = createVaultRegistry().resources().filter((d) => (d as { aggregate?: unknown }).aggregate !== undefined).map((d) => d.name)
    expect(others).toEqual(['deals'])
    expect((contacts as { aggregate?: unknown }).aggregate).toBeUndefined()
  })
})

describe('load errors (D13, D15)', () => {
  it('a filter named like an aggregate parameter on an aggregatable list is a load error, for each name', () => {
    for (const name of ['count', 'sum', 'avg', 'min', 'max']) {
      const def = { ...deals, customFilters: { ...deals.customFilters, [name]: tagNameFilter('deals') } }
      expect(() => withAggregate(def as never, { amount_minor: 'currency' }), name).toThrow(new RegExp(`"${name}".*filter|filter.*"${name}"`))
    }
  })
  it('a money declaration must name an integer field and a text field of the list', () => {
    expect(() => withAggregate(deals as never, { name: 'currency' })).toThrow(/money/)
    expect(() => withAggregate(deals as never, { amount_minor: 'amount_minor' })).toThrow(/money/)
    expect(() => withAggregate(deals as never, { amount_minor: 'nope' })).toThrow(/money/)
  })
})

describe('the function parameters (D13, D14)', () => {
  const refusal = (raw: Record<string, unknown>) => {
    try {
      parseAggregateTerms(deals, raw)
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect([(e as ApiError).status, (e as ApiError).code]).toEqual([400, 'validation_error'])
      return (e as ApiError).message
    }
    throw new Error('expected a 400')
  }
  it('comma-separated lists, trimmed, per function; absent functions are empty', () => {
    expect(parseAggregateTerms(deals, { sum: 'amount_minor', max: ' closed_at , amount_minor ' })).toEqual({ sum: ['amount_minor'], avg: [], min: [], max: ['closed_at', 'amount_minor'] })
  })
  it('an unknown field and a wrong kind are refused naming the allowed fields', () => {
    expect(refusal({ sum: 'nope' })).toBe('sum: unknown field nope; sum takes: amount_minor')
    expect(refusal({ sum: 'name' })).toBe('sum: name is text, not an integer; sum takes: amount_minor')
    expect(refusal({ avg: 'closed_at' })).toBe('avg: closed_at is timestamp, not an integer; avg takes: amount_minor')
    expect(refusal({ min: 'owner_id' })).toContain('min takes: name, amount_minor, currency, expected_close_date, closed_at, created_at, updated_at')
    expect(refusal({ max: 'status' })).toContain('status is derived')
  })
  it('a function given empty, an empty term and a repeated term are refused', () => {
    expect(refusal({ sum: '' })).toBe('sum needs at least one field; sum takes: amount_minor')
    expect(refusal({ sum: 'amount_minor,' })).toBe('sum has an empty term')
    expect(refusal({ min: 'closed_at,closed_at' })).toBe('min names closed_at twice')
  })
  it('at most 10 terms in all: 10 pass (a field may be in several functions), 11 are refused', () => {
    const ten = { sum: 'amount_minor', avg: 'amount_minor', min: 'name,amount_minor,currency,expected_close_date,closed_at', max: 'closed_at,created_at' }
    expect(Object.values(parseAggregateTerms(deals, ten)).flat()).toHaveLength(10)
    expect(refusal({ ...ten, max: 'closed_at,created_at,updated_at' })).toBe('at most 10 terms in all: sum, avg, min and max name 11')
  })
})
