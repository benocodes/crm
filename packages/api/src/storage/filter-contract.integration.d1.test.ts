import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileOperation, type PreparedOperation } from '@vibase/storage'
import type { TenantOperation } from '../registry.js'
import { createVaultRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'
import { crudActions } from '../resources/define.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { checkFilterContract, type FilterContractDef, type FilterContractInput, type FilterContractList, type FilterContractViolation } from '../test/filter-contract.js'
import { describeColumnFilter, parseCondition, type ColumnFilterSpec } from './column-filters.js'
import { FILTER_EXEMPT_LISTS, STATED_FILTER_COSTS } from './filter-costs.js'

// [[CORE201]] D10, D12, D18: the registry-wide filter contract. The registry's real lists, the real D1 plan of each list's production query at
// `<column>=eq.<value>` with the default order, the checked-in lists (`filter-costs.ts`) and the NOCASE columns of the real D1 schema are one input to a
// pure checker; the strength tests then break that input one way at a time and name the check that must notice.
const HAND_WRITTEN = ['associations', 'events', 'users', 'webhooks']
// A filter value that parses as its kind and passes the column's own option (an enum, a UUID, a domain, a SHA-256), tried in order.
const SAMPLES = ['018f0000-0000-7000-8000-000000000001', 'example.com', 'x', 'a@example.com', '0'.repeat(64), '1', '2026-01-01', 'true']
// identities.value is normalised by its kind, so the call carries `kind=email` (the plan then has both predicates).
const COMPANIONS: Record<string, Record<string, string>> = { 'identities.value': { kind: 'email' } }
let e: Engine
let base: FilterContractInput
const planText: Record<string, string> = {}
const defOf = (name: string) => base.lists.find((l) => l.name === name)!.def as FilterContractDef & { columnFilters: Record<string, ColumnFilterSpec & { collation?: string }>; record: unknown }

/** Whether the plan searches `table` through an index whose constraints include `column`. */
export function indexedOn(details: readonly string[], table: string, column: string): boolean {
  for (const d of details) {
    const m = new RegExp(`^SEARCH ${table}(?: AS \\w+)? USING (?:COVERING )?INDEX \\S+ \\((.*)\\)$`).exec(d)
    if (m && m[1]!.split(' AND ').some((term) => new RegExp(`^${column}[=<>]`).test(term))) return true
  }
  return false
}

async function nocaseColumns(): Promise<Set<string>> {
  const rows = (await e.d1!.prepare("select name, sql from sqlite_master where type = 'table' and sql is not null").all()).results as Array<{ name: string; sql: string }>
  const out = new Set<string>()
  for (const r of rows) for (const line of r.sql.split('\n')) {
    const m = /^\s*"?(\w+)"?\s+TEXT\b.*COLLATE NOCASE/i.exec(line)
    if (m) out.add(`${r.name}.${m[1]}`)
  }
  return out
}

beforeAll(async () => {
  e = await openD1Engine()
  const registry = createVaultRegistry()
  const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
  const defs = registry.resources()
  const lists: FilterContractList[] = registry.operations().filter((o) => o.kind === 'tenant' && o.name.endsWith('.list')).map((o) => {
    const name = o.name.slice(0, -'.list'.length)
    const def = defs.find((d) => d.name === name && (crudActions(d).includes('list') || d.sortKinds !== undefined))
    return { name, def: (def ?? null) as FilterContractDef | null }
  })
  const plans: Record<string, { indexed: boolean }> = {}
  const descriptions: Record<string, string> = {}
  for (const l of lists) {
    for (const [filter, spec] of Object.entries(l.def?.columnFilters ?? {}) as Array<[string, ColumnFilterSpec]>) {
      const key = `${l.name}.${filter}`
      descriptions[key] = describeColumnFilter(filter, spec)
      const companions = COMPANIONS[key] ?? {}
      const options = (spec.schema as unknown as { options?: string[] } | undefined)?.options ?? []
      const operand = [...SAMPLES, ...options].find((c) => {
        try {
          parseCondition(filter, spec, `eq.${c}`, companions)
          return true
        } catch {
          return false
        }
      })
      if (operand === undefined) throw new Error(`no sample operand parses for ${key}`)
      const op = registry.get(`${l.name}.list`) as TenantOperation
      const read = compileOperation((await op.prepare(env, { query: { ...companions, [filter]: `eq.${operand}` }, params: {}, body: undefined })) as PreparedOperation<unknown>, 'd1').reads[0]!
      const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
      const details = rows.map((r) => r.detail)
      planText[key] = details.join(' ; ')
      plans[key] = { indexed: indexedOn(details, l.def!.table, filter) }
    }
  }
  base = { lists, plans, costs: STATED_FILTER_COSTS, exemptions: FILTER_EXEMPT_LISTS, descriptions, nocase: await nocaseColumns() }
})
afterAll(async () => {
  for (const [k, v] of Object.entries(planText)) console.info(`PLAN ${k} eq: ${base.plans[k]!.indexed ? 'indexed' : 'stated'} | ${v}`)
  await e?.close()
})
const find = (v: FilterContractViolation[], check: string, list: string, filter?: string) => v.filter((x) => x.check === check && x.list === list && (filter === undefined || x.filter === filter))
const withDef = (name: string, patch: Partial<FilterContractDef>): FilterContractInput => ({ ...base, lists: base.lists.map((l) => (l.name === name ? { name, def: { ...(l.def as FilterContractDef), ...patch } } : l)) })

describe('the registry satisfies the filter contract (CORE201 D10, D12, D18)', () => {
  it('has twenty-one generic lists with column filters and exactly the four hand-written ones left out', () => {
    expect(base.lists.filter((l) => l.def === null).map((l) => l.name).sort()).toEqual(HAND_WRITTEN)
    const generic = base.lists.filter((l) => l.def !== null)
    expect(generic).toHaveLength(21)
    for (const l of generic) expect(Object.keys(l.def!.columnFilters ?? {}).length, `${l.name} column filters`).toBeGreaterThan(0)
  })
  it('the exemption list is exactly associations, events, users and webhooks, each with a reason', () => {
    expect(FILTER_EXEMPT_LISTS.map((x) => x.list).sort()).toEqual(HAND_WRITTEN)
    for (const x of FILTER_EXEMPT_LISTS) expect(x.reason.length, x.list).toBeGreaterThan(10)
  })
  it('every list x column filter has a plan fact; the stated-cost list is exactly the filters whose eq plan is not indexed, each with a reason', () => {
    const keys = base.lists.flatMap((l) => Object.keys(l.def?.columnFilters ?? {}).map((f) => `${l.name}.${f}`))
    expect(keys.length).toBeGreaterThan(100)
    for (const k of keys) expect(base.plans[k], k).toBeDefined()
    const stated = keys.filter((k) => !base.plans[k]!.indexed).sort()
    expect(STATED_FILTER_COSTS.map((c) => `${c.list}.${c.filter}`).sort()).toEqual(stated)
    for (const c of STATED_FILTER_COSTS) expect(c.reason.length, `${c.list}.${c.filter} reason`).toBeGreaterThan(10)
  })
  it('the id filter and the organisation-leading unique indexes are the indexed ones the plan reader sees', () => {
    expect(base.plans['tasks.id']!.indexed).toBe(true)
    expect(base.plans['tasks.title']!.indexed).toBe(false)
    expect(indexedOn(['SEARCH tasks USING INDEX tasks_x (organization_id=? AND id=?)'], 'tasks', 'id')).toBe(true)
    expect(indexedOn(['SEARCH tasks USING INDEX tasks_x (organization_id=?)'], 'tasks', 'id')).toBe(false)
    expect(indexedOn(['SCAN tasks'], 'tasks', 'id')).toBe(false)
  })
  it('checkFilterContract finds no violation in the registry as shipped', () => {
    expect(checkFilterContract(base)).toEqual([])
  })
})

describe('text descriptions follow the column collation (D18)', () => {
  it('the set of text column filters that say they fold case equals the NOCASE columns of the D1 schema, both ways', () => {
    const folding = base.lists.flatMap((l) => Object.keys(l.def?.columnFilters ?? {}).filter((f) => base.descriptions[`${l.name}.${f}`]?.includes('Comparison folds ASCII case')).map((f) => `${l.def!.table}.${f}`)).sort()
    expect(folding).toEqual([...base.nocase].filter((c) => base.lists.some((l) => l.def && c.startsWith(`${l.def.table}.`))).sort())
    expect(folding).toEqual(['pipeline_stages.name', 'pipelines.name', 'tags.name'])
  })
  it('a NOCASE column marked byte-order, and a byte-order column that claims to fold, are both named', () => {
    const nocase = new Set([...base.nocase].filter((c) => c !== 'tags.name'))
    expect(find(checkFilterContract({ ...base, nocase }), 'collation-text', 'tags', 'name')).toHaveLength(1)
    const extra = new Set([...base.nocase, 'deals.name'])
    expect(find(checkFilterContract({ ...base, nocase: extra }), 'collation-text', 'deals', 'name')).toHaveLength(1)
  })
})

describe('contract checker strength: each fault is noticed by its named check (CORE201 D10, D12)', () => {
  it('a generic list without column filters is named', () => {
    expect(find(checkFilterContract(withDef('notes', { columnFilters: {} })), 'no-column-filters', 'notes')).toHaveLength(1)
    expect(find(checkFilterContract(withDef('tasks', { columnFilters: undefined })), 'no-column-filters', 'tasks')).toHaveLength(1)
  })
  it('a missing plan fact is a violation, never a silent pass', () => {
    const { ['tasks.title']: _gone, ...plans } = base.plans
    expect(find(checkFilterContract({ ...base, plans }), 'no-plan', 'tasks', 'title')).toHaveLength(1)
  })
  it('removing one required stated-cost entry names the missing filter', () => {
    const gone = STATED_FILTER_COSTS[0]!
    const costs = STATED_FILTER_COSTS.filter((c) => c !== gone)
    expect(find(checkFilterContract({ ...base, costs }), 'missing-cost', gone.list, gone.filter)).toHaveLength(1)
  })
  it('an entry for an indexed filter is obsolete', () => {
    const costs = [...STATED_FILTER_COSTS, { list: 'tasks', filter: 'id', reason: 'stale: the id filter is served by the primary key index' }]
    expect(find(checkFilterContract({ ...base, costs }), 'obsolete-cost', 'tasks', 'id')).toHaveLength(1)
  })
  it('an entry for a filter no list has, or for a list that does not exist, is unknown', () => {
    const none = checkFilterContract({ ...base, costs: [...STATED_FILTER_COSTS, { list: 'tasks', filter: 'no_such_filter', reason: 'nothing has this filter' }] })
    expect(find(none, 'unknown-cost', 'tasks', 'no_such_filter')).toHaveLength(1)
    const ghost = checkFilterContract({ ...base, costs: [...STATED_FILTER_COSTS, { list: 'no_such_list', filter: 'id', reason: 'nothing lists this resource' }] })
    expect(find(ghost, 'unknown-cost', 'no_such_list', 'id')).toHaveLength(1)
    const exempt = checkFilterContract({ ...base, costs: [...STATED_FILTER_COSTS, { list: 'users', filter: 'id', reason: 'an exempt list has no column filters' }] })
    expect(find(exempt, 'unknown-cost', 'users', 'id')).toHaveLength(1)
  })
  it('a duplicated stated-cost entry and an entry without a reason are named', () => {
    const first = STATED_FILTER_COSTS[0]!
    expect(find(checkFilterContract({ ...base, costs: [...STATED_FILTER_COSTS, first] }), 'duplicate-cost', first.list, first.filter)).toHaveLength(1)
    const blank = STATED_FILTER_COSTS.map((c, i) => (i === 0 ? { ...c, reason: ' ' } : c))
    expect(find(checkFilterContract({ ...base, costs: blank }), 'cost-reason', first.list, first.filter)).toHaveLength(1)
  })
  it('removing one exemption leaves a hand-written list unexplained; a generic or unknown list is a bad exemption', () => {
    expect(find(checkFilterContract({ ...base, exemptions: FILTER_EXEMPT_LISTS.filter((x) => x.list !== 'users') }), 'missing-exemption', 'users')).toHaveLength(1)
    expect(find(checkFilterContract({ ...base, exemptions: [...FILTER_EXEMPT_LISTS, { list: 'tasks', reason: 'a generic list is never exempt' }] }), 'bad-exemption', 'tasks')).toHaveLength(1)
    expect(find(checkFilterContract({ ...base, exemptions: [...FILTER_EXEMPT_LISTS, { list: 'no_such_list', reason: 'there is no such list' }] }), 'bad-exemption', 'no_such_list')).toHaveLength(1)
  })
  it('a duplicated exemption and one without a reason are named', () => {
    const first = FILTER_EXEMPT_LISTS[0]!
    expect(find(checkFilterContract({ ...base, exemptions: [...FILTER_EXEMPT_LISTS, first] }), 'duplicate-exemption', first.list)).toHaveLength(1)
    expect(find(checkFilterContract({ ...base, exemptions: FILTER_EXEMPT_LISTS.map((x, i) => (i === 0 ? { ...x, reason: '' } : x)) }), 'exemption-reason', first.list)).toHaveLength(1)
  })
})
