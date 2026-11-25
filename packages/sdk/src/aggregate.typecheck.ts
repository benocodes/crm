// Type-level tests (DX616 D3, D4): run by `pnpm -C packages/sdk typecheck`, on the built-in client and on the committed workspace map.
// Every positive case asserts the exact type; each negative carries a positive sibling, and a negative that stops erroring is TS2578.
import { createClient } from './index.js'
import { workspaceOperations } from './generate/fixtures/workspace/operations.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const vibase = createClient({ url: 'https://api.acme.example', auth: 't' })
const workspace = createClient({ url: 'https://api.acme.example', auth: 't', operations: workspaceOperations })

export async function argumentTypes() {
  // a field the function takes, one or an array; filters stay typed
  await vibase.deals.aggregate({ status: 'open', sum: 'amount_minor' })
  await vibase.deals.aggregate({ min: ['created_at', 'name'], max: 'updated_at' })
  await vibase.deals.aggregate()
  await vibase.deals.aggregate({ amount_minor: { gte: 5 } })
  // a computed array (not a literal tuple) is accepted when every member is a field of the function
  const computed: ReadonlyArray<'created_at' | 'name'> = ['created_at', 'name']
  const fromComputed = await vibase.deals.aggregate({ min: computed })
  type _computed = Expect<Equal<(typeof fromComputed)['min'], { created_at: string | null; name: string | null }>>
  const wide: ReadonlyArray<'created_at' | 'name' | 'nope'> = ['created_at']
  // @ts-expect-error a computed array with a field outside the list
  await vibase.deals.aggregate({ min: wide })
  // @ts-expect-error sum takes amount_minor only
  await vibase.deals.aggregate({ sum: 'name' })
  // @ts-expect-error a field of the array that the function does not take
  await vibase.deals.aggregate({ avg: ['amount_minor', 'name'] })
  // @ts-expect-error a comma-joined string is not a field
  await vibase.deals.aggregate({ min: 'created_at,name' })
  // @ts-expect-error a filter operand of the wrong kind
  await vibase.deals.aggregate({ amount_minor: { gte: 'lots' } })
  // @ts-expect-error not an argument of the operation
  await vibase.deals.aggregate({ nope: 1 })

  // group_by: one groupable field, a tuple of one or two
  await vibase.deals.aggregate({ group_by: 'stage_id' })
  await vibase.deals.aggregate({ group_by: ['stage_id', 'currency'] })
  await vibase.deals.aggregate({ group_by: ['stage_id'] })
  // @ts-expect-error created_at is not groupable
  await vibase.deals.aggregate({ group_by: 'created_at' })
  // @ts-expect-error three group fields
  await vibase.deals.aggregate({ group_by: ['stage_id', 'currency', 'name'] })
  // @ts-expect-error a comma-joined string
  await vibase.deals.aggregate({ group_by: 'stage_id,currency' })

  // tasks: no integer column, so sum and avg are not parameters
  await vibase.tasks.aggregate({ status: 'open', group_by: 'assignee_id' })
  // @ts-expect-error tasks has no sum parameter
  await vibase.tasks.aggregate({ sum: 'title' })
  // @ts-expect-error tasks has no avg parameter
  await vibase.tasks.aggregate({ avg: 'title' })

  // the workspace's custom object takes its own fields, not another object's
  await workspace.projects__c.aggregate({ group_by: 'stage', sum: 'budget' })
  await workspace.projects__c.aggregate({ min: ['name', 'budget'] })
  // @ts-expect-error amount_minor is a deals field
  await workspace.projects__c.aggregate({ sum: 'amount_minor' })
  // @ts-expect-error a third group field is refused on a custom object too
  await workspace.projects__c.aggregate({ group_by: ['stage', 'name', 'budget'] })
  // and a built-in's declared __c field is aggregatable on the workspace client
  await workspace.contacts.aggregate({ group_by: 'tier__c' })
}

