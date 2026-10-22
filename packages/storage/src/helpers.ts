import type { Expression, ExpressionBuilder, SelectQueryBuilder, SqlBool } from 'kysely'
import type { ColumnOf, PublicColumn, RowOf, StorageDatabase, Table, ValueOf } from './database.js'
import type { QueryContext } from './types.js'

// The ONE reviewed adapter boundary of the generic helpers ([[CORE35]] D3): Kysely cannot relate a generic
// table name to its columns through `selectFrom`/`select`/`ref`, so these three casts live in this file and
// nowhere else. Every exported signature is fully typed, and query-types.typecheck.ts proves call sites still
// reject bad tables, columns, values and projections.

type Loose = { selectFrom(table: string): { select(columns: readonly string[]): unknown } }

/** A typed `select <columns> from <table>`: the output is the exact Pick of the table's row. */
export function selectColumns<T extends Table, C extends ColumnOf<T>>(
  qc: QueryContext,
  table: T,
  columns: readonly C[],
): SelectQueryBuilder<StorageDatabase, T, Pick<RowOf<T>, C>> {
  return (qc.db as unknown as Loose).selectFrom(table).select(columns) as SelectQueryBuilder<StorageDatabase, T, Pick<RowOf<T>, C>>
}

/** Like `selectColumns`, but secret columns are a compile error: for public (record) projections. */
export function publicSelect<T extends Table, C extends PublicColumn<T>>(
  qc: QueryContext,
  table: T,
  columns: readonly C[],
): SelectQueryBuilder<StorageDatabase, T, Pick<RowOf<T>, C>> {
  return selectColumns(qc, table, columns)
}

/** `table.column = value` (or `is null`), checked against the column's value type. */
export function eq<T extends Table, C extends ColumnOf<T>>(
  table: T,
  column: C,
  value: ValueOf<T, C>,
): (eb: ExpressionBuilder<StorageDatabase, T>) => Expression<SqlBool> {
  return (eb) => {
    const loose = eb as unknown as (lhs: unknown, op: string, rhs: unknown) => Expression<SqlBool>
    const ref = (eb as unknown as { ref(path: string): unknown }).ref(`${table}.${column}`)
    return value === null ? loose(ref, 'is', null) : loose(ref, '=', value)
  }
}

/**
 * Asserts a select's output satisfies the record `R` the caller will decode it as. `projectAs<R>()(query)`:
 * an incompatible or incomplete projection is a compile error at the call.
 */
export function projectAs<R extends object>(): <T extends Table, O extends R>(query: SelectQueryBuilder<StorageDatabase, T, O>) => SelectQueryBuilder<StorageDatabase, T, O> {
  return (query) => query
}

/** Resolves to `never` for a Promise, so a hook that must be synchronous rejects an async function. */
export type NotPromise<R> = R extends PromiseLike<unknown> ? never : R
/** A synchronous, database-free extension hook (D3): `(input) => fragment`, never `Promise`. */
export type SyncHook<I, R extends object> = (input: I) => NotPromise<R>
