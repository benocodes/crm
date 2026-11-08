// Test-only. The registry-wide sort contract of [[CORE170]] D12 and [[CORE175]] D15, as a pure checker over what the registry declares,
// what the real D1 plans show and the two checked-in lists (`storage/sort-costs.ts`). It returns violations instead of throwing, so a test can
// break one input at a time and name the check that must notice.
import type { ColumnKind } from '@vault/storage'
import type { StatedSortCost, SortExemption } from '../storage/sort-costs.js'

/** What the contract reads of a generic list's definition. */
export interface ContractDef {
  readonly name: string
  readonly table: string
  readonly sorts?: readonly string[]
  readonly sortKinds?: Readonly<Record<string, string>>
  readonly record: { readonly shape: Readonly<Record<string, unknown>> }
  readonly derived?: Readonly<Record<string, { readonly kind: string }>>
}
/** A registry list: `def` is its generic prepared-resource definition, `null` when the list is hand-written. */
export interface ContractList { readonly name: string; readonly def: ContractDef | null }
export interface ContractInput {
  readonly lists: readonly ContractList[]
  readonly columns: Readonly<Record<string, Readonly<Record<string, ColumnKind>>>>
  /** `${list}.${sort}` to whether the D1 plan of the list's production query at `order=desc` has `USE TEMP B-TREE FOR ORDER BY`. */
  readonly plans: Readonly<Record<string, { readonly temp: boolean }>>
  readonly costs: readonly StatedSortCost[]
  readonly exemptions: readonly SortExemption[]
}
export type ContractCheck =
  | 'no-sorts' | 'convention' | 'unknown-field' | 'unsortable-kind' | 'kind-mismatch' | 'no-plan'
  | 'missing-cost' | 'obsolete-cost' | 'unknown-cost' | 'duplicate-cost' | 'cost-reason'
  | 'missing-exemption' | 'bad-exemption' | 'duplicate-exemption' | 'exemption-reason'
export interface ContractViolation { readonly check: ContractCheck; readonly list: string; readonly sort?: string; readonly message: string }

const SORTABLE = new Set(['timestamp', 'uuid', 'text', 'integer'])

export function checkSortContract(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = []
  const add = (check: ContractCheck, list: string, sort: string | undefined, message: string) => out.push({ check, list, ...(sort === undefined ? {} : { sort }), message })
  const accepted = new Set<string>()
  const costKeys = new Set(input.costs.map((c) => `${c.list}.${c.sort}`))

  for (const l of input.lists) {
    const def = l.def
    if (!def) continue
    const table = input.columns[def.table] ?? {}
    const sorts = def.sorts ?? []
    if (sorts.length === 0) {
      add('no-sorts', l.name, undefined, `${l.name} accepts no sort`)
      continue
    }
    for (const c of ['id', 'created_at', 'updated_at']) {
      if ((c === 'id' || c in table) && !sorts.includes(c)) add('convention', l.name, c, `${l.name} lacks the convention sort ${c}`)
    }
    for (const s of sorts) {
      accepted.add(`${l.name}.${s}`)
      const kind = s in table ? table[s] : def.derived?.[s]?.kind
      if (kind === undefined || !(s in def.record.shape)) {
        add('unknown-field', l.name, s, `${l.name} declares ${s}, which is not a field of its record backed by a column or a derived field`)
        continue
      }
      if (!SORTABLE.has(kind)) {
        add('unsortable-kind', l.name, s, `${l.name}.${s} is ${kind}, which has no order`)
        continue
      }
      if (def.sortKinds?.[s] !== kind) add('kind-mismatch', l.name, s, `${l.name}.${s} resolved as ${def.sortKinds?.[s]}, metadata says ${kind}`)
      const plan = input.plans[`${l.name}.${s}`]
      if (!plan) add('no-plan', l.name, s, `no D1 plan fact for ${l.name}.${s}`)
      else if (plan.temp && !costKeys.has(`${l.name}.${s}`)) add('missing-cost', l.name, s, `${l.name}.${s} desc needs a temporary sort and has no stated cost`)
      else if (!plan.temp && costKeys.has(`${l.name}.${s}`)) add('obsolete-cost', l.name, s, `${l.name}.${s} is indexed, its stated cost is obsolete`)
    }
  }

  const seen = new Set<string>()
  for (const c of input.costs) {
    const key = `${c.list}.${c.sort}`
    if (!accepted.has(key)) add('unknown-cost', c.list, c.sort, `${key} is not a sort any generic list accepts`)
    if (seen.has(key)) add('duplicate-cost', c.list, c.sort, `${key} is stated twice`)
    seen.add(key)
    if (c.reason.trim() === '') add('cost-reason', c.list, c.sort, `${key} has no reason`)
  }

  const hand = new Set(input.lists.filter((l) => l.def === null).map((l) => l.name))
  const exempt = new Set<string>()
  for (const x of input.exemptions) {
    if (!hand.has(x.list)) add('bad-exemption', x.list, undefined, `${x.list} is not a hand-written registry list`)
    if (exempt.has(x.list)) add('duplicate-exemption', x.list, undefined, `${x.list} is exempt twice`)
    exempt.add(x.list)
    if (x.reason.trim() === '') add('exemption-reason', x.list, undefined, `${x.list} has no reason`)
  }
  for (const name of hand) if (!exempt.has(name)) add('missing-exemption', name, undefined, `${name} is hand-written and not in the exemption list`)
  return out
}
