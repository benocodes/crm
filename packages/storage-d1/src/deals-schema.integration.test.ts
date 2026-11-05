import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE130 D2, D7, D9, D19, D21a: the three deal tables and migration 0009 applied over a database at 0008 that already holds data.
// The raw inserts below are the permitted exception (D21a): the schema test proves what the database refuses, which no operation can reach.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const P1 = id(10)
const P2 = id(11)
const S1 = id(20) // in P1
const S2 = id(21) // in P2
const S1_DELETED = id(22) // in P1, soft-deleted

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'], { migrate: false })
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1.batch([d1.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row))]).then(() => null, (e: Error) => e.message)
}
const base = { organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT }
const pipeline = (over: Record<string, unknown> = {}) => ({ id: P1, name: 'Sales', ...base, ...over })
const stage = (over: Record<string, unknown> = {}) => ({ id: S1, pipeline_id: P1, name: 'Researched', kind: 'open', position: 10, ...base, ...over })
const deal = (over: Record<string, unknown> = {}) => ({ id: id(30), name: 'Acme', pipeline_id: P1, stage_id: S1, ...base, ...over })
const count = async (table: string) => ((await d1.prepare(`select count(*) as n from "${table}"`).first()) as { n: number }).n

describe('migration 0009_deals over a database at 0008 with data', () => {
  it('applies, keeps companies, contacts, tags and edges unchanged, and creates the three tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0009')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0008_tags.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    const co = id(40)
    const ct = id(41)
    const tg = id(42)
    expect(await insert('companies', { id: co, name: 'Acme', ...base })).toBeNull()
    expect(await insert('contacts', { id: ct, name: 'Ann', company_id: co, ...base })).toBeNull()
    expect(await insert('tags', { id: tg, name: 'Prospects', ...base })).toBeNull()
    expect(await insert('associations', { id: id(43), a_type: 'companies', a_id: co, b_type: 'tags', b_id: tg, ...base })).toBeNull()
    const before = async () => ({
      companies: (await d1.prepare('select * from companies').all()).results,
      contacts: (await d1.prepare('select * from contacts').all()).results,
      tags: (await d1.prepare('select * from tags').all()).results,
      associations: (await d1.prepare('select * from associations').all()).results,
    })
    const snapshot = await before()
    for (const t of ['pipelines', 'pipeline_stages', 'deals']) expect((await d1.prepare('select name from sqlite_master where name = ?').bind(t).all()).results, t).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig9-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0009'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0009_deals.sql'])
    expect(await before()).toEqual(snapshot)
    for (const t of ['pipelines', 'pipeline_stages', 'deals']) expect((await d1.prepare('select name from sqlite_master where name = ?').bind(t).all()).results, t).toEqual([{ name: t }])
    for (const t of ['pipelines', 'pipeline_stages', 'deals']) expect(await count(t), `${t} starts empty (D5: nothing seeded)`).toBe(0)
  })

  it('constrains pipelines and stages: names 1..100, kind, position >= 0, uuid ids, ISO stamps, declared FKs', async () => {
    expect(await insert('pipelines', pipeline())).toBeNull()
    expect(await insert('pipelines', pipeline({ id: P2, name: 'x'.repeat(100) }))).toBeNull()
    expect(await insert('pipelines', pipeline({ id: id(12), name: '' }))).toMatch(/CHECK/)
    expect(await insert('pipelines', pipeline({ id: id(12), name: 'x'.repeat(101) }))).toMatch(/CHECK/)
    expect(await insert('pipelines', pipeline({ id: 'not-a-uuid', name: 'ok' }))).toMatch(/CHECK/)
    expect(await insert('pipelines', pipeline({ id: id(12), name: 'ok', created_at: 'yesterday' }))).toMatch(/CHECK/)
    expect(await insert('pipeline_stages', stage())).toBeNull()
    expect(await insert('pipeline_stages', stage({ id: S2, pipeline_id: P2, name: 'Won', kind: 'won', position: 0 }))).toBeNull()
    expect(await insert('pipeline_stages', stage({ id: S1_DELETED, name: 'Old', position: 5, deleted_at: AT }))).toBeNull()
    expect(await insert('pipeline_stages', stage({ id: id(23), name: 'Bad kind', kind: 'closed' }))).toMatch(/CHECK/)
    expect(await insert('pipeline_stages', stage({ id: id(23), name: 'Negative', position: -1 }))).toMatch(/CHECK/)
    expect(await insert('pipeline_stages', stage({ id: id(23), name: '' }))).toMatch(/CHECK/)
    expect(await insert('pipeline_stages', stage({ id: id(23), name: 'No pipeline', pipeline_id: id(99) }))).toMatch(/FOREIGN KEY/)
    const fks = async (t: string) => (await d1.prepare(`select "table" as t from pragma_foreign_key_list('${t}') order by 1`).all()).results!.map((r) => (r as { t: string }).t)
    expect(await fks('pipelines')).toEqual(['organizations', 'principals'])
    expect(await fks('pipeline_stages')).toEqual(['organizations', 'pipelines', 'principals'])
  })

  it('pipeline names are unique per organisation among live rows, case-insensitively; stage names within one pipeline', async () => {
    expect(await insert('pipelines', pipeline({ id: id(12), name: 'SALES' }))).toMatch(/UNIQUE/)
    expect(await insert('pipeline_stages', stage({ id: id(23), name: 'RESEARCHED' }))).toMatch(/UNIQUE/)
    expect(await insert('pipeline_stages', stage({ id: id(23), pipeline_id: P2, name: 'RESEARCHED' }))).toBeNull() // another pipeline
    expect(await insert('pipeline_stages', stage({ id: id(24), name: 'Old', position: 6 }))).toBeNull() // the deleted 'Old' freed its name
    await d1.prepare('UPDATE pipelines SET deleted_at = ? WHERE id = ?').bind(AT, P2).run()
    expect(await insert('pipelines', pipeline({ id: id(12), name: 'x'.repeat(100).toUpperCase() }))).toBeNull() // the deleted P2 freed its name
  })

  it('constrains deals: name 1..200, amount >= 0 and <= 2^53-1 needing a currency, currency three capitals, a calendar date', async () => {
    const ok = deal()
    expect(await insert('deals', ok)).toBeNull()
    expect(await insert('deals', deal({ id: id(31), amount_minor: 0, currency: 'USD', expected_close_date: '2026-12-31', owner_id: USER }))).toBeNull()
    expect(await insert('deals', deal({ id: id(32), currency: 'EUR' }))).toBeNull() // a currency without an amount
    expect(await insert('deals', deal({ id: id(33), name: 'x'.repeat(200) }))).toBeNull()
    expect(await insert('deals', deal({ id: id(34), amount_minor: Number.MAX_SAFE_INTEGER, currency: 'JPY' }))).toBeNull()
    for (const [what, over] of [
      ['an empty name', { name: '' }],
      ['a 201 character name', { name: 'x'.repeat(201) }],
      ['a negative amount', { amount_minor: -1, currency: 'USD' }],
      ['an amount without a currency', { amount_minor: 5 }],
      ['a lower-case currency', { amount_minor: 5, currency: 'usd' }],
      ['a four letter currency', { amount_minor: 5, currency: 'USD1' }],
      ['a currency with a digit', { amount_minor: 5, currency: 'U5D' }],
      ['an impossible date', { expected_close_date: '2026-02-30' }],
      ['a date with a time', { expected_close_date: '2026-02-03T00:00:00Z' }],
      ['a malformed closed_at', { closed_at: 'soon' }],
      ['a malformed id', { id: 'x' }],
    ] as const) {
      expect(await insert('deals', deal({ id: id(35), ...over })), what).toMatch(/CHECK/)
    }
    expect(await insert('deals', deal({ id: id(35), owner_id: id(98) })), 'an unknown owner').toMatch(/FOREIGN KEY/)
    expect(await insert('deals', deal({ id: id(35), pipeline_id: id(97) })), 'an unknown pipeline').toMatch(/FOREIGN KEY/)
    expect(await insert('deals', deal({ id: id(35), stage_id: id(96) })), 'an unknown stage').toMatch(/FOREIGN KEY/)
    const fks = (await d1.prepare("select \"table\" as t from pragma_foreign_key_list('deals') order by 1").all()).results!.map((r) => (r as { t: string }).t)
    expect(fks).toEqual(['organizations', 'pipeline_stages', 'pipeline_stages', 'pipelines', 'principals', 'principals'])
  })

  it('the composite foreign key refuses a deal whose pipeline_id disagrees with its stage, and leaves nothing (D9, D21a)', async () => {
    const before = await count('deals')
    // S2 belongs to P2; the deal says P1. Both ids exist, so only the composite key can refuse it.
    const err = await insert('deals', deal({ id: id(36), pipeline_id: P1, stage_id: S2 }))
    expect(err).toMatch(/FOREIGN KEY/)
    expect(await count('deals')).toBe(before)
    expect((await d1.prepare('select id from deals where id = ?').bind(id(36)).all()).results).toEqual([])
    expect(await insert('deals', deal({ id: id(36), pipeline_id: P2, stage_id: S2 }))).toBeNull() // the agreeing pair is accepted
  })

  it('indexes the lookups: (organization_id, id) per table, deals by pipeline, stage and owner', async () => {
    const idx = async (t: string) => (await d1.prepare(`select name from pragma_index_list('${t}') where name like 'idx_%'`).all()).results!.map((r) => (r as { name: string }).name).sort()
    expect(await idx('pipelines')).toContain('idx_pipelines_organization_id_id')
    expect(await idx('pipeline_stages')).toEqual(expect.arrayContaining(['idx_pipeline_stages_organization_id_id', 'idx_pipeline_stages_pipeline_id_id']))
    expect(await idx('deals')).toEqual(expect.arrayContaining(['idx_deals_organization_id_id', 'idx_deals_organization_id_pipeline_id', 'idx_deals_organization_id_stage_id', 'idx_deals_organization_id_owner_id']))
  })
})
