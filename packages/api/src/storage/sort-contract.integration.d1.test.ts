import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLUMN_KINDS, compileOperation, type PreparedOperation } from '@vault/storage'
import type { TenantOperation } from '../registry.js'
import { createVaultRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'
import { crudActions } from '../resources/define.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { checkSortContract, type ContractDef, type ContractInput, type ContractList, type ContractViolation } from '../test/sort-contract.js'
import { SORT_EXEMPT_LISTS, STATED_SORT_COSTS } from './sort-costs.js'

// [[CORE175]] D12, D15: the registry-wide sort contract. The registry's real lists, the real D1 plan of each list's production query at
// `order=desc`, and the two checked-in lists (`sort-costs.ts`) are one input to a pure checker; the strength tests then break that input one
// way at a time and name the check that must notice.
const TEMP = 'USE TEMP B-TREE FOR ORDER BY'
// CORE188 D6: action_executions is a sorted list measured on its own registered operation; only these two stay exempt.
const HAND_WRITTEN = ['associations', 'users']
let e: Engine
let lists: ContractList[]
let base: ContractInput
const planText: Record<string, string> = {}
const defOf = (name: string) => base.lists.find((l) => l.name === name)!.def as ContractDef

beforeAll(async () => {
  e = await openD1Engine()
  const registry = createVaultRegistry()
  const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
  const defs = registry.resources()
  lists = registry.operations().filter((o) => o.kind === 'tenant' && o.name.endsWith('.list')).map((o) => {
    const name = o.name.slice(0, -'.list'.length)
    // A list is generic when its definition generates it, or when its definition declares sorts and its hand-written operation serves it (CORE188 D6).
    const def = defs.find((d) => d.name === name && (crudActions(d).includes('list') || d.sortKinds !== undefined))
    return { name, def: (def ?? null) as ContractDef | null }
  })
  const plans: Record<string, { temp: boolean }> = {}
  for (const l of lists) {
    if (!l.def) continue
    for (const sort of l.def.sorts ?? []) {
      // CORE188 D6: the query production runs, whoever builds it: the list's registered operation (for action_executions it carries the
      // readable-operations predicate), never the generic list of a definition that has no generated list.
      const op = registry.get(`${l.name}.list`) as TenantOperation
      const read = compileOperation((await op.prepare(env, { query: { sort, order: 'desc' }, params: {}, body: undefined })) as PreparedOperation<unknown>, 'd1').reads[0]!
      const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
      planText[`${l.name}.${sort}`] = rows.map((r) => r.detail).join('\n')
      plans[`${l.name}.${sort}`] = { temp: planText[`${l.name}.${sort}`]!.includes(TEMP) }
    }
  }
  base = { lists, columns: COLUMN_KINDS as ContractInput['columns'], plans, costs: STATED_SORT_COSTS, exemptions: SORT_EXEMPT_LISTS }
})
afterAll(async () => {
  for (const [k, v] of Object.entries(planText)) console.info(`PLAN ${k} desc: ${plans(k) ? 'TEMP' : 'indexed'} | ${v.replaceAll('\n', ' ; ')}`)
  await e?.close()
})
const plans = (key: string) => base.plans[key]!.temp
const find = (v: ContractViolation[], check: string, list: string, sort?: string) => v.filter((x) => x.check === check && x.list === list && (sort === undefined || x.sort === sort))
const withDef = (name: string, patch: Partial<ContractDef>): ContractInput => ({ ...base, lists: base.lists.map((l) => (l.name === name ? { name, def: { ...(l.def as ContractDef), ...patch } } : l)) })

describe('the registry satisfies the contract (CORE175 D12, D15)', () => {
  it('has twenty-one sorted lists and exactly the two hand-written ones left out', () => {
    expect(base.lists.filter((l) => l.def === null).map((l) => l.name).sort()).toEqual(HAND_WRITTEN)
    expect(base.lists.filter((l) => l.def !== null)).toHaveLength(21)
  })
  it('every generic list has the convention and a plan fact for every sort it accepts', () => {
    for (const l of base.lists.filter((x) => x.def)) {
      const sorts = l.def!.sorts ?? []
      const table = COLUMN_KINDS[l.def!.table as keyof typeof COLUMN_KINDS] as Record<string, string>
      const convention = ['id', 'created_at', 'updated_at'].filter((c) => c in table)
      expect(sorts.slice(0, convention.length), `${l.name} convention comes first`).toEqual(convention)
      for (const s of sorts) expect(base.plans[`${l.name}.${s}`], `${l.name}.${s}`).toBeDefined()
    }
  })
  it('the stated-cost list is exactly the set of sorts whose desc plan needs a temporary ORDER BY sort, each with a reason', () => {
    const temp = Object.entries(base.plans).filter(([, p]) => p.temp).map(([k]) => k).sort()
    expect(STATED_SORT_COSTS.map((c) => `${c.list}.${c.sort}`).sort()).toEqual(temp)
    for (const c of STATED_SORT_COSTS) expect(c.reason.length, `${c.list}.${c.sort} reason`).toBeGreaterThan(10)
  })
  it('the exemption list is exactly associations and users, each with a reason', () => {
    expect(SORT_EXEMPT_LISTS.map((x) => x.list).sort()).toEqual(HAND_WRITTEN)
    for (const x of SORT_EXEMPT_LISTS) expect(x.reason.length, x.list).toBeGreaterThan(10)
  })
  it('checkSortContract finds no violation in the registry as shipped', () => {
    expect(checkSortContract(base)).toEqual([])
  })
  it('mail plans stay as CORE174 recorded them: occurred_at indexed, created_at a stated temporary sort', () => {
    for (const l of ['messages', 'interactions']) {
      expect(plans(`${l}.occurred_at`), l).toBe(false)
      expect(plans(`${l}.created_at`), l).toBe(true)
    }
    expect(planText['messages.occurred_at']).toContain('idx_messages_occurred')
    expect(planText['interactions.occurred_at']).toContain('idx_interactions_occurred')
  })
})

describe('action_executions is measured as a sorted list on its own query (CORE188 D5, D6)', () => {
  it('accepts exactly the convention and done_at, with a plan fact for each', () => {
    expect(defOf('action_executions').sorts).toEqual(['id', 'created_at', 'updated_at', 'done_at'])
    for (const s of defOf('action_executions').sorts!) expect(base.plans[`action_executions.${s}`], s).toBeDefined()
  })
  it('every stated-cost entry of action_executions is a measured temporary sort', () => {
    const own = STATED_SORT_COSTS.filter((c) => c.list === 'action_executions').map((c) => c.sort)
    expect(own.length).toBeGreaterThan(0)
    for (const s of defOf('action_executions').sorts!) expect(plans(`action_executions.${s}`), s).toBe(own.includes(s))
  })
  it('removing one action_executions stated cost turns the contract red with missing-cost', () => {
    const gone = STATED_SORT_COSTS.find((c) => c.list === 'action_executions')!
    const costs = STATED_SORT_COSTS.filter((c) => c !== gone)
    expect(find(checkSortContract({ ...base, costs }), 'missing-cost', 'action_executions', gone.sort)).toHaveLength(1)
  })
  it('putting action_executions back in the exemptions is a bad exemption, as is exempting it while it is sorted', () => {
    const exemptions = [...SORT_EXEMPT_LISTS, { list: 'action_executions', reason: 'it was hand-written before CORE188 adopted the foundation' }]
    expect(find(checkSortContract({ ...base, exemptions }), 'bad-exemption', 'action_executions')).toHaveLength(1)
  })
  it('a list whose definition lost its sorts is named, not skipped', () => {
    expect(find(checkSortContract(withDef('action_executions', { sorts: [], sortKinds: {} })), 'no-sorts', 'action_executions')).toHaveLength(1)
  })
})

describe('contract checker strength: each fault is noticed by its named check (CORE175 D12, D15)', () => {
  it('the shipped input is clean, so each case below is the only reason for a violation', () => {
    expect(checkSortContract(base)).toEqual([])
  })
  it('a list that lost created_at from its sort set breaks the convention', () => {
    const tasks = defOf('tasks')
    const v = checkSortContract(withDef('tasks', { sorts: tasks.sorts!.filter((s) => s !== 'created_at') }))
    expect(find(v, 'convention', 'tasks', 'created_at')).toHaveLength(1)
  })
  it('a list with no sorts at all is named', () => {
    expect(find(checkSortContract(withDef('notes', { sorts: [], sortKinds: {} })), 'no-sorts', 'notes')).toHaveLength(1)
  })
  it('a declared field that is neither a column nor a derived field is unknown', () => {
    const tasks = defOf('tasks')
    const v = checkSortContract(withDef('tasks', { sorts: [...tasks.sorts!, 'no_such_field'] }))
    expect(find(v, 'unknown-field', 'tasks', 'no_such_field')).toHaveLength(1)
  })
  it('a declared column that is not a field of the record is unknown', () => {
    const tasks = defOf('tasks')
    const v = checkSortContract(withDef('tasks', { sorts: [...tasks.sorts!, 'deleted_at'] }))
    expect(find(v, 'unknown-field', 'tasks', 'deleted_at')).toHaveLength(1)
  })
  it('a boolean and a json field have no order', () => {
    const identities = defOf('identities')
    const agents = defOf('agents')
    expect(find(checkSortContract(withDef('identities', { sorts: [...identities.sorts!, 'own'] })), 'unsortable-kind', 'identities', 'own')).toHaveLength(1)
    expect(find(checkSortContract(withDef('agents', { sorts: [...agents.sorts!, 'scopes'] })), 'unsortable-kind', 'agents', 'scopes')).toHaveLength(1)
  })
  it('a resolved kind that disagrees with the column metadata is named', () => {
    const tasks = defOf('tasks')
    const v = checkSortContract(withDef('tasks', { sortKinds: { ...tasks.sortKinds, due_at: 'text' } }))
    expect(find(v, 'kind-mismatch', 'tasks', 'due_at')).toHaveLength(1)
  })
  it('a missing plan fact is a violation, never a silent pass', () => {
    const { ['tasks.due_at']: _gone, ...plans } = base.plans
    expect(find(checkSortContract({ ...base, plans }), 'no-plan', 'tasks', 'due_at')).toHaveLength(1)
  })
  it('removing a required stated-cost entry names the missing sort', () => {
    const costs = STATED_SORT_COSTS.filter((c) => !(c.list === 'tasks' && c.sort === 'due_at'))
    expect(costs).toHaveLength(STATED_SORT_COSTS.length - 1)
    expect(find(checkSortContract({ ...base, costs }), 'missing-cost', 'tasks', 'due_at')).toHaveLength(1)
  })
  it('a stale entry for the indexed messages occurred_at sort is obsolete', () => {
    const costs = [...STATED_SORT_COSTS, { list: 'messages', sort: 'occurred_at', reason: 'stale: it is indexed (idx_messages_occurred)' }]
    expect(find(checkSortContract({ ...base, costs }), 'obsolete-cost', 'messages', 'occurred_at')).toHaveLength(1)
  })
  it('an entry for a sort no list accepts, or for a list that does not exist, is unknown', () => {
    const none = checkSortContract({ ...base, costs: [...STATED_SORT_COSTS, { list: 'tasks', sort: 'no_such_sort', reason: 'nothing accepts this sort' }] })
    expect(find(none, 'unknown-cost', 'tasks', 'no_such_sort')).toHaveLength(1)
    const ghost = checkSortContract({ ...base, costs: [...STATED_SORT_COSTS, { list: 'no_such_list', sort: 'id', reason: 'nothing lists this resource' }] })
    expect(find(ghost, 'unknown-cost', 'no_such_list', 'id')).toHaveLength(1)
    const exempt = checkSortContract({ ...base, costs: [...STATED_SORT_COSTS, { list: 'users', sort: 'created_at', reason: 'an exempt list accepts no sort' }] })
    expect(find(exempt, 'unknown-cost', 'users', 'created_at')).toHaveLength(1)
  })
  it('a duplicated stated-cost entry and an entry without a reason are named', () => {
    const first = STATED_SORT_COSTS[0]!
    expect(find(checkSortContract({ ...base, costs: [...STATED_SORT_COSTS, first] }), 'duplicate-cost', first.list, first.sort)).toHaveLength(1)
    const blank = STATED_SORT_COSTS.map((c, i) => (i === 0 ? { ...c, reason: ' ' } : c))
    expect(find(checkSortContract({ ...base, costs: blank }), 'cost-reason', first.list, first.sort)).toHaveLength(1)
  })
  it('removing one exemption entry leaves a hand-written list unexplained', () => {
    const exemptions = SORT_EXEMPT_LISTS.filter((x) => x.list !== 'users')
    expect(exemptions).toHaveLength(1)
    expect(find(checkSortContract({ ...base, exemptions }), 'missing-exemption', 'users')).toHaveLength(1)
  })
  it('an exemption naming a generic list, or no list, is refused', () => {
    const generic = checkSortContract({ ...base, exemptions: [...SORT_EXEMPT_LISTS, { list: 'tasks', reason: 'a generic list is never exempt' }] })
    expect(find(generic, 'bad-exemption', 'tasks')).toHaveLength(1)
    const ghost = checkSortContract({ ...base, exemptions: [...SORT_EXEMPT_LISTS, { list: 'no_such_list', reason: 'there is no such list' }] })
    expect(find(ghost, 'bad-exemption', 'no_such_list')).toHaveLength(1)
  })
  it('a duplicated exemption and one without a reason are named', () => {
    const first = SORT_EXEMPT_LISTS[0]!
    expect(find(checkSortContract({ ...base, exemptions: [...SORT_EXEMPT_LISTS, first] }), 'duplicate-exemption', first.list)).toHaveLength(1)
    expect(find(checkSortContract({ ...base, exemptions: SORT_EXEMPT_LISTS.map((x, i) => (i === 0 ? { ...x, reason: '' } : x)) }), 'exemption-reason', first.list)).toHaveLength(1)
  })
})
