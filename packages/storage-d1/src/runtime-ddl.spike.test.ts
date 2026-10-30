import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// SPIKE (2026-10-30, discussions/2026-10-30-d1-only-mvp): can the vault create custom-object tables and columns
// at runtime on D1, atomically with its bookkeeping rows? Measured on the pinned local binding (Miniflare /
// workerd). REMOTE VERIFICATION: NOT RUN (local binding only).
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['DDL'], { migrate: false })
  d1 = local.bindings.DDL!
  await d1.batch([
    d1.prepare(`create table contacts (id text primary key, name text not null) strict`),
    d1.prepare(`create table schema_migrations (id integer primary key, kind text not null check (kind in ('core','workspace')), name text not null unique, checksum text not null) strict`),
  ])
})
afterAll(() => local.dispose())

const works = (fn: () => Promise<unknown>) => fn().then(() => true, () => false)
const tables = async () => ((await d1.prepare(`select name from sqlite_schema where type = 'table' order by name`).all()).results as { name: string }[]).map((r) => r.name)
const cols = async (t: string) => ((await d1.prepare(`select name, type, "notnull" as nn, dflt_value as d from pragma_table_info(?)`).bind(t).all()).results as { name: string; type: string; nn: number; d: unknown }[])

describe('runtime DDL on D1 (local binding)', () => {
  it('Q1: create table + bookkeeping row commit together in one batch', async () => {
    await d1.batch([
      d1.prepare(`create table obj_projects (id text primary key, title text not null, owner_contact_id text references contacts(id)) strict`),
      d1.prepare(`insert into schema_migrations (kind, name, checksum) values ('workspace', 'create_obj_projects', 'abc')`),
    ])
    expect(await tables()).toContain('obj_projects')
    expect((await d1.prepare(`select count(*) n from schema_migrations where name = 'create_obj_projects'`).first())!.n).toBe(1)
  })

  it('Q2: a failing later statement rolls back an earlier CREATE TABLE (DDL is transactional in a batch)', async () => {
    const ok = await works(() => d1.batch([
      d1.prepare(`create table obj_ghosts (id text primary key) strict`),
      d1.prepare(`insert into schema_migrations (kind, name, checksum) values ('workspace', 'create_obj_projects', 'dup')`), // unique violation
    ]))
    expect(ok).toBe(false)
    expect(await tables()).not.toContain('obj_ghosts')
  })

  it('Q3: a failing later statement rolls back an earlier ALTER TABLE ADD COLUMN', async () => {
    const ok = await works(() => d1.batch([
      d1.prepare(`alter table obj_projects add column budget integer`),
      d1.prepare(`insert into schema_migrations (kind, name, checksum) values ('workspace', 'create_obj_projects', 'dup')`),
    ]))
    expect(ok).toBe(false)
    expect((await cols('obj_projects')).map((c) => c.name)).not.toContain('budget')
  })

  it('Q4: ADD COLUMN variants: nullable, NOT NULL with default, CHECK enum, REFERENCES (must default null)', async () => {
    await d1.batch([
      d1.prepare(`alter table obj_projects add column budget integer`),
      d1.prepare(`alter table obj_projects add column status text not null default 'open' check (status in ('open','won','lost'))`),
      d1.prepare(`alter table obj_projects add column contact_id text references contacts(id)`),
    ])
    expect((await cols('obj_projects')).map((c) => c.name)).toEqual(['id', 'title', 'owner_contact_id', 'budget', 'status', 'contact_id'])
    // NOT NULL without a default: allowed on an EMPTY table, refused once it has rows (so the vault always adds a default or nullable)
    await d1.batch([d1.prepare(`create table obj_probe (id text primary key) strict`)])
    expect(await works(() => d1.prepare(`alter table obj_probe add column a text not null`).run())).toBe(true)
    await d1.batch([d1.prepare(`create table obj_probe2 (id text primary key) strict`), d1.prepare(`insert into obj_probe2 values ('1')`)])
    expect(await works(() => d1.prepare(`alter table obj_probe2 add column a text not null`).run())).toBe(false)
    // REFERENCES with a non-null default: refused on a non-empty table (observed), so FK columns are always added nullable
    expect(await works(() => d1.prepare(`alter table obj_probe2 add column r text references contacts(id) default 'x'`).run())).toBe(false)
  })

  it('Q5: declared foreign keys are enforced on custom tables', async () => {
    expect(await works(() => d1.prepare(`insert into obj_projects (id, title, owner_contact_id) values ('p1','x','nope')`).run())).toBe(false)
    await d1.prepare(`insert into contacts values ('c1','Ada')`).run()
    expect(await works(() => d1.prepare(`insert into obj_projects (id, title, owner_contact_id) values ('p1','x','c1')`).run())).toBe(true)
    expect(await works(() => d1.prepare(`insert into obj_projects (id, title, status) values ('p2','x','bogus')`).run())).toBe(false) // CHECK
  })

  it('Q6: introspection works through SQL: sqlite_schema, pragma_table_info, pragma_foreign_key_list', async () => {
    const ddl = (await d1.prepare(`select sql from sqlite_schema where name = 'obj_projects'`).first())!.sql as string
    expect(ddl.toLowerCase()).toContain('create table obj_projects')
    expect(ddl).toContain('budget') // ALTER appends to the stored DDL text
    const fks = (await d1.prepare(`select "table" t, "from" f, "to" tc from pragma_foreign_key_list('obj_projects') order by "from"`).all()).results
    expect(fks).toEqual([{ t: 'contacts', f: 'contact_id', tc: 'id' }, { t: 'contacts', f: 'owner_contact_id', tc: 'id' }])
    const list = (await d1.prepare(`select m.name t, p.name c, p.type ty from sqlite_schema m, pragma_table_info(m.name) p where m.type = 'table' and m.name like 'obj\\_%' escape '\\'`).all()).results
    expect(list.length).toBeGreaterThan(0)
  })

  it('Q7: the same binding sees new tables immediately, including via already-prepared-by-text statements', async () => {
    await d1.prepare(`select count(*) from obj_projects`).first()
    await d1.batch([d1.prepare(`create table obj_deals (id text primary key) strict`)])
    expect((await d1.prepare(`select count(*) n from obj_deals`).first())!.n).toBe(0)
  })

  it('Q8: concurrent creators of the same object: exactly one wins (bookkeeping unique key is the lock)', async () => {
    const attempt = () => d1.batch([
      d1.prepare(`insert into schema_migrations (kind, name, checksum) values ('workspace', 'create_obj_race', 'x')`),
      d1.prepare(`create table obj_race (id text primary key) strict`),
    ])
    const results = await Promise.all([works(attempt), works(attempt), works(attempt)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await tables()).toContain('obj_race')
  })

  it('Q9: DDL cannot bind identifiers, so names must be validated; a hostile name is rejected by quoting rules', async () => {
    const name = `obj_x"; drop table contacts; --`
    // quoting with doubled double-quotes keeps it one identifier; the vault must instead reject anything but [a-z0-9_]
    await d1.prepare(`create table "${name.replace(/"/g, '""')}" (id text primary key) strict`).run()
    expect(await tables()).toContain('contacts')
    expect(/^obj_[a-z][a-z0-9_]{0,40}$/.test(name)).toBe(false)
  })

  it('Q10: rename/drop column exist in this SQLite (not used in the MVP) and the table count scales', async () => {
    expect(await works(() => d1.prepare(`alter table obj_projects rename column budget to amount`).run())).toBe(true)
    expect(await works(() => d1.prepare(`alter table obj_projects drop column amount`).run())).toBe(true)
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) {
      const batch = Array.from({ length: 25 }, (_, j) => d1.prepare(`create table obj_bulk_${i}_${j} (id text primary key, a text, b integer) strict`))
      await d1.batch(batch)
    }
    const n = (await tables()).filter((t) => t.startsWith('obj_bulk_')).length
    console.log(`SPIKE: ${n} tables created in ${Date.now() - t0} ms`)
    expect(n).toBe(500)
    const t1 = Date.now()
    await d1.prepare(`select m.name, p.name from sqlite_schema m, pragma_table_info(m.name) p where m.type='table' and m.name not like '\\_cf\\_%' escape '\\' and m.name not like 'sqlite\\_%' escape '\\'`).all()
    console.log(`SPIKE: full introspection over ~500 tables in ${Date.now() - t1} ms`)
  })
})
