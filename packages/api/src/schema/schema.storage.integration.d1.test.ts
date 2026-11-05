import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { TenantOperation } from '../registry.js'
import { ApiError } from '../errors.js'
import { openEngines, type Engine } from '../test/engines.js'
import { CATALOG, HIDDEN_TABLES } from './catalog.js'

// API63 on the migrated local D1 (the oracle): which tables appear, the D13 facts, catalog completeness (D16), no event written.
// The Postgres engine only has to answer 501 (D15): schema.storage.integration.postgres.test.ts.
const registry = createVaultRegistry()
let engines: Engine[]
let d1: Engine
beforeAll(async () => {
  engines = await openEngines(['d1'])
  d1 = engines.find((e) => e.name === 'd1')!
  await d1.reset()
})
afterAll(async () => {
  for (const e of engines ?? []) await e.close()
})

const op = () => registry.get('schema.get') as TenantOperation
const run = async (e: Engine) => e.run(await op().prepare(e.env(), { params: {}, query: {}, body: undefined }))
const getDoc = async (): Promise<any> => (await run(d1)).value
const table = (doc: any, name: string) => doc.tables.find((t: any) => t.name === name)
const column = (doc: any, t: string, c: string) => table(doc, t).columns.find((x: any) => x.name === c)
const all = async (sqlText: string, ...binds: unknown[]) => ((await d1.d1!.prepare(sqlText).bind(...binds).all()).results as Record<string, any>[])

// Written out, independent of the code under test.
const HIDDEN = ['deployment', 'unit_assertion', 'message_sources', 'thread_sources']
const PRESENT = ['events', 'principals', 'api_keys', 'notes', 'associations', 'organizations', 'users', 'memberships', 'agents']
const realTables = async () =>
  (await all("select name from sqlite_schema where type = 'table' order by name")).map((r) => r.name as string)
const shownReal = async () =>
  (await realTables()).filter((n) => !n.startsWith('_cf_') && !n.startsWith('sqlite_') && n !== 'd1_migrations' && !HIDDEN.includes(n))

describe('schema.get on the migrated D1 (D9)', () => {
  it('lists exactly the real tables minus the engine tables and the hidden machinery list, sorted', async () => {
    const doc = await getDoc()
    const names = doc.tables.map((t: any) => t.name)
    expect(names).toEqual(await shownReal())
    expect(names).toEqual([...names].sort())
    expect(doc.engine).toBe('d1')
  })
  it('never lists _cf_*, sqlite_*, d1_migrations or the hidden tables, and always lists events, principals, api_keys, notes, associations', async () => {
    const names = (await getDoc()).tables.map((t: any) => t.name) as string[]
    for (const h of HIDDEN) expect(names, h).not.toContain(h)
    expect(names.filter((n) => n.startsWith('_cf_') || n.startsWith('sqlite_') || n === 'd1_migrations')).toEqual([])
    for (const p of PRESENT) expect(names, p).toContain(p)
  })
  it('the hidden-list constant names tables that exist and equals the written-out list', async () => {
    expect([...HIDDEN_TABLES].sort()).toEqual([...HIDDEN].sort())
    const real = await realTables()
    for (const h of HIDDEN_TABLES) expect(real, h).toContain(h)
  })
  it('lists every column of every table in cid order with the declared type, nullability, default and primary key', async () => {
    const doc = await getDoc()
    for (const name of await shownReal()) {
      const rows = await all('select cid, name, type, "notnull", dflt_value, pk from pragma_table_info(?) order by cid', name)
      expect(table(doc, name).columns.map((c: any) => [c.name, c.type, !c.nullable, c.default, c.primary_key])).toEqual(
        rows.map((r) => [r.name, r.type, r.notnull === 1, r.dflt_value, r.pk > 0]),
      )
    }
  })
  it('writes no event', async () => {
    const before = (await d1.events()).length
    await getDoc()
    await getDoc()
    expect((await d1.events()).length).toBe(before)
  })
})

