import type { Expression, SqlBool } from 'kysely'
import type { ColumnKind, QueryContext } from '@vault/storage'
import type { PreparedResource } from './definition.js'

// STUB (red commit): the module's surface, so the tests load and fail on their assertions. The implementation follows in the green commit.

export const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike'] as const
export type Operator = (typeof OPERATORS)[number]
export type FilterKind = 'uuid' | 'text' | 'integer' | 'timestamp' | 'boolean'
export type Operand = string | number | boolean | null
export type Condition = { readonly not: boolean; readonly op: Operator; readonly value: Operand | readonly Operand[] }
export type ColumnFilterSpec = {
  readonly kind: FilterKind
  readonly nullable: boolean
  readonly schema?: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }
  readonly normalize?: (value: unknown, filters: Record<string, unknown>) => unknown
}
const todo = (): never => {
  throw new Error('not implemented')
}
export const operatorsFor = (_kind: FilterKind, _nullable: boolean): readonly Operator[] => todo()
export const parseCondition = (_name: string, _spec: ColumnFilterSpec, _raw: string): Condition => todo()
export const likePattern = (_p: string): string => todo()
export const globPattern = (_p: string): string => todo()
export const compileCondition = (_qc: QueryContext, _column: Expression<unknown>, _kind: FilterKind, _c: Condition): Expression<SqlBool> => todo()
export const describeColumnFilter = (_name: string, _spec: ColumnFilterSpec): string => todo()
export const resolveColumnFilters = (_meta: {
  name: string
  columns: Readonly<Record<string, ColumnKind>>
  record: { shape: Readonly<Record<string, unknown>> }
  filters?: Readonly<Record<string, unknown>>
  customFilters?: Readonly<Record<string, unknown>>
}): Readonly<Record<string, ColumnFilterSpec>> => todo()
export const withColumnFilters = <T extends PreparedResource>(_def: T): T => todo()
