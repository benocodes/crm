import { sql, type Expression, type SqlBool } from 'kysely'
import { COLUMN_KINDS, type ColumnOf, type PhysicalTable } from './database.js'
import { SetLimitExceeded } from './errors.js'
import type { QueryContext } from './types.js'

/**
 * Refuses an id list larger than the runtime's cap, before any statement exists ([[CORE35]] D7). The cap is a
 * runtime property: a domain program passes its ids through here and never names a number.
 */
export function boundIds(qc: QueryContext, ids: readonly string[]): readonly string[] {
  if (ids.length > qc.maxSetSize) throw new SetLimitExceeded(qc.maxSetSize, ids.length)
  return ids
}

/**
 * `table.column` is a member of `ids`, with the whole set bound as ONE parameter (D19): a JSON array read
 * through `json_each(?)` on D1 (which binds at most 100 parameters per statement) and an array with
 * `= ANY($n::uuid[])` on Postgres.
 */
export function memberOf<T extends PhysicalTable>(qc: QueryContext, table: T, column: ColumnOf<T>, ids: readonly string[]): Expression<SqlBool> {
  const ref = sql.ref(`${table}.${column}`)
  if (qc.dialect === 'd1') return sql<SqlBool>`${ref} in (select value from json_each(${JSON.stringify(ids)}))`
  const kind = (COLUMN_KINDS[table] as Record<string, string>)[column]
  return sql<SqlBool>`${ref} = any(${ids as string[]}::${sql.raw(kind === 'uuid' ? 'uuid' : 'text')}[])`
}
