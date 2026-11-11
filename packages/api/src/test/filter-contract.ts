// Test-only. The registry-wide filter contract of [[CORE199]] D10, D12 and D18, as a pure checker over what the registry declares, what the real D1 plans
// show and the two checked-in lists (`storage/filter-costs.ts`). Like `sort-contract.ts` it returns violations instead of throwing, so a test can break one
// input at a time and name the check that must notice.
import type { FilterExemption, StatedFilterCost } from '../storage/filter-costs.js'

export interface FilterContractDef {
  readonly name: string
  readonly table: string
  readonly columnFilters?: Readonly<Record<string, { readonly kind: string }>>
}
/** A registry list: `def` is its generic prepared-resource definition, `null` when the list is hand-written. */
export interface FilterContractList { readonly name: string; readonly def: FilterContractDef | null }
export interface FilterContractInput {
  readonly lists: readonly FilterContractList[]
  /** `${list}.${filter}` to whether the D1 plan of the list's production query at `filter=eq.<value>` searches the list table through an index that constrains the column. */
  readonly plans: Readonly<Record<string, { readonly indexed: boolean }>>
  readonly costs: readonly StatedFilterCost[]
  readonly exemptions: readonly FilterExemption[]
  /** `${list}.${filter}` to the generated parameter description. */
  readonly descriptions: Readonly<Record<string, string>>
  /** `table.column` of every NOCASE column of the D1 schema. */
  readonly nocase: ReadonlySet<string>
}
export type FilterContractCheck =
  | 'no-column-filters' | 'no-plan' | 'missing-cost' | 'obsolete-cost' | 'unknown-cost' | 'duplicate-cost' | 'cost-reason'
  | 'missing-exemption' | 'bad-exemption' | 'duplicate-exemption' | 'exemption-reason' | 'collation-text'
export interface FilterContractViolation { readonly check: FilterContractCheck; readonly list: string; readonly filter?: string; readonly message: string }

export const FOLDS = 'Comparison folds ASCII case'
export const BYTES = 'Comparison is by byte order'

export function checkFilterContract(input: FilterContractInput): FilterContractViolation[] {
  const out: FilterContractViolation[] = []
  const add = (check: FilterContractCheck, list: string, filter: string | undefined, message: string) => out.push({ check, list, ...(filter === undefined ? {} : { filter }), message })
  const accepted = new Set<string>()
  const costKeys = new Set(input.costs.map((c) => `${c.list}.${c.filter}`))

  for (const l of input.lists) {
    const def = l.def
    if (!def) continue
    const filters = Object.entries(def.columnFilters ?? {})
    if (filters.length === 0) {
      add('no-column-filters', l.name, undefined, `${l.name} has no column filters`)
      continue
    }
    for (const [f, spec] of filters) {
      const key = `${l.name}.${f}`
      accepted.add(key)
      const plan = input.plans[key]
      if (!plan) add('no-plan', l.name, f, `no D1 plan fact for ${key}`)
      else if (!plan.indexed && !costKeys.has(key)) add('missing-cost', l.name, f, `${key} eq is not indexed and has no stated cost`)
      else if (plan.indexed && costKeys.has(key)) add('obsolete-cost', l.name, f, `${key} is indexed, its stated cost is obsolete`)
      if (spec.kind === 'text') {
        const text = input.descriptions[key] ?? ''
        const folds = input.nocase.has(`${def.table}.${f}`)
        if (!text.includes(folds ? FOLDS : BYTES) || text.includes(folds ? BYTES : FOLDS)) add('collation-text', l.name, f, `${key} description must say ${folds ? 'it folds ASCII case' : 'byte order'}`)
      }
    }
  }

  const seen = new Set<string>()
  for (const c of input.costs) {
    const key = `${c.list}.${c.filter}`
    if (!accepted.has(key)) add('unknown-cost', c.list, c.filter, `${key} is not a column filter any generic list has`)
    if (seen.has(key)) add('duplicate-cost', c.list, c.filter, `${key} is stated twice`)
    seen.add(key)
    if (c.reason.trim() === '') add('cost-reason', c.list, c.filter, `${key} has no reason`)
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
