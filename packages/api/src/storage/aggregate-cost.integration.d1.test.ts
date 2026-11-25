import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileOperation, type PreparedOperation } from '@vibase/storage'
import type { TenantOperation } from '../registry.js'
import { createVibaseRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { buildSchemaDocument } from '../schema/build.js'
import { deals } from '../resources/deals.js'
import { contacts } from '../resources/contacts.js'
import { companies } from '../resources/companies.js'
import { tasks } from '../resources/tasks.js'
import { defineCustomObject } from '../custom/resource.js'
import { PROJECTS_KEY, PROJECTS_REFS, createCustomTables } from '../test/custom-objects.js'

// [[CORE202]] D16, D19, [[CORE615]] D7: the cost sentence of `<list>.aggregate` ("a filter schema.get marks `indexed` narrows that read through an index") is backed by the
// real D1 plans, the way [[CORE201]] D12 backs `indexed`, for each of deals, contacts, companies, tasks and a custom object. A pure checker over what discovery says and what the plans show;
// the strength test breaks one input.
let e: Engine
const custom = defineCustomObject(PROJECTS_KEY, PROJECTS_REFS)
const registry = createVibaseRegistry({ definitions: [custom] })
const SAMPLES = ['018f0000-0000-7000-8000-000000000001', 'x', '1', '2026-01-01', 'example.com', 'open', 'true']

/** The index constraints of the plan's search of `table` (`organization_id=?`, ...), or null when it is not searched through an index. */
export function searchConstraints(details: readonly string[], table: string): string[] | null {
  for (const d of details) {
    const m = new RegExp(`^SEARCH ${table}(?: AS \\w+)? USING (?:COVERING )?INDEX \\S+ \\((.*)\\)$`).exec(d)
    if (m) return m[1]!.split(' AND ').map((term) => term.replace(/[<>=].*$/, ''))
  }
  return null
}

/** Violations of: every filter discovery marks indexed has an aggregate plan that searches the table through an index constraining that column. */
export function aggregateCostViolations(
  discovery: ReadonlyArray<{ name: string; indexed: boolean }>,
  plans: Readonly<Record<string, readonly string[]>>,
  table = 'deals',
): string[] {
  const out: string[] = []
  for (const f of discovery) {
    if (!f.indexed) continue
    const constraints = searchConstraints(plans[f.name] ?? [], table)
    if (!constraints?.includes(f.name))
      out.push(
        `${f.name} is marked indexed but the aggregate plan does not search ${table} through an index constraining it`,
      )
  }
  return out
}

const plan = async (op: TenantOperation, query: Record<string, unknown>) => {
  const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
  const compiled = compileOperation(
    (await op.prepare(env, { query, params: {}, body: undefined })) as PreparedOperation<unknown>,
    'd1',
  )
  const read = compiled.reads[0]!
  const rows = (
    await e
      .d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
      .bind(...read.parameters)
      .all()
  ).results as Array<{ detail: string }>
  return { compiled, read, details: rows.map((r) => r.detail) }
}

const LISTS = [
  { table: 'deals', def: deals, extra: { sum: 'amount_minor', max: 'closed_at' }, money: { currency: 'eq.USD' } },
  { table: 'contacts', def: contacts, extra: { max: 'created_at' }, money: {} },
  { table: 'companies', def: companies, extra: { max: 'created_at' }, money: {} },
  { table: 'tasks', def: tasks, extra: { max: 'due_at' }, money: {} },
  { table: PROJECTS_KEY, def: custom, extra: { sum: 'budget', max: 'stage' }, money: {} },
] as const

beforeAll(async () => {
  e = await openD1Engine()
  await createCustomTables(e.d1!, PROJECTS_KEY, PROJECTS_REFS)
})
afterAll(async () => {
  await e?.close()
})

describe.each(LISTS)(
  'the $table aggregate reads what its description says (D16, CORE615 D7)',
  ({ table, def, extra, money }) => {
    const op = () => registry.get(`${table}.aggregate`) as TenantOperation
    let discovery: Array<{ name: string; indexed: boolean }> = []
    const plans: Record<string, string[]> = {}
    beforeAll(async () => {
      const column = { table_name: table, cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }
      const doc = buildSchemaDocument({ columns: [column], foreignKeys: [], resources: [def as never] })
      const filters = doc.tables.find((t) => t.name === table)!.resource!.filters
      discovery = filters.filter((f) => !f.custom).map((f) => ({ name: f.name, indexed: f.indexed === true }))
      for (const name of Object.keys((def as unknown as { columnFilters: Record<string, unknown> }).columnFilters)) {
        // the first sample the list's own preparation accepts for this filter (a domain, an enum value and a boolean each take their own)
        for (const c of SAMPLES) {
          try {
            plans[name] = (await plan(op(), { ...extra, ...money, [name]: `eq.${c}` })).details
            break
          } catch {
            // try the next sample
          }
        }
        expect(plans[name], `no sample fits ${name}`).toBeDefined()
      }
    })
    it('with no filter it is one statement constrained by organization_id only, with no LIMIT', async () => {
      const { compiled, read, details } = await plan(op(), { ...extra, ...money })
      const bare = await plan(op(), {})
      expect(compiled.reads).toHaveLength(1)
      expect(compiled.statements).toHaveLength(0)
      expect(compiled.mutates).toBe(false)
      expect(bare.read.sql).not.toMatch(/\blimit\b/i)
      expect(read.sql).not.toMatch(/\blimit\b/i)
      expect(searchConstraints(bare.details, table), bare.details.join(' ; ')).toEqual(['organization_id'])
      expect(details.length).toBeGreaterThan(0)
    })
    it('every column filter that discovery marks indexed is served by an index on that column in the aggregate plan', () => {
      expect(discovery.filter((f) => f.indexed).length).toBeGreaterThan(0)
      expect(aggregateCostViolations(discovery, plans, table)).toEqual([])
    })
    it('strength: marking a non-indexed filter indexed makes the check name it', () => {
      const victim = discovery.find((f) => !f.indexed && plans[f.name])!
      const lied = discovery.map((f) => (f === victim ? { ...f, indexed: true } : f))
      expect(aggregateCostViolations(lied, plans, table)).toEqual([
        `${victim.name} is marked indexed but the aggregate plan does not search ${table} through an index constraining it`,
      ])
    })
  },
)
