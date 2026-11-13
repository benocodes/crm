import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileOperation, type PreparedOperation } from '@vibase/storage'
import type { TenantOperation } from '../registry.js'
import { createVibaseRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { buildSchemaDocument } from '../schema/build.js'
import { parseCondition, type ColumnFilterSpec } from './column-filters.js'
import { deals } from '../resources/deals.js'

// [[CORE202]] D16, D19: the cost sentence of `deals.aggregate` ("a filter schema.get marks `indexed` narrows that read through an index") is backed by the
// real D1 plans, the way [[CORE201]] D12 backs `indexed`. A pure checker over what discovery says and what the plans show; the strength test breaks one input.
let e: Engine
const registry = createVibaseRegistry()
const op = registry.get('deals.aggregate') as TenantOperation
const SAMPLES = ['018f0000-0000-7000-8000-000000000001', 'x', '1', '2026-01-01']

/** The index constraints of the plan's search of `table` (`organization_id=?`, ...), or null when it is not searched through an index. */
export function searchConstraints(details: readonly string[], table: string): string[] | null {
  for (const d of details) {
    const m = new RegExp(`^SEARCH ${table}(?: AS \\w+)? USING (?:COVERING )?INDEX \\S+ \\((.*)\\)$`).exec(d)
    if (m) return m[1]!.split(' AND ').map((term) => term.replace(/[<>=].*$/, ''))
  }
  return null
}

/** Violations of: every filter discovery marks indexed has an aggregate plan that searches deals through an index constraining that column. */
export function aggregateCostViolations(discovery: ReadonlyArray<{ name: string; indexed: boolean }>, plans: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = []
  for (const f of discovery) {
    if (!f.indexed) continue
    const constraints = searchConstraints(plans[f.name] ?? [], 'deals')
    if (!constraints || !constraints.includes(f.name)) out.push(`${f.name} is marked indexed but the aggregate plan does not search deals through an index constraining it`)
  }
  return out
}

const plan = async (query: Record<string, unknown>) => {
  const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
  const compiled = compileOperation((await op.prepare(env, { query, params: {}, body: undefined })) as PreparedOperation<unknown>, 'd1')
  const read = compiled.reads[0]!
  const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
  return { compiled, read, details: rows.map((r) => r.detail) }
}

let discovery: Array<{ name: string; indexed: boolean }>
const plans: Record<string, string[]> = {}
beforeAll(async () => {
  e = await openD1Engine()
  const column = { table_name: 'deals', cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }
  const doc = buildSchemaDocument({ columns: [column], foreignKeys: [], resources: [deals as never] })
  const filters = doc.tables.find((t) => t.name === 'deals')!.resource!.filters
  discovery = filters.filter((f) => !f.custom).map((f) => ({ name: f.name, indexed: f.indexed === true }))
  for (const [name, spec] of Object.entries((deals as unknown as { columnFilters: Record<string, ColumnFilterSpec> }).columnFilters)) {
    const operand = SAMPLES.find((c) => {
      try {
        parseCondition(name, spec, `eq.${c}`, {})
        return true
      } catch {
        return false
      }
    })!
    plans[name] = (await plan({ [name]: `eq.${operand}`, sum: 'amount_minor', currency: name === 'currency' ? `eq.${operand}` : 'eq.USD' })).details
  }
})
afterAll(async () => {
  await e?.close()
})

describe('the aggregate reads what its description says (D16)', () => {
  it('with no filter it is one statement constrained by organization_id only, with no LIMIT', async () => {
    const { compiled, read, details } = await plan({ sum: 'amount_minor', max: 'closed_at', currency: 'eq.USD' })
    const bare = await plan({})
    expect(compiled.reads).toHaveLength(1)
    expect(compiled.statements).toHaveLength(0)
    expect(compiled.mutates).toBe(false)
    expect(bare.read.sql).not.toMatch(/\blimit\b/i)
    expect(read.sql).not.toMatch(/\blimit\b/i)
    expect(searchConstraints(bare.details, 'deals'), bare.details.join(' ; ')).toEqual(['organization_id'])
    expect(details.length).toBeGreaterThan(0)
  })
  it('every deals column filter that discovery marks indexed is served by an index on that column in the aggregate plan', () => {
    expect(discovery.filter((f) => f.indexed).length).toBeGreaterThan(0)
    expect(aggregateCostViolations(discovery, plans)).toEqual([])
  })
  it('strength: marking a non-indexed filter (name) indexed makes the check name it', () => {
    expect(discovery.find((f) => f.name === 'name')!.indexed).toBe(false)
    const lied = discovery.map((f) => (f.name === 'name' ? { ...f, indexed: true } : f))
    expect(aggregateCostViolations(lied, plans)).toEqual(['name is marked indexed but the aggregate plan does not search deals through an index constraining it'])
  })
})
