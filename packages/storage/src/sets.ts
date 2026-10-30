import { sql, type AliasedRawBuilder, type RawBuilder } from 'kysely'
import type { ColumnKind } from './database.js'
import type { QueryContext } from './types.js'

const IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * A set of rows bound as ONE parameter ([[CORE36]] D5, [[CORE35]] D19): a FROM-able derived table `alias` with the
 * given typed columns plus `ord` (input order). D1 reads a JSON array through `json_each(?)` (it binds at most 100
 * parameters per statement); Postgres reads it through `jsonb_array_elements(cast($n as jsonb)) with ordinality`.
 * A `json` column carries an object or null (null stays SQL NULL); a `boolean` column a JSON boolean.
 */
export function jsonRows(
  qc: QueryContext,
  alias: string,
  columns: Readonly<Record<string, ColumnKind>>,
  rows: readonly Record<string, unknown>[],
): AliasedRawBuilder<unknown, string> {
  // Labelled escape hatches (dialect-specific SQL; see RESULT.md inventory).
  const names = Object.keys(columns)
  for (const n of [alias, ...names]) if (!IDENT.test(n)) throw new Error(`invalid identifier "${n}"`)
  const payload = JSON.stringify(rows)
  if (qc.dialect === 'd1') {
    const cols = names.map((c) => sql`json_extract(value, ${sql.lit(`$.${c}`)}) as ${sql.id(c)}`)
    return sql`(select ${sql.join(cols)}, key as ${sql.id('ord')} from json_each(${payload}))`.as(alias)
  }
  const cast = (c: string, kind: ColumnKind): RawBuilder<unknown> => {
    const key = sql.lit(c)
    switch (kind) {
      case 'uuid':
        return sql`(e->>${key})::uuid`
      case 'boolean':
        return sql`(e->>${key})::boolean`
      case 'timestamp':
        return sql`(e->>${key})::timestamptz`
      case 'integer':
        return sql`(e->>${key})::bigint`
      case 'json':
        return sql`nullif(e->${key}, 'null'::jsonb)`
      default:
        return sql`e->>${key}`
    }
  }
  const cols = names.map((c) => sql`${cast(c, columns[c]!)} as ${sql.id(c)}`)
  return sql`(select ${sql.join(cols)}, ${sql.id('ord')} from jsonb_array_elements(cast(${payload} as jsonb)) with ordinality as t(e, ord))`.as(alias)
}
