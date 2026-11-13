import { defineOperation, readAll, unit, type PreparedOperation } from '@vault/storage'
import { sql } from 'kysely'
import { ApiError } from '../errors.js'
import type { AnyResource, TenantOperation } from '../registry.js'
import { buildSchemaDocument, resourcesByTable, type ColumnRow, type ForeignKeyRow } from './build.js'
import { schemaDocument, type SchemaDocument } from './document.js'

// CORE194 D4: FTS5 search indexes are machinery, not resources: the virtual tables and their shadow tables (`_data`, `_idx`, `_content`,
// `_docsize`, `_config`) are excluded by what SQLite says they are (`pragma_table_list`), so a later `*_search` table needs no list entry.
// D9: `_cf_*` and `sqlite_*` are excluded by prefix tests, never LIKE (`_` is a LIKE wildcard); pragma on them answers SQLITE_AUTH.
// [[CORE243]] D5: `auth_*` is the built-in auth provider's machinery (the `AUTH_TABLE_PREFIX` of catalog.ts), never listed: excluded here so no pragma reads it, and again in the builder.
const ELIGIBLE = sql`m.type = 'table' and substr(m.name, 1, 4) <> '_cf_' and substr(m.name, 1, 7) <> 'sqlite_' and substr(m.name, 1, 5) <> 'auth_' and m.name <> 'd1_migrations'
  and m.name not in (select tl.name from pragma_table_list as tl where tl.type in ('virtual', 'shadow'))`

/** D15: two raw reads over sqlite_schema with the pragma table-valued functions; the document is built from the rows. */
export function schemaGetOperation(resources: readonly AnyResource[]): PreparedOperation<SchemaDocument> {
  return defineOperation<SchemaDocument>({
    name: 'schema.get',
    mutates: false,
    reads: (qc) => {
      if (qc.dialect !== 'd1') throw new ApiError(501, 'not_implemented', 'schema.get is implemented for D1 only')
      return {
        columns: readAll(
          sql`select m.name as table_name, c.cid as cid, c.name as name, c.type as type, c."notnull" as "notnull", c.dflt_value as dflt_value, c.pk as pk
            from sqlite_schema as m join pragma_table_info(m.name) as c where ${ELIGIBLE} order by m.name, c.cid`.compile(qc.db),
        ),
        foreign_keys: readAll(
          sql`select m.name as table_name, f.id as id, f.seq as seq, f."table" as ref_table, f."from" as "from", f."to" as "to", f.on_delete as on_delete
            from sqlite_schema as m join pragma_foreign_key_list(m.name) as f where ${ELIGIBLE} order by m.name, f.id desc, f.seq`.compile(qc.db),
        ),
      }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () =>
          buildSchemaDocument({
            columns: found.all('columns') as unknown as ColumnRow[],
            foreignKeys: found.all('foreign_keys') as unknown as ForeignKeyRow[],
            resources,
          }),
      }),
  })
}

/** `schema.get` ([[API63]] D8): the same document for every caller, scope `schema:read`, on the meta surface. */
export function schemaOperations(resources: () => readonly AnyResource[]): TenantOperation[] {
  resourcesByTable(resources()) // D14: two definitions on one table fail at load, not on the first request
  return [
    {
      kind: 'tenant',
      surface: 'meta',
      name: 'schema.get',
      summary: "Describe the workspace database's built-in tables, columns, keys and the API resource behind each",
      tags: ['schema'],
      method: 'get',
      path: '/schema',
      scope: { resource: 'schema', action: 'read' },
      response: { status: 200, schema: schemaDocument },
      prepare: () => schemaGetOperation(resources()),
    },
  ]
}
