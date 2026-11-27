// A custom object's table as a pure function of its declaration ([[CORE315]] D19). It mirrors a core table (migrations 0023's `forms`): STRICT, the UUID `id` and timestamp CHECKs, the organisation and creator keys, then
// the declared fields, then the unique `(organization_id, id)` index. [[CORE683]] D10: it follows the schema conventions of [[CORE679]] (named CHECKs, the parenthesised nullable forms, the unique pair index), held by the live conventions checker;
// the canonical expressions below are a local copy of the checker's (`@vibase/storage-d1/test`), and a test proves the copy matches. Every identifier is quoted and every statement is idempotent (`IF NOT EXISTS`), so a run that stopped part-way is repaired by running it again (D30).
// Nothing applies it in production in this cycle (T3, #542); tests run it against their own D1.
import { TEXT_MAX, type FieldDeclaration, type ObjectDeclaration } from './declaration.js'

export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`
export const literal = (v: string | number | boolean): string =>
  typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : typeof v === 'boolean' ? (v ? '1' : '0') : String(v)

// The canonical CHECK expressions (C1, C2, C4 of [[CORE679]]); a nullable column takes `c IS NULL OR (<expression>)`.
const UUID_EXPR = (c: string) =>
  `length(${c}) = 36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c}, 9, 1) = '-' AND substr(${c}, 14, 1) = '-' AND substr(${c}, 19, 1) = '-' AND substr(${c}, 24, 1) = '-'`
const TIMESTAMP_EXPR = (c: string) => `coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) = ${c}, 0)`
const nullableForm = (c: string, expr: string, nullable: boolean) => (nullable ? `${c} IS NULL OR (${expr})` : expr)
/** `CONSTRAINT "<table>_<column>_<kind>" CHECK (...)`: every CHECK is named (C3); `kind` is `uuid`, `timestamp`, `length` or empty for another one-column CHECK. */
const named = (table: string, column: string, kind: string, expr: string) =>
  `CONSTRAINT ${ident(`${table}_${column}${kind === '' ? '' : `_${kind}`}`)} CHECK (${expr})`

/** One declared column of `table`: its type, nullability, default and the named CHECK its kind holds (D18). Enum values are never a CHECK (D20). */
export function columnDefinition(table: string, name: string, f: FieldDeclaration): string {
  const c = ident(name)
  const nullable = f.required !== true
  const parts = [c]
  parts.push(f.kind === 'integer' || f.kind === 'boolean' ? 'INTEGER' : 'TEXT')
  if (f.kind === 'reference') parts.push(`REFERENCES ${ident(f.target!)} ("id")`)
  if (f.required === true) parts.push('NOT NULL')
  if (f.default !== undefined) parts.push(`DEFAULT ${literal(f.default)}`)
  if (f.kind === 'text')
    parts.push(named(table, name, 'length', nullableForm(c, `length(${c}) <= ${TEXT_MAX}`, nullable)))
  if (f.kind === 'boolean') parts.push(named(table, name, '', nullableForm(c, `${c} IN (0, 1)`, nullable)))
  if (f.kind === 'timestamp') parts.push(named(table, name, 'timestamp', nullableForm(c, TIMESTAMP_EXPR(c), nullable)))
  return parts.join(' ')
}

/**
 * [[CORE318]] D13, [[CORE549]]: the property bag's column, exactly migration 0026's definition: JSON text, `{}` when empty, never NULL, and the database checks only that it is an object (the limits are API validation, D3).
 * `createTableStatements` creates it and apply's `ADD COLUMN` adds it to a table made before it existed.
 */
export const bagColumnDefinition = (key: string): string =>
  `${ident('additional_props')} TEXT NOT NULL DEFAULT '{}' CONSTRAINT ${ident(`${key}_additional_props`)} CHECK (json_valid(${ident('additional_props')}) AND json_type(${ident('additional_props')}) = 'object')`

/** [[CORE555]] P3 (D8): an extension field's column on a built-in table. A required field with a constant default is `NOT NULL DEFAULT`; a required field with no default stays nullable (its rule is API validation, CORE559), so `ADD COLUMN` works on a populated table. */
export const extensionColumnDefinition = (table: string, name: string, f: FieldDeclaration): string =>
  columnDefinition(table, name, { ...f, required: f.required === true && f.default !== undefined })

/** The indexes a field needs ([[CORE541]] P1, D22): a reference gets `(organization_id, field, id)`, a unique field only the partial unique index over its live non-null rows. */
export function fieldIndexStatements(key: string, name: string, f: FieldDeclaration): string[] {
  const t = ident(key)
  const c = ident(name)
  if (f.kind === 'reference')
    return [`CREATE INDEX IF NOT EXISTS ${ident(`idx_${key}_${name}_id`)} ON ${t} ("organization_id", ${c}, "id")`]
  if (f.unique === true)
    return [
      `CREATE UNIQUE INDEX IF NOT EXISTS ${ident(`idx_${key}_${name}_unique`)} ON ${t} ("organization_id", ${c}) WHERE "deleted_at" IS NULL AND ${c} IS NOT NULL`,
    ]
  return []
}

/** The statements that create the table and its indexes, in order ([[CORE541]] P1): a reference gets `(organization_id, field, id)`, a unique field only the partial unique index over its live non-null rows. */
export function createTableStatements(key: string, declaration: ObjectDeclaration): string[] {
  const t = ident(key)
  const columns = [
    `${ident('id')} TEXT PRIMARY KEY NOT NULL ${named(key, 'id', 'uuid', UUID_EXPR(ident('id')))}`,
    `${ident('organization_id')} TEXT NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE`,
    `${ident('created_by')} TEXT NOT NULL REFERENCES "principals" ("id")`,
    `${ident('created_at')} TEXT NOT NULL ${named(key, 'created_at', 'timestamp', TIMESTAMP_EXPR(ident('created_at')))}`,
    `${ident('updated_at')} TEXT NOT NULL ${named(key, 'updated_at', 'timestamp', TIMESTAMP_EXPR(ident('updated_at')))}`,
    `${ident('deleted_at')} TEXT ${named(key, 'deleted_at', 'timestamp', nullableForm(ident('deleted_at'), TIMESTAMP_EXPR(ident('deleted_at')), true))}`,
    bagColumnDefinition(key),
    ...Object.entries(declaration.fields).map(([name, f]) => columnDefinition(key, name, f)),
  ]
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (\n  ${columns.join(',\n  ')}\n) STRICT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${ident(`idx_${key}_organization_id_id`)} ON ${t} ("organization_id", "id")`,
    ...Object.entries(declaration.fields).flatMap(([name, f]) => fieldIndexStatements(key, name, f)),
  ]
}
