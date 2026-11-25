import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { coldStorage } from '../test/storage.js'
import { actionExecutions } from '../executions/definition.js'
import { deriveTools } from '../mcp/tools.js'
import { MAX_CONDITIONS, columnFilterParams, operatorsFor, type ColumnFilterSpec } from './column-filters.js'

// [[CORE602]] D4 (group 4): every column filter of every list in the OpenAPI document is a string or an array of 1 to MAX_CONDITIONS strings, with
// `x-vibase-filter` { kind, operators } computed from the operator table; nothing else carries the extension.
const registry = createVibaseRegistry()
const doc = async () =>
  (await (await createApp({ storage: coldStorage(), registry }).request('/api/v1/openapi.json')).json()) as any
/** The parameters of an operation of the records document; none for a configuration-surface list, which that document does not carry. */
const parametersOf = (d: any, operationId: string): any[] => {
  for (const item of Object.values<any>(d.paths))
    for (const o of Object.values<any>(item)) if (o.operationId === operationId) return o.parameters
  return []
}
const lists = (): Array<{ operationId: string; columns: Readonly<Record<string, ColumnFilterSpec>> }> => [
  ...registry
    .resources()
    .filter((d) => d.columnFilters)
    .map((d) => ({ operationId: `${d.name}.list`, columns: d.columnFilters! })),
  { operationId: 'action_executions.list', columns: actionExecutions.columnFilters },
]

describe('the OpenAPI parameter of a column filter (D4)', () => {
  it('is anyOf string / array (minItems 1, maxItems MAX_CONDITIONS) with x-vibase-filter, on every list', async () => {
    const d = await doc()
    let seen = 0
    for (const { operationId, columns } of lists()) {
      const params = parametersOf(d, operationId)
      for (const [name, spec] of Object.entries(columns)) {
        const p = params.find((x) => x.name === name)
        if (!p) continue
        seen++
        const where = `${operationId} ${name}`
        expect(p.schema.anyOf, where).toEqual([
          { type: 'string' },
          { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CONDITIONS },
        ])
        expect(p['x-vibase-filter'], where).toEqual({
          kind: spec.kind,
          operators: operatorsFor(spec.kind, spec.nullable),
        })
      }
    }
    expect(seen).toBeGreaterThan(40)
    expect(MAX_CONDITIONS).toBe(4)
  })
  it('`is` is present exactly when the field is nullable', async () => {
    const d = await doc()
    const ops = (op: string, name: string) =>
      parametersOf(d, op).find((p) => p.name === name)['x-vibase-filter'].operators
    expect(ops('deals.list', 'expected_close_date')).toContain('is')
    expect(ops('deals.list', 'name')).not.toContain('is')
  })
  it('custom filters, the bag filter and list parameters carry no extension', async () => {
    const d = await doc()
    const params = parametersOf(d, 'deals.list')
    for (const name of ['tag', 'tag_id', 'additional_props', 'after', 'limit', 'sort', 'order']) {
      const p = params.find((x) => x.name === name)
      expect(p, name).toBeDefined()
      expect(p['x-vibase-filter'], name).toBeUndefined()
    }
    expect(params.find((x) => x.name === 'tag').schema.anyOf).toBeUndefined()
  })
  it('the MCP tool schema of a column filter is the same anyOf', () => {
    const entry = deriveTools(registry).find((t) => t.tool.name === 'deals_list')!
    const p = (entry.tool.inputSchema as any).properties.expected_close_date
    expect(p.anyOf).toEqual([
      { type: 'string' },
      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CONDITIONS },
    ])
  })
  it('columnFilterParams accepts one string or 1 to 4 strings, and nothing else', () => {
    const p = columnFilterParams({ columnFilters: { n: { kind: 'text', nullable: false } } }).n!
    expect(p.safeParse('gt.1').success).toBe(true)
    expect(p.safeParse(undefined).success).toBe(true)
    expect(p.safeParse(['a', 'b', 'c', 'd']).success).toBe(true)
    expect(p.safeParse([]).success).toBe(false)
    expect(p.safeParse(['a', 'b', 'c', 'd', 'e']).success).toBe(false)
    expect(z.object({ n: p }).safeParse({ n: 5 }).success).toBe(false)
  })
})