export async function answerTypes() {
  // ungrouped: count plus only the asked functions, and currency for an asked money field
  const total = await vibase.deals.aggregate({ status: 'open', sum: 'amount_minor' })
  type T = typeof total
  type _k = Expect<Equal<keyof T, 'count' | 'sum' | 'currency'>>
  type _c = Expect<Equal<T['count'], number>>
  type _s = Expect<Equal<T['sum'], { amount_minor: number | null }>>
  type _cur = Expect<Equal<T['currency'], { amount_minor: string | null }>>
  // @ts-expect-error avg was not asked
  total.avg
  // @ts-expect-error groups only come with group_by
  total.groups

  // min and max carry the field's kind: an integer is a number, a timestamp and text are strings
  const range = await vibase.deals.aggregate({ min: ['created_at', 'amount_minor'], max: 'name' })
  type _min = Expect<Equal<(typeof range)['min'], { created_at: string | null; amount_minor: number | null }>>
  type _max = Expect<Equal<(typeof range)['max'], { name: string | null }>>
  type _rk = Expect<Equal<keyof typeof range, 'count' | 'min' | 'max' | 'currency'>>
  type _rcur = Expect<Equal<(typeof range)['currency'], { amount_minor: string | null }>>

  // no money field asked: no currency key
  const names = await vibase.deals.aggregate({ min: 'name' })
  type _nk = Expect<Equal<keyof typeof names, 'count' | 'min'>>

  // grouped: { count, groups } with no function key at the top; keys by kind, always with null
  const grouped = await vibase.deals.aggregate({ group_by: ['stage_id', 'amount_minor'], sum: 'amount_minor' })
  type _gk = Expect<Equal<keyof typeof grouped, 'count' | 'groups'>>
  type G = (typeof grouped)['groups'][number]
  type _key = Expect<Equal<G['key'], { stage_id: string | null; amount_minor: number | null }>>
  type _gs = Expect<Equal<G['sum'], { amount_minor: number | null }>>
  type _gcur = Expect<Equal<G['currency'], { amount_minor: string | null }>>
  type _gc = Expect<Equal<G['count'], number>>
  // @ts-expect-error a grouped answer has no top-level sum
  grouped.sum

  const single = await vibase.tasks.aggregate({ group_by: 'assignee_id' })
  type _single = Expect<Equal<(typeof single)['groups'][number]['key'], { assignee_id: string | null }>>
  const flags = await workspace.projects__c.aggregate({ group_by: ['stage', 'name'], max: 'name' })
  type _flag = Expect<Equal<(typeof flags)['groups'][number]['key'], { stage: string | null; name: string | null }>>
  type _flagmax = Expect<Equal<(typeof flags)['groups'][number]['max'], { name: string | null }>>

  // an optional group_by is the union of both answers
  const maybe: 'stage_id' | undefined = Math.random() > 0.5 ? 'stage_id' : undefined
  const either = await vibase.deals.aggregate({ group_by: maybe })
  if ('groups' in either) {
    const g: string | null = either.groups[0].key.stage_id
    void g
  } else {
    const n: number = either.count
    void n
  }
  // @ts-expect-error the union has no groups on one side
  either.groups

  // the workspace's custom object and a __c field of a built-in answer typed too
  const projects = await workspace.projects__c.aggregate({ sum: 'budget', group_by: 'stage' })
  type _p = Expect<Equal<(typeof projects)['groups'][number]['sum'], { budget: number | null }>>
  const tiers = await workspace.contacts.aggregate({ group_by: 'tier__c' })
  type _t = Expect<Equal<(typeof tiers)['groups'][number]['key'], { tier__c: string | null }>>
  void ({} as [
    _k,
    _c,
    _s,
    _cur,
    _min,
    _max,
    _rk,
    _rcur,
    _nk,
    _gk,
    _key,
    _gs,
    _gcur,
    _gc,
    _single,
    _flag,
    _flagmax,
    _p,
    _t,
  ])
}
