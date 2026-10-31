import { beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { Catalog } from './catalog.js'
import { buildSchemaDocument, resourcesByTable, type ColumnRow, type ForeignKeyRow } from './build.js'
import { schemaOperations } from './operations.js'

// API63 D10-D14: the pure builder, fed fixed pragma rows (no database). The expected values are written out, never derived from the input.
const defs = createVaultRegistry().resources()

const col = (table: string, cid: number, name: string, type = 'TEXT', o: { notnull?: boolean; dflt?: string; pk?: boolean } = {}): ColumnRow => ({
  table_name: table,
  cid,
  name,
  type,
  notnull: o.notnull ? 1 : 0,
  dflt_value: o.dflt ?? null,
  pk: o.pk ? 1 : 0,
})
const fk = (table: string, id: number, seq: number, ref: string, from: string, to: string | null, on_delete = 'NO ACTION'): ForeignKeyRow => ({
  table_name: table,
  id,
  seq,
  ref_table: ref,
  from,
  to,
  on_delete,
})

const COLUMNS: ColumnRow[] = [
  col('organizations', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('principals', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('companies', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('companies', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('companies', 2, 'name', 'TEXT', { notnull: true }),
  col('contacts', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('contacts', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('contacts', 2, 'company_id', 'TEXT'),
  col('threads', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('threads', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('messages', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('messages', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('messages', 2, 'thread_id', 'TEXT', { notnull: true }),
  col('interactions', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('interactions', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('interactions', 2, 'thread_id', 'TEXT'),
  col('interactions', 3, 'message_id', 'TEXT'),
  col('tasks', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('tasks', 1, 'organization_id', 'TEXT', { notnull: true }),
  col('tasks', 2, 'status', 'TEXT', { notnull: true, dflt: "'open'" }),
  col('tasks', 3, 'due_at', 'TEXT'),
  col('api_keys', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('api_keys', 1, 'key_hash', 'TEXT', { notnull: true }),
  col('api_keys', 2, 'prefix', 'TEXT', { notnull: true }),
  col('events', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('mystery', 0, 'id', 'TEXT', { notnull: true, pk: true }),
  col('mystery', 1, 'flavour', 'TEXT'),
  col('deployment', 0, 'singleton', 'INTEGER', { notnull: true, pk: true }),
  col('thread_sources', 0, 'id', 'TEXT', { notnull: true, pk: true }),
]
// SQLite numbers a table's foreign keys in reverse declaration order; the builder reports them as declared.
const FKS: ForeignKeyRow[] = [
  fk('contacts', 0, 0, 'companies', 'organization_id', 'organization_id'),
  fk('contacts', 0, 1, 'companies', 'company_id', 'id'),
  fk('contacts', 1, 0, 'organizations', 'organization_id', 'id', 'CASCADE'),
  fk('interactions', 0, 0, 'messages', 'organization_id', 'organization_id'),
  fk('interactions', 0, 1, 'messages', 'message_id', 'id'),
  fk('interactions', 0, 2, 'messages', 'thread_id', 'thread_id'),
  fk('interactions', 1, 0, 'threads', 'organization_id', 'organization_id'),
  fk('interactions', 1, 1, 'threads', 'thread_id', 'id'),
  fk('interactions', 2, 0, 'organizations', 'organization_id', 'id', 'CASCADE'),
  fk('companies', 0, 0, 'organizations', 'organization_id', 'id', 'CASCADE'),
]
const CATALOG: Catalog = {
  tables: {
    contacts: {
      label: 'Contacts',
      description: 'A person.',
      columns: { company_id: { label: 'Primary company', description: 'The primary company.' }, name: 'The name.' },
    },
    companies: { label: 'Companies', description: 'An organisation.', columns: {} },
  },
  common: { id: 'The id.', organization_id: 'The organisation.' },
}
const KINDS = { contacts: { id: 'uuid', company_id: 'uuid', organization_id: 'uuid' }, tasks: { id: 'uuid', status: 'text', due_at: 'timestamp' }, api_keys: { id: 'uuid', key_hash: 'text', prefix: 'text' } }
const build = (over: Record<string, unknown> = {}) =>
  buildSchemaDocument({ columns: COLUMNS, foreignKeys: FKS, resources: defs, catalog: CATALOG, kinds: KINDS, hidden: ['deployment', 'thread_sources'], ...over })
const table = (doc: any, name: string) => doc.tables.find((t: any) => t.name === name)
const column = (doc: any, t: string, c: string) => table(doc, t).columns.find((x: any) => x.name === c)

describe('document shape (D10, D11)', () => {
  it('has exactly the documented top-level, table, column and foreign-key fields', () => {
    const doc = build()
    expect(Object.keys(doc)).toEqual(['engine', 'kinds', 'tables', 'associations'])
    expect(doc.engine).toBe('d1')
    expect(Object.keys(table(doc, 'contacts'))).toEqual(['name', 'origin', 'label', 'description', 'associable', 'resource', 'columns', 'foreign_keys'])
    expect(Object.keys(column(doc, 'contacts', 'company_id'))).toEqual(['name', 'type', 'kind', 'nullable', 'primary_key', 'default', 'label', 'description', 'values', 'exposed', 'references'])
    expect(Object.keys(table(doc, 'contacts').foreign_keys[0])).toEqual(['columns', 'references', 'on_delete'])
    expect(Object.keys(doc.associations)).toEqual(['table', 'relations', 'associable', 'description'])
    expect(Object.keys(doc.kinds).sort()).toEqual(['boolean', 'integer', 'json', 'string_array', 'text', 'timestamp', 'uuid'])
  })
  it('sorts tables by name, keeps columns in cid order whatever the row order, and sorts associable', () => {
    const doc = build({ columns: [...COLUMNS].reverse() })
    expect(doc.tables.map((t: any) => t.name)).toEqual(['api_keys', 'companies', 'contacts', 'events', 'interactions', 'messages', 'mystery', 'organizations', 'principals', 'tasks', 'threads'])
    expect(table(doc, 'interactions').columns.map((c: any) => c.name)).toEqual(['id', 'organization_id', 'thread_id', 'message_id'])
    expect(doc.associations.associable).toEqual(['companies', 'contacts', 'interactions', 'notes', 'tasks', 'threads'])
    expect(doc.associations.table).toBe('associations')
    expect(doc.associations.relations).toEqual(['related_to'])
  })
  it('reports type, nullability, default, primary key and the declared origin of a column', () => {
    const doc = build()
    expect(column(doc, 'tasks', 'status')).toMatchObject({ type: 'TEXT', nullable: false, default: "'open'", primary_key: false, kind: 'text' })
    expect(column(doc, 'tasks', 'due_at')).toMatchObject({ nullable: true, default: null, kind: 'timestamp', label: 'Due at' })
    expect(column(doc, 'tasks', 'id')).toMatchObject({ primary_key: true, nullable: false })
    expect(table(doc, 'tasks').origin).toBe('built_in')
  })
  it('hides the machinery list and nothing else', () => {
    const doc = build()
    const names = doc.tables.map((t: any) => t.name)
    expect(names).not.toContain('deployment')
    expect(names).not.toContain('thread_sources')
    expect(names).toContain('events')
    expect(names).toContain('principals')
  })
  it('a table the catalog and the code do not know still appears: description null, kind null, resource null', () => {
    const t = table(build(), 'mystery')
    expect(t).toMatchObject({ name: 'mystery', description: null, resource: null, associable: false, foreign_keys: [] })
    expect(t.columns.map((c: any) => [c.name, c.kind, c.description, c.values, c.exposed, c.references])).toEqual([
      ['id', null, null, null, false, null],
      ['flavour', null, null, null, false, null],
    ])
  })
  it('takes labels and descriptions from the catalog, the common text when a table has none, and the default label rule', () => {
    const doc = build()
    expect(table(doc, 'contacts')).toMatchObject({ label: 'Contacts', description: 'A person.' })
    expect(column(doc, 'contacts', 'company_id')).toMatchObject({ label: 'Primary company', description: 'The primary company.' })
    expect(column(doc, 'contacts', 'name')).toBeUndefined() // not a fixture column: catalog entries never add columns
    expect(column(doc, 'contacts', 'id')).toMatchObject({ label: 'Id', description: 'The id.' })
    expect(column(doc, 'tasks', 'organization_id')).toMatchObject({ label: 'Organization id', description: 'The organisation.' })
  })
})

describe('per-column references (D13)', () => {
  let doc: any
  beforeAll(() => {
    doc = build()
  })
  it('a composite key gives company_id companies.id, and organization_id keeps only its own foreign key', () => {
    expect(column(doc, 'contacts', 'company_id').references).toEqual({ table: 'companies', column: 'id' })
    expect(column(doc, 'contacts', 'organization_id').references).toEqual({ table: 'organizations', column: 'id' })
    expect(column(doc, 'companies', 'organization_id').references).toEqual({ table: 'organizations', column: 'id' })
  })
  it('interactions.thread_id references threads.id, not messages.thread_id; message_id references messages.id', () => {
    expect(column(doc, 'interactions', 'thread_id').references).toEqual({ table: 'threads', column: 'id' })
    expect(column(doc, 'interactions', 'message_id').references).toEqual({ table: 'messages', column: 'id' })
  })
  it('table-level foreign_keys keep the composites as declared, in declaration order', () => {
    expect(table(doc, 'contacts').foreign_keys).toEqual([
      { columns: ['organization_id'], references: { table: 'organizations', columns: ['id'] }, on_delete: 'CASCADE' },
      { columns: ['organization_id', 'company_id'], references: { table: 'companies', columns: ['organization_id', 'id'] }, on_delete: 'NO ACTION' },
    ])
    expect(table(doc, 'interactions').foreign_keys[2]).toEqual({
      columns: ['organization_id', 'message_id', 'thread_id'],
      references: { table: 'messages', columns: ['organization_id', 'id', 'thread_id'] },
      on_delete: 'NO ACTION',
    })
  })
  it('a column with no foreign key has no reference', () => {
    expect(column(doc, 'tasks', 'status').references).toBeNull()
  })
})

describe('resource bridge (D14)', () => {
  let doc: any
  beforeAll(() => {
    doc = build()
  })
  it('carries the full path, the generated operation names and both scopes', () => {
    expect(table(doc, 'tasks').resource).toEqual({
      name: 'tasks',
      surface: 'api',
      path: '/api/v1/tasks',
      operations: ['tasks.list', 'tasks.get', 'tasks.create', 'tasks.update', 'tasks.delete'],
      read_scope: 'tasks:read',
      write_scope: 'tasks:write',
    })
  })
  it('a meta-surface definition with no write action has write_scope null and the meta path', () => {
    expect(table(doc, 'api_keys').resource).toEqual({
      name: 'api_keys',
      surface: 'meta',
      path: '/meta/v1/api-keys',
      operations: ['api_keys.list', 'api_keys.get'],
      read_scope: 'agents:read',
      write_scope: null,
    })
  })
  it('tables served by no definition (events, principals) have resource null', () => {
    expect(table(doc, 'events').resource).toBeNull()
    expect(table(doc, 'principals').resource).toBeNull()
  })
  it('two definitions on one table throw (at load, through the operation factory too)', () => {
    const tasks = defs.find((d) => d.name === 'tasks')!
    const twin = { ...tasks, name: 'tasks_twin' } as typeof tasks
    expect(() => resourcesByTable([tasks, twin])).toThrow(/tasks/)
    expect(() => schemaOperations(() => [tasks, twin])).toThrow(/tasks/)
    expect(() => build({ resources: [tasks, twin] })).toThrow(/tasks/)
  })
})

describe('values and exposed (D11)', () => {
  let doc: any
  beforeAll(() => {
    doc = build()
  })
  it('values come from the record zod enum, null elsewhere', () => {
    expect(column(doc, 'tasks', 'status').values).toEqual(['open', 'done'])
    expect(column(doc, 'tasks', 'due_at').values).toBeNull()
    expect(column(doc, 'tasks', 'id').values).toBeNull()
  })
  it('exposed is true only for record fields; secret columns are listed with exposed false', () => {
    expect(column(doc, 'tasks', 'status').exposed).toBe(true)
    expect(column(doc, 'api_keys', 'prefix').exposed).toBe(true)
    expect(column(doc, 'api_keys', 'key_hash')).toMatchObject({ exposed: false, kind: 'text' })
    expect(column(doc, 'events', 'id').exposed).toBe(false)
  })
})
