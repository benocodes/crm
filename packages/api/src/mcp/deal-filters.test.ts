import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { parseListQuery } from '../resources/define.js'
import { deals } from '../resources/deals.js'
import { operatorsFor } from '../storage/column-filters.js'
import { deriveTools, splitArguments } from './tools.js'

// [[CORE200]] D9: the deals list tool takes the grammar as string arguments, and a number argument is an eq.
const registry = createVibaseRegistry()
const entry = deriveTools(registry).find((t) => t.tool.name === 'deals_list')!
const props = (entry.tool.inputSchema as { properties: Record<string, { type?: string; format?: string; description?: string }> }).properties

describe('deals_list (D9)', () => {
  it('each column filter is a string argument whose description lists the operators of its kind; custom filters are as before', () => {
    for (const n of ['amount_minor', 'currency', 'name', 'expected_close_date', 'owner_id', 'closed_at', 'pipeline_id']) expect(props[n]?.type, n).toBe('string')
    expect(props.pipeline_id!.format).toBeUndefined()
    expect(props.amount_minor!.description).toContain(`Operators: ${operatorsFor('integer', true).join(', ')}.`)
    expect(props.tag!.type).toBe('string')
    expect(props.tag_id!.format).toBe('uuid')
  })
  const toQuery = (args: Record<string, unknown>) => splitArguments(entry.op, args).query
  it('"gt.500000" reaches the list as the grammar and a number 500000 as eq', () => {
    expect(toQuery({ amount_minor: 'gt.500000', tag: 'consultancy' })).toEqual({ amount_minor: 'gt.500000', tag: 'consultancy' })
    expect(toQuery({ amount_minor: 500000 })).toEqual({ amount_minor: '500000' })
    const parsed = (q: Record<string, unknown>) => parseListQuery(deals as any, { filters: q as Record<string, string> }).filters.amount_minor
    expect(parsed(toQuery({ amount_minor: 'gt.500000' }))).toMatchObject({ op: 'gt', not: false, value: 500000 })
    expect(parsed(toQuery({ amount_minor: 500000 }))).toMatchObject({ op: 'eq', not: false, value: 500000 })
  })
})
