import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE129 D2, D4, D16: the `tags` table and migration 0008 applied over a database that already holds data at 0007.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'], { migrate: false })
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})

const tag = (over: Record<string, unknown> = {}) => ({ id: id(1), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, name: 'Prospects', ...over })
const refused = async (row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1.batch([d1.prepare(`INSERT INTO "tags" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row))]).then(() => null, (e: Error) => e.message)
}

describe('migration 0008_tags over a database at 0007 with data', () => {
  it('applies, keeps the existing rows, and creates the table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0008')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0007_agent_principals.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await d1.prepare('INSERT INTO tasks (id, organization_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id(50), ORG, 'keep me', USER, AT, AT).run()
    expect((await d1.prepare("select name from sqlite_master where name = 'tags'").all()).results).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig8-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0008'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0008_tags.sql'])
    expect((await d1.prepare('select title from tasks').all()).results).toEqual([{ title: 'keep me' }])
    expect((await d1.prepare("select name from sqlite_master where name = 'tags'").all()).results).toEqual([{ name: 'tags' }])
  })

  it('constrains the table: name 1..100, description null or 1..1000, uuid id, ISO stamps, declared FKs', async () => {
    expect(await refused(tag())).toBeNull()
    expect(await refused(tag({ id: id(2), name: 'x'.repeat(100), description: 'y'.repeat(1000) }))).toBeNull()
    expect(await refused(tag({ id: id(3), name: '' }))).toMatch(/CHECK/)
    expect(await refused(tag({ id: id(3), name: 'x'.repeat(101) }))).toMatch(/CHECK/)
    expect(await refused(tag({ id: id(3), name: 'ok', description: '' }))).toMatch(/CHECK/)
    expect(await refused(tag({ id: id(3), name: 'ok', description: 'y'.repeat(1001) }))).toMatch(/CHECK/)
    expect(await refused(tag({ id: 'not-a-uuid', name: 'ok' }))).toMatch(/CHECK/)
    expect(await refused(tag({ id: id(3), name: 'ok', created_at: 'yesterday' }))).toMatch(/CHECK/)
    const fks = (await d1.prepare("select \"table\" as t from pragma_foreign_key_list('tags') order by 1").all()).results!.map((r) => (r as { t: string }).t)
    expect(fks).toEqual(['organizations', 'principals'])
  })

  it('the name is unique per organisation among live rows, case-insensitively; a deleted row frees it', async () => {
    expect(await refused(tag({ id: id(4), name: 'PROSPECTS' }))).toMatch(/UNIQUE/)
    await d1.prepare('UPDATE tags SET deleted_at = ? WHERE id = ?').bind(AT, id(1)).run()
    expect(await refused(tag({ id: id(4), name: 'PROSPECTS' }))).toBeNull()
  })
})
