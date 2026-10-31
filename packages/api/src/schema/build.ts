import { COLUMN_KINDS } from '@vault/storage'
import type { AnyResource } from '../registry.js'
import { resourceOperations } from '../registry.js'
import { formatScope } from '../scopes.js'
import { fullPath } from '../surfaces.js'
import { crudActions, resourcePath, scopeResourceOf } from '../resources/define.js'
import { CATALOG, HIDDEN_TABLES, defaultLabel, type Catalog } from './catalog.js'
import type { SchemaDocument } from './document.js'

// API63 D10-D14: a pure builder. The rows are what `pragma_table_info` / `pragma_foreign_key_list` return for each table;
// the definitions and the catalog add the meaning. No database, no clock.

export interface ColumnRow {
  table_name: string
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}
export interface ForeignKeyRow {
  table_name: string
  id: number
  seq: number
  ref_table: string
  from: string
  to: string | null
  on_delete: string
}
export interface BuildInput {
  columns: readonly ColumnRow[]
  foreignKeys: readonly ForeignKeyRow[]
  resources: readonly AnyResource[]
  catalog?: Catalog
  kinds?: Record<string, Record<string, string>>
  hidden?: readonly string[]
}

/** D10: how each logical kind is stored on D1. */
export const KIND_NOTES: Readonly<Record<string, string>> = {
  uuid: 'canonical lowercase UUIDv7 as TEXT',
  text: 'plain text as TEXT',
  timestamp: 'ISO-8601 UTC with milliseconds as TEXT, e.g. 2026-10-31T09:00:00.000Z',
  boolean: 'INTEGER 0 or 1',
  json: 'JSON text',
  string_array: 'JSON array of strings as TEXT',
  integer: 'INTEGER',
}

const ASSOCIATIONS_DESCRIPTION = 'Any two records of associable tables can be linked once, undirected; list with GET /api/v1/associations?type=&id=.'

/** D14: at most one definition per table; two make the builder (and the operation factory) throw at load. */
export function resourcesByTable(defs: readonly AnyResource[]): Map<string, AnyResource> {
  const out = new Map<string, AnyResource>()
  for (const def of defs) {
    const other = out.get(def.table)
    if (other) throw new Error(`two resource definitions on table "${def.table}": ${other.name} and ${def.name}`)
    out.set(def.table, def)
  }
  return out
}

/** The allowed values of a record field when its zod schema (unwrapping nullable/optional/default) is an enum. */
function enumValues(schema: unknown): string[] | null {
  let s = schema as { def?: { type?: string; innerType?: unknown; entries?: Record<string, string> } } | undefined
  while (s?.def && (s.def.type === 'optional' || s.def.type === 'nullable' || s.def.type === 'default' || s.def.type === 'readonly')) s = s.def.innerType as typeof s
  return s?.def?.type === 'enum' && s.def.entries ? Object.values(s.def.entries) : null
}

function resourceOf(def: AnyResource) {
  const actions = new Set(crudActions(def))
  const scope = scopeResourceOf(def)
  return {
    name: def.name,
    surface: def.surface,
    path: fullPath({ surface: def.surface, path: resourcePath(def) }),
    operations: resourceOperations(def).map((o) => o.name),
    read_scope: formatScope({ resource: scope, action: 'read' }),
    write_scope: actions.has('create') || actions.has('update') || actions.has('delete') ? formatScope({ resource: scope, action: 'write' }) : null,
  }
}

const textOf = (entry: string | { label?: string; description: string } | undefined) =>
  entry === undefined ? { label: undefined, description: undefined } : typeof entry === 'string' ? { label: undefined, description: entry } : entry

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const list = out.get(key(r))
    if (list) list.push(r)
    else out.set(key(r), [r])
  }
  return out
}

export function buildSchemaDocument(input: BuildInput): SchemaDocument {
  const catalog = input.catalog ?? CATALOG
  const kinds = input.kinds ?? (COLUMN_KINDS as Record<string, Record<string, string>>)
  const hidden = new Set(input.hidden ?? HIDDEN_TABLES)
  const byTable = resourcesByTable(input.resources)
  const columnsOf = groupBy(input.columns, (r) => r.table_name)
  const fksOf = groupBy(input.foreignKeys, (r) => r.table_name)
  const primaryKeyOf = (table: string): string[] =>
    [...(columnsOf.get(table) ?? [])].filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)

  const tables = [...columnsOf.keys()]
    .filter((name) => !hidden.has(name))
    .sort()
    .map((name) => {
      const rows = [...columnsOf.get(name)!].sort((a, b) => a.cid - b.cid)
      const text = catalog.tables[name]
      const def = byTable.get(name)
      const exposedFields = def ? (def.record.shape as Record<string, unknown>) : {}

      // Foreign keys as declared: SQLite numbers them in reverse declaration order, so the highest id is the first declared.
      const fks = [...groupBy(fksOf.get(name) ?? [], (r) => String(r.id)).values()]
        .map((group) => [...group].sort((a, b) => a.seq - b.seq))
        .sort((a, b) => b[0]!.id - a[0]!.id)
        .map((group) => {
          const refTable = group[0]!.ref_table
          const implicit = primaryKeyOf(refTable)
          return {
            columns: group.map((g) => g.from),
            references: { table: refTable, columns: group.map((g, i) => g.to ?? implicit[i] ?? '') },
            on_delete: group[0]!.on_delete,
          }
        })

      // D13: a column references T.c when a declared foreign key pairs it with c and c is a primary-key column of T.
      const referenceOf = new Map<string, { table: string; column: string }>()
      for (const fk of fks) {
        const pk = new Set(primaryKeyOf(fk.references.table))
        fk.columns.forEach((from, i) => {
          const to = fk.references.columns[i]!
          if (pk.has(to) && !referenceOf.has(from)) referenceOf.set(from, { table: fk.references.table, column: to })
        })
      }

      return {
        name,
        origin: 'built_in' as const,
        label: text?.label ?? defaultLabel(name),
        description: text?.description ?? null,
        associable: def?.associable === true,
        resource: def ? resourceOf(def) : null,
        columns: rows.map((c) => {
          const own = textOf(text?.columns[c.name])
          return {
            name: c.name,
            type: c.type,
            kind: kinds[name]?.[c.name] ?? null,
            nullable: c.notnull === 0,
            primary_key: c.pk > 0,
            default: c.dflt_value,
            label: own.label ?? defaultLabel(c.name),
            // The common bookkeeping text applies only to a table the catalog describes: an unknown table says nothing.
            description: own.description ?? (text ? (catalog.common[c.name] ?? null) : null),
            values: def ? enumValues(exposedFields[c.name]) : null,
            exposed: def ? c.name in exposedFields : false,
            references: referenceOf.get(c.name) ?? null,
          }
        }),
        foreign_keys: fks,
      }
    })

  return {
    engine: 'd1',
    kinds: { ...KIND_NOTES },
    tables,
    associations: {
      table: 'associations',
      relations: ['related_to'],
      associable: input.resources.filter((d) => d.associable).map((d) => d.table).sort(),
      description: ASSOCIATIONS_DESCRIPTION,
    },
  }
}
