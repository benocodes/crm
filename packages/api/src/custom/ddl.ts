// A custom object's table as a pure function of its declaration ([[CORE315]] D19). It mirrors a core table (migrations 0023's `forms`): STRICT, the UUID `id` and timestamp CHECKs, the organisation and creator keys, then
// the declared fields, then the `(organization_id, id)` index. Every identifier is quoted and every statement is idempotent (`IF NOT EXISTS`), so a run that stopped part-way is repaired by running it again (D30).
// Nothing applies it in production in this cycle (T3, #542); tests run it against their own D1.
import { TEXT_MAX, type FieldDeclaration, type ObjectDeclaration } from './declaration.js'

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (v: string | number | boolean): string =>
  typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : typeof v === 'boolean' ? (v ? '1' : '0') : String(v)

const UUID_CHECK = (c: string) =>
  `CHECK (length(${c}) = 36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c}, 9, 1) = '-' AND substr(${c}, 14, 1) = '-' AND substr(${c}, 19, 1) = '-' AND substr(${c}, 24, 1) = '-')`
const TIMESTAMP_CHECK = (c: string) => `coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) = ${c}, 0)`

/** One declared column: its type, nullability, default and the CHECK its kind holds (D18). Enum values are never a CHECK (D20). */
export function columnDefinition(name: string, f: FieldDeclaration): string {
  const c = ident(name)
  const parts = [c]
  parts.push(f.kind === 'integer' || f.kind === 'boolean' ? 'INTEGER' : 'TEXT')
  if (f.kind === 'reference') parts.push(`REFERENCES ${ident(f.target!)} ("id")`)
  if (f.required === true) parts.push('NOT NULL')
  if (f.default !== undefined) parts.push(`DEFAULT ${literal(f.default)}`)
  if (f.kind === 'text') parts.push(`CHECK (${c} IS NULL OR length(${c}) <= ${TEXT_MAX})`)
  if (f.kind === 'boolean') parts.push(`CHECK (${c} IS NULL OR ${c} IN (0, 1))`)
  if (f.kind === 'timestamp') parts.push(`CHECK (${c} IS NULL OR ${TIMESTAMP_CHECK(c)})`)
  return parts.join(' ')
}

/** The statements that create the table and its indexes, in order ([[CORE541]] P1): a reference gets `(organization_id, field, id)`, a unique field only the partial unique index over its live non-null rows. */
export function createTableStatements(key: string, declaration: ObjectDeclaration): string[] {
  const t = ident(key)
  const columns = [
    `${ident('id')} TEXT PRIMARY KEY NOT NULL ${UUID_CHECK(ident('id'))}`,
    `${ident('organization_id')} TEXT NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE`,
    `${ident('created_by')} TEXT NOT NULL REFERENCES "principals" ("id")`,
    `${ident('created_at')} TEXT NOT NULL CHECK (${TIMESTAMP_CHECK(ident('created_at'))})`,
    `${ident('updated_at')} TEXT NOT NULL CHECK (${TIMESTAMP_CHECK(ident('updated_at'))})`,
    `${ident('deleted_at')} TEXT CHECK (${ident('deleted_at')} IS NULL OR ${TIMESTAMP_CHECK(ident('deleted_at'))})`,
    ...Object.entries(declaration.fields).map(([name, f]) => columnDefinition(name, f)),
  ]
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (\n  ${columns.join(',\n  ')}\n) STRICT`,
    `CREATE INDEX IF NOT EXISTS ${ident(`idx_${key}_organization_id_id`)} ON ${t} ("organization_id", "id")`,
    ...Object.entries(declaration.fields).flatMap(([name, f]) => {
      const c = ident(name)
      if (f.kind === 'reference')
        return [`CREATE INDEX IF NOT EXISTS ${ident(`idx_${key}_${name}_id`)} ON ${t} ("organization_id", ${c}, "id")`]
      if (f.unique === true)
        return [
          `CREATE UNIQUE INDEX IF NOT EXISTS ${ident(`idx_${key}_${name}_unique`)} ON ${t} ("organization_id", ${c}) WHERE "deleted_at" IS NULL AND ${c} IS NOT NULL`,
        ]
      return []
    }),
  ]
}
