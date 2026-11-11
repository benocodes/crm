// RED STUB ([[CORE202]]): the smallest surface the red tests import. Replaced by the implementation in the next commit.
import type { PreparedResource } from './definition.js'

export const AGGREGATE_FUNCTIONS = ['sum', 'avg', 'min', 'max'] as const
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number]
export type AggregateSpec = { readonly fields: Readonly<Record<AggregateFunction, readonly string[]>>; readonly money: Readonly<Record<string, string>> }

export function withAggregate<T extends PreparedResource>(_def: T, _money: Readonly<Record<string, string>> = {}): T & { readonly aggregate: AggregateSpec } {
  throw new Error('not implemented')
}
export function parseAggregateTerms(_def: unknown, _raw: Partial<Record<AggregateFunction, unknown>>): Record<AggregateFunction, string[]> {
  throw new Error('not implemented')
}
