import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from '@vault/storage-d1/test'
import { d1CheckNames, diffShapes, fkItem, indexItem, normalizePredicate, uniqueItem, type SchemaShape, type TableShape } from './test/schema-audit.js'

const empty = (): TableShape => ({ primaryKey: [], foreignKeys: [], uniqueKeys: [], indexes: [], namedChecks: [] })
const shape = (tables: Record<string, Partial<TableShape>>): SchemaShape => ({
  tables: Object.keys(tables).sort(),
  byTable: Object.fromEntries(Object.entries(tables).map(([t, s]) => [t, { ...empty(), ...s }])),
})

/** The CREATE TABLE text of `table` from a D1 migration file. */
function createTable(file: string, table: string): string {
  const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')
  const start = text.indexOf(`CREATE TABLE ${table} (`)
  expect(start).toBeGreaterThanOrEqual(0)
  return text.slice(start, text.indexOf(') STRICT;', start) + 9)
}

describe('schema audit normalisers', () => {
  it('predicate: Postgres and D1 forms agree', () => {
    expect(normalizePredicate('((deleted_at IS NULL) AND (domain IS NOT NULL))')).toBe('deleted_at is null and domain is not null')
    expect(normalizePredicate('deleted_at IS NULL AND domain IS NOT NULL')).toBe('deleted_at is null and domain is not null')
  })
  it('predicate: casts dropped', () => {
    expect(normalizePredicate("(kind = 'system'::text)")).toBe("kind = 'system'")
  })
  it('predicate: null', () => {
    expect(normalizePredicate(null)).toBe('')
  })
  it('fk item, composite', () => {
    expect(fkItem(['organization_id', 'company_id'], 'companies', ['organization_id', 'id'], 'NO ACTION')).toBe(
      '(organization_id, company_id) -> companies(organization_id, id) on delete no action',
    )
  })
  it('fk item, cascade', () => {
    expect(fkItem(['organization_id'], 'organizations', ['id'], 'CASCADE')).toBe('(organization_id) -> organizations(id) on delete cascade')
  })
  it('unique item with and without predicate', () => {
    expect(uniqueItem(['organization_id', 'domain'], 'deleted_at IS NULL AND domain IS NOT NULL')).toBe('(organization_id, domain) where deleted_at is null and domain is not null')
    expect(uniqueItem(['organization_id', 'domain'], null)).toBe('(organization_id, domain)')
  })
  it('index item', () => {
    expect(indexItem('idx_tasks_organization_id_id', ['organization_id', 'id'], null)).toBe('idx_tasks_organization_id_id (organization_id, id)')
  })
  it('D1 check names', () => {
    expect(d1CheckNames(createTable('0002_identity_model.sql', 'contacts'))).toEqual(['contacts_merged_is_deleted', 'contacts_not_merged_into_self'])
  })
  it('D1 check names: none', () => {
    expect(d1CheckNames(createTable('0001_typed_storage_core.sql', 'tasks'))).toEqual([])
  })
})

describe('diffShapes', () => {
  it('equal shapes', () => {
    const s = shape({ a: { primaryKey: ['id'], foreignKeys: ['x'] } })
    expect(diffShapes(s, structuredClone(s))).toEqual([])
  })
  it('one-sided items both ways, sorted, engine where present', () => {
    const pg = shape({ a: { foreignKeys: ['fk A'] } })
    const d1 = shape({ a: {}, t: {} })
    const diff = diffShapes(pg, d1)
    expect(diff).toEqual([
      { aspect: 'table', engine: 'd1', table: 't', item: 't', reason: '' },
      { aspect: 'foreignKey', engine: 'postgres', table: 'a', item: 'fk A', reason: '' },
    ])
    expect(diff).toHaveLength(2)
  })
  it('named checks are compared only on shared tables', () => {
    const pg = shape({ a: {} })
    const d1 = shape({ a: {}, t1: { namedChecks: ['c1'] } })
    expect(diffShapes(pg, d1)).toEqual([{ aspect: 'table', engine: 'd1', table: 't1', item: 't1', reason: '' }])
  })
})