describe('foreign keys on the migrated D1 (D13)', () => {
  it('contacts.company_id references companies.id; organization_id does not reference companies; the composite is kept as declared', async () => {
    const doc = await getDoc()
    expect(column(doc, 'contacts', 'company_id').references).toEqual({ table: 'companies', column: 'id' })
    expect(column(doc, 'contacts', 'organization_id').references).toEqual({ table: 'organizations', column: 'id' })
    expect(table(doc, 'contacts').foreign_keys).toContainEqual({ columns: ['organization_id', 'company_id'], references: { table: 'companies', columns: ['organization_id', 'id'] }, on_delete: 'NO ACTION' })
    expect(table(doc, 'contacts').foreign_keys).toContainEqual({ columns: ['organization_id'], references: { table: 'organizations', columns: ['id'] }, on_delete: 'CASCADE' })
  })
  it('interactions.thread_id references threads.id, not messages.thread_id', async () => {
    const doc = await getDoc()
    expect(column(doc, 'interactions', 'thread_id').references).toEqual({ table: 'threads', column: 'id' })
    expect(column(doc, 'interactions', 'message_id').references).toEqual({ table: 'messages', column: 'id' })
    expect(table(doc, 'interactions').foreign_keys).toContainEqual({
      columns: ['organization_id', 'message_id', 'thread_id'],
      references: { table: 'messages', columns: ['organization_id', 'id', 'thread_id'] },
      on_delete: 'NO ACTION',
    })
  })
  it('reports every foreign key the database declares, in declaration order (the per-table count and first columns match the pragma)', async () => {
    const doc = await getDoc()
    for (const name of await shownReal()) {
      const rows = await all('select id, seq, "table", "from" from pragma_foreign_key_list(?) order by id desc, seq', name)
      const expected: string[][] = []
      for (const r of rows) {
        if (r.seq === 0) expected.push([r.table])
        expected[expected.length - 1]!.push(r.from)
      }
      expect(table(doc, name).foreign_keys.map((f: any) => [f.references.table, ...f.columns]), name).toEqual(expected)
    }
  })
})

describe('catalog completeness (D16)', () => {
  it('every shown table has a catalog label and description, and every column a description', async () => {
    const doc = await getDoc()
    for (const name of await shownReal()) {
      const entry = CATALOG.tables[name]
      expect(entry, `catalog entry for ${name}`).toBeDefined()
      expect(entry!.label.length, `${name} label`).toBeGreaterThan(0)
      expect(entry!.description.length, `${name} description`).toBeGreaterThan(0)
      for (const c of table(doc, name).columns) expect(typeof c.description, `${name}.${c.name} description`).toBe('string')
    }
  })
  it('every catalog entry names an existing table and existing columns', async () => {
    const real = await realTables()
    for (const [name, entry] of Object.entries(CATALOG.tables)) {
      expect(real, `table ${name}`).toContain(name)
      const cols = (await all('select name from pragma_table_info(?)', name)).map((r) => r.name as string)
      for (const c of Object.keys(entry.columns)) expect(cols, `${name}.${c}`).toContain(c)
    }
  })
  it('the fixed CORE62 texts are literal', async () => {
    const doc = await getDoc()
    expect(column(doc, 'contacts', 'company_id').label).toBe('Primary company')
    expect(column(doc, 'tasks', 'notes').description).toBe("The task's own description. Research and context belong in associated notes.")
    expect(table(doc, 'notes').description).toBeTruthy()
    expect(table(doc, 'associations').description).toBeTruthy()
  })
  it('values, exposed and secret columns on the real tables', async () => {
    const doc = await getDoc()
    expect(column(doc, 'tasks', 'status').values).toEqual(['open', 'done'])
    expect(column(doc, 'tasks', 'title').values).toBeNull()
    expect(column(doc, 'tasks', 'title').exposed).toBe(true)
    for (const [t, c] of [['api_keys', 'key_hash'], ['messages', 'content_key'], ['files', 'storage_key']] as const) expect(column(doc, t, c), `${t}.${c}`).toMatchObject({ exposed: false })
    expect(table(doc, 'tasks').resource.path).toBe('/api/v1/tasks')
    expect(table(doc, 'events').resource).toBeNull()
  })
})

