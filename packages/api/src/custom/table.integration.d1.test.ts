import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createTableStatements } from './ddl.js'
import { PROJECTS, PROJECTS_KEY, createCustomTables } from '../test/custom-objects.js'

// [[CORE315]] D19: a custom object's table is a pure function of its declaration, mirrors a core table, and holds whatever writes it. The raw inserts are the permitted exception: the schema test proves what the database refuses.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-24T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['T'])
  d1 = local.bindings.T!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
  await createCustomTables(d1)
})
afterAll(async () => {
  await local.dispose()
})

const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const run = (sqlText: string, ...binds: unknown[]) =>
  d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
    () => null,
    (e: Error) => e.message,
  )
const row = (over: Record<string, unknown> = {}) => ({
  id: id(1),
  organization_id: ORG,
  created_by: USER,
  created_at: AT,
  updated_at: AT,
  name: 'A project',
  ...over,
})
const insert = (over: Record<string, unknown> = {}) => {
  const r = row(over)
  const cols = Object.keys(r)
  return run(
    `INSERT INTO "${PROJECTS_KEY}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(r),
  )
}

describe('the generated table', () => {
  it('is STRICT, with the bookkeeping columns first and each declared column typed by its kind', async () => {
    const list = await all<{ strict: number }>(`SELECT strict FROM pragma_table_list WHERE name = ?`, PROJECTS_KEY)
    expect(list).toEqual([{ strict: 1 }])
    const cols = await all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>(
      `SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info(?)`,
      PROJECTS_KEY,
    )
    expect(cols.map((c) => [c.name, c.type, c.notnull])).toEqual([
      ['id', 'TEXT', 1],
      ['organization_id', 'TEXT', 1],
      ['created_by', 'TEXT', 1],
      ['created_at', 'TEXT', 1],
      ['updated_at', 'TEXT', 1],
      ['deleted_at', 'TEXT', 0],
      ['additional_props', 'TEXT', 1], // the property bag ([[CORE318]] D13)
      ['name', 'TEXT', 1], // required
      ['budget', 'INTEGER', 0],
      ['active', 'INTEGER', 0], // boolean
      ['start_date', 'TEXT', 0], // timestamp
      ['stage', 'TEXT', 0], // enum
    ])
    expect(cols.find((c) => c.name === 'id')!.pk).toBe(1)
    expect(cols.find((c) => c.name === 'active')!.dflt_value).toBe('1')
    expect(cols.find((c) => c.name === 'stage')!.dflt_value).toBe("'planned'")
  })

  it('has the foreign keys of a core table and the (organization_id, id) index', async () => {
    const fks = await all<{ table: string; from: string; to: string; on_delete: string }>(
      `SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY "from"`,
      PROJECTS_KEY,
    )
    expect(fks).toEqual([
      { table: 'principals', from: 'created_by', to: 'id', on_delete: 'NO ACTION' },
      { table: 'organizations', from: 'organization_id', to: 'id', on_delete: 'CASCADE' },
    ])
    const indexes = await all<{ name: string }>(
      `SELECT name FROM pragma_index_list(?) WHERE origin = 'c'`,
      PROJECTS_KEY,
    )
    expect(indexes).toHaveLength(1)
    const cols = await all<{ name: string }>(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, indexes[0]!.name)
    expect(cols.map((c) => c.name)).toEqual(['organization_id', 'id'])
  })

  it('applies twice: every statement is idempotent', async () => {
    await createCustomTables(d1)
    expect(await all(`SELECT name FROM sqlite_master WHERE name = ?`, PROJECTS_KEY)).toHaveLength(1)
  })

  it('quotes every identifier, so a declared name cannot reach SQL as syntax', () => {
    const statements = createTableStatements('quotes__c', { fields: { name: { kind: 'text' } } })
    const sql = statements.join('\n')
    expect(sql).toContain('"quotes__c"')
    expect(sql).toContain('"name"')
    expect(sql).not.toMatch(/\bTABLE quotes__c\b/)
  })
})

describe('what the table refuses whatever writes it', () => {
  it('a row that is valid is stored, with the defaults', async () => {
    expect(await insert()).toBeNull()
    expect(await all(`SELECT active, stage, budget, deleted_at FROM "${PROJECTS_KEY}"`)).toEqual([
      { active: 1, stage: 'planned', budget: null, deleted_at: null },
    ])
  })
  it('refuses an id that is not a lowercase UUID', async () => {
    expect(await insert({ id: 'NOT-A-UUID' })).toMatch(/CHECK constraint failed/)
    expect(await insert({ id: id(2).toUpperCase() })).toMatch(/CHECK constraint failed/)
  })
  it.each(['created_at', 'updated_at', 'deleted_at'])('refuses a malformed %s', async (column) => {
    expect(await insert({ id: id(3), [column]: '2026-11-24' })).toMatch(/CHECK constraint failed/)
    expect(await insert({ id: id(3), [column]: '2026-11-24T09:00:00Z' })).toMatch(/CHECK constraint failed/)
  })
  it('refuses a malformed declared timestamp, a boolean that is not 0 or 1, and a text over the cap', async () => {
    expect(await insert({ id: id(4), start_date: 'tomorrow' })).toMatch(/CHECK constraint failed/)
    expect(await insert({ id: id(4), active: 2 })).toMatch(/CHECK constraint failed/)
    expect(await insert({ id: id(4), name: 'x'.repeat(10_001) })).toMatch(/CHECK constraint failed/)
    expect(await insert({ id: id(4), name: 'x'.repeat(10_000) })).toBeNull()
  })
  it('refuses a required column that is null, and a foreign key that points nowhere', async () => {
    expect(await insert({ id: id(5), name: null })).toMatch(/NOT NULL constraint failed/)
    expect(await insert({ id: id(5), organization_id: id(90) })).toMatch(/FOREIGN KEY constraint failed/)
    expect(await insert({ id: id(5), created_by: id(91) })).toMatch(/FOREIGN KEY constraint failed/)
  })
  it('refuses a value of the wrong storage type (STRICT)', async () => {
    expect(await insert({ id: id(6), budget: 'lots' })).toMatch(/cannot store TEXT value in INTEGER column/)
  })
  it('deleting the organisation cascades to its rows', async () => {
    expect((await all(`SELECT id FROM "${PROJECTS_KEY}"`)).length).toBeGreaterThan(0)
    await d1.batch([d1.prepare('DELETE FROM organizations WHERE id = ?').bind(ORG)])
    expect(await all(`SELECT id FROM "${PROJECTS_KEY}"`)).toEqual([])
  })
})

describe('no core column or table ends in __c (D9)', () => {
  it('holds for the physical schema the migrations create', async () => {
    const tables = await all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name <> ?`,
      PROJECTS_KEY,
    )
    expect(tables.filter((t) => t.name.endsWith('__c'))).toEqual([])
    const columns: string[] = []
    for (const { name } of await all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> ?`,
      PROJECTS_KEY,
    ))
      for (const c of await all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, name))
        if (c.name.endsWith('__c')) columns.push(`${name}.${c.name}`)
    expect(columns).toEqual([])
  })
  it('holds for the column inventory the storage layer declares', async () => {
    const { COLUMN_KINDS } = await import('@vibase/storage')
    const offenders = Object.entries(COLUMN_KINDS).flatMap(([table, kinds]) =>
      [table, ...Object.keys(kinds)].filter((n) => n.endsWith('__c')).map((n) => `${table}.${n}`),
    )
    expect(offenders).toEqual([])
    expect(PROJECTS.fields).toBeDefined()
  })
})
