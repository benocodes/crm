import type { AliasedRawBuilder } from 'kysely'
import type { ColumnKind } from './database.js'
import type { QueryContext } from './types.js'

export function jsonRows(
  _qc: QueryContext,
  _alias: string,
  _columns: Readonly<Record<string, ColumnKind>>,
  _rows: readonly Record<string, unknown>[],
): AliasedRawBuilder {
  throw new Error('not implemented')
}