describe('derived fields ([[CORE131]] D11)', () => {
  const FILTERS = {
    last_contacted_at: ['contacted_since', 'not_contacted_since', 'never_contacted'],
    last_interacted_at: ['interacted_since', 'not_interacted_since', 'never_interacted'],
  } as const
  it('every table lists derived, an empty array where it has none', async () => {
    const doc = await getDoc()
    for (const t of doc.tables) expect(Array.isArray(t.derived), `${t.name}.derived`).toBe(true)
    for (const t of doc.tables) if (t.name !== 'contacts' && t.name !== 'deals') expect(t.derived, t.name).toEqual([])
  })
  it('contacts lists the two fields in the spec shape, apart from the columns, with sortable false until CORE133', async () => {
    const doc = await getDoc()
    const derived = table(doc, 'contacts').derived
    expect(derived.map((d: any) => d.name)).toEqual(['last_contacted_at', 'last_interacted_at'])
    for (const d of derived) {
      expect(d).toEqual({
        name: d.name,
        kind: 'timestamp',
        nullable: true,
        writable: false,
        label: expect.any(String),
        description: expect.any(String),
        requires: 'interactions:read',
        filters: FILTERS[d.name as keyof typeof FILTERS],
        sortable: false,
      })
      expect(d.description.length, d.name).toBeGreaterThan(10)
      expect(table(doc, 'contacts').columns.map((c: any) => c.name), 'derived fields are not columns').not.toContain(d.name)
    }
    expect(derived[0].label).toBe('Last contacted at')
    expect(derived[0].description).toBe("When the latest outbound interaction with any of the contact's identities happened; null if none.")
  })
  it('the catalog describes every derived field of every registered resource (completeness)', async () => {
    for (const def of registry.resources()) {
      const names = Object.keys((def as { derived?: object }).derived ?? {})
      for (const n of names) {
        const entry = (CATALOG.tables[def.table]?.derived ?? {})[n]
        expect(entry, `catalog text for ${def.table}.${n}`).toBeDefined()
        expect(typeof entry === 'string' ? entry : entry!.description, `${def.table}.${n}`).toBeTruthy()
      }
    }
  })
})

describe('deals and pipelines ([[CORE130]] D18)', () => {
  it('shows the three tables with their meaning, the resources on the right surface, and the composite foreign key', async () => {
    const doc = await getDoc()
    for (const name of ['pipelines', 'pipeline_stages', 'deals']) {
      expect(table(doc, name), name).toBeDefined()
      expect(table(doc, name).description.length, name).toBeGreaterThan(10)
      expect(table(doc, name).origin).toBe('built_in')
    }
    expect(table(doc, 'pipelines').resource).toMatchObject({ surface: 'meta', path: '/meta/v1/pipelines', read_scope: 'pipelines:read', write_scope: 'pipelines:write' })
    expect(table(doc, 'pipeline_stages').resource).toMatchObject({ surface: 'meta', path: '/meta/v1/pipeline-stages', read_scope: 'pipelines:read', write_scope: 'pipelines:write' })
    expect(table(doc, 'deals').resource).toMatchObject({ surface: 'api', path: '/api/v1/deals', read_scope: 'deals:read', write_scope: 'deals:write' })
    expect(table(doc, 'deals').foreign_keys).toContainEqual({ columns: ['pipeline_id', 'stage_id'], references: { table: 'pipeline_stages', columns: ['pipeline_id', 'id'] }, on_delete: 'NO ACTION' })
    expect(column(doc, 'deals', 'pipeline_id').references).toEqual({ table: 'pipelines', column: 'id' })
    expect(column(doc, 'deals', 'owner_id').references).toEqual({ table: 'principals', column: 'id' })
    expect(column(doc, 'pipeline_stages', 'pipeline_id').references).toEqual({ table: 'pipelines', column: 'id' })
  })
  it('column texts: kind values, position, the minor-unit amount', async () => {
    const doc = await getDoc()
    expect(column(doc, 'pipeline_stages', 'kind').values).toEqual(['open', 'won', 'lost'])
    expect(column(doc, 'pipeline_stages', 'position').description).toMatch(/order/i)
    expect(column(doc, 'deals', 'amount_minor').description).toContain("currency's minor units")
    expect(column(doc, 'deals', 'amount_minor').kind).toBe('integer')
    expect(column(doc, 'deals', 'closed_at').description).toMatch(/won|lost/)
    expect(column(doc, 'deals', 'currency').description).toMatch(/ISO 4217/)
  })
  it('deals.status is a derived field: writable false, no required scope, filterable by status, apart from the columns', async () => {
    const doc = await getDoc()
    const derived = table(doc, 'deals').derived
    expect(derived).toEqual([
      { name: 'status', kind: 'text', nullable: true, writable: false, label: 'Status', description: expect.any(String), requires: null, filters: ['status'], sortable: false },
    ])
    expect(derived[0].description).toMatch(/open.*won.*lost/s)
    expect(table(doc, 'deals').columns.map((c: any) => c.name)).not.toContain('status')
    expect(table(doc, 'pipelines').derived).toEqual([])
    expect(table(doc, 'pipeline_stages').derived).toEqual([])
  })
  it('deals are not associable in this cycle (CORE136)', async () => {
    const doc = await getDoc()
    expect(doc.associations.associable).not.toContain('deals')
    expect(table(doc, 'deals').associable).toBe(false)
  })
})
