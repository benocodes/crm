import { storageTypeOf, type BuiltInDeclaration } from './builtin.js'

// [[CORE315]] D2, [[CORE554]] P6 (row 554.6): a built-in declaration and the D1 migrations describe the same table. The check reads the live table
// (the shapes below are what `pragma table_info`, `foreign_key_list` and `index_list`/`index_info` return) and names each difference. It compares
// column names, storage type, not-null, reference targets and unique fields, in both directions; defaults and CHECKs are not compared in U1.

export interface LiveColumn {
  name: string
  /** `pragma table_info(...).type`. */
  type: string
  notnull: boolean
  pk: boolean
}
export interface LiveTable {
  columns: LiveColumn[]
  /**
   * The references: a column whose foreign key pairs it with the primary key `id` of a table (a tenancy-composite key, `(organization_id, x) -> t(organization_id, id)`,
   * counts for `x`; the `organization_id` half of it is no reference of its own).
   */
  foreignKeys: Array<{ column: string; table: string }>
  /** Columns a unique index (partial ones included) holds alone besides `organization_id`; the primary key and the `(organization_id, id)` index are not one. */
  uniqueColumns: string[]
}

export type Drift = { rule: string; column: string; message: string }

/** Every difference between a declaration and the live table; empty when they agree. */
export function driftProblems(d: BuiltInDeclaration, live: LiveTable): Drift[] {
  const out: Drift[] = []
  const add = (rule: string, column: string, message: string) =>
    out.push({ rule, column, message: `${d.table}.${column}: ${message}` })
  const declared = Object.entries(d.fields).filter(([, f]) => f.derived !== true)
  const liveBy = new Map(live.columns.map((c) => [c.name, c]))
  for (const [name, f] of declared) {
    const c = liveBy.get(name)
    if (!c) {
      add('declared_no_column', name, 'declared but the table has no such column')
      continue
    }
    if (c.type !== storageTypeOf(f)) add('type_mismatch', name, `declared ${storageTypeOf(f)}, the column is ${c.type}`)
    const notNull = f.nullable !== true
    if ((c.notnull || c.pk) !== notNull)
      add(
        'nullability_mismatch',
        name,
        `declared ${notNull ? 'NOT NULL' : 'nullable'}, the column is ${c.notnull || c.pk ? 'NOT NULL' : 'nullable'}`,
      )
    const fk = live.foreignKeys.find((k) => k.column === name)
    if (f.kind === 'reference') {
      if (!fk) add('reference_no_fk', name, `declared a reference to ${f.target}, the column has no foreign key`)
      else if (fk.table !== f.target)
        add('reference_mismatch', name, `declared a reference to ${f.target}, the foreign key points at ${fk.table}`)
    } else if (fk)
      add('fk_undeclared', name, `the column has a foreign key to ${fk.table}, the declaration is no reference`)
    const unique = live.uniqueColumns.includes(name)
    if ((f.unique === true) !== unique)
      add(
        unique ? 'unique_undeclared' : 'unique_no_index',
        name,
        unique
          ? 'the table has a unique index the declaration does not state'
          : 'declared unique but no unique index covers it',
      )
  }
  const names = new Set(declared.map(([n]) => n))
  for (const c of live.columns)
    if (!names.has(c.name)) add('column_undeclared', c.name, 'the table has this column and the declaration does not')
  return out
}
