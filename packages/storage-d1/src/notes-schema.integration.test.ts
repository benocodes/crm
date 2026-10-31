import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE74 D17, D22: the `notes` table and migration 0006 applied over a database that already holds data at 0005.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const NOTE = '0190b2c4-0000-7000-8000-0000000000c1'

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'], { migrate: false })
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})

const note = (over: Record<string, unknown> = {}) => ({ id: NOTE, organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, title: 'T', content: 'C', ...over })
const attempt = async (row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  await d1.batch([d1.prepare(`INSERT INTO "notes" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row))])
}
const refused = (row: Record<string, unknown>) => attempt(row).then(() => null, (e: Error) => e.message)

describe('migration 0006_notes over a database at 0005 with data', () => {
  it('applies, keeps the existing rows, and creates the table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0006')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0005_associations.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await d1.prepare('INSERT INTO tasks (id, organization_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(NOTE.replace('c1', 'd1'), ORG, 'keep me', USER, AT, AT).run()
    expect((await d1.prepare("select name from sqlite_master where name = 'notes'").all()).results).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig6-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0006'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0006_notes.sql'])
    expect((await d1.prepare('select title from tasks').all()).results).toEqual([{ title: 'keep me' }])
    expect((await d1.prepare("select name from sqlite_master where name = 'notes'").all()).results).toEqual([{ name: 'notes' }])
  })

  it('constrains the table: content 1..100000, title null or 1..500, uuid id, ISO stamps, declared FKs', async () => {
    expect(await refused(note())).toBeNull()
    expect(await refused(note({ id: NOTE.replace('c1', 'c2'), title: null }))).toBeNull()
    expect(await refused(note({ id: NOTE.replace('c1', 'c3'), content: 'x'.repeat(100_000) }))).toBeNull()
    expect(await refused(note({ id: NOTE.replace('c1', 'c4'), content: '' }))).toMatch(/CHECK/)
    expect(await refused(note({ id: NOTE.replace('c1', 'c4'), content: 'x'.repeat(100_001) }))).toMatch(/CHECK/)
    expect(await refused(note({ id: NOTE.replace('c1', 'c4'), title: 'x'.repeat(501) }))).toMatch(/CHECK/)
    expect(await refused(note({ id: 'not-a-uuid' }))).toMatch(/CHECK/)
    expect(await refused(note({ id: NOTE.replace('c1', 'c4'), created_at: 'yesterday' }))).toMatch(/CHECK/)
    expect(await refused(note({ id: NOTE.replace('c1', 'c4'), deleted_at: 'never' }))).toMatch(/CHECK/)
    const fks = (await d1.prepare("select \"table\" as t from pragma_foreign_key_list('notes') order by 1").all()).results.map((r) => (r as { t: string }).t)
    expect(fks).toEqual(['organizations', 'principals'])
  })
})
