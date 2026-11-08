// Test-only. The registry-wide sort contract of [[CORE170]] D12 and [[CORE175]] D15, as a pure checker over what the registry declares,
// what the real D1 plans show and the two checked-in lists (`storage/sort-costs.ts`). STUB in the red commit: it finds nothing.
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

export function checkSortContract(_input: ContractInput): ContractViolation[] {
  return []
}
