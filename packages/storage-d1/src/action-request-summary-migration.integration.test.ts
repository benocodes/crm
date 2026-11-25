import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[AGT588]] D7 (cycle b): migration 0030 adds the nullable `action_requests.target_summary` and nothing else. Seeded at 0029 with a request by raw SQL
// (the permitted exception: the test proves what the database does, which no operation reaches): the old row reads NULL, nothing else changes.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-25T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})
const run = (sqlText: string, ...binds: unknown[]) =>
  d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
    () => null,
    (e: Error) => e.message,
  )
const all = async <T = Record<string, unknown>>(sqlText: string) =>
  ((await d1.prepare(sqlText).all()).results ?? []) as T[]
const insertRequest = (rowId: string, extra?: string) =>
  run(
    `INSERT INTO action_requests (id, created_at, updated_at, organization_id, created_by, operation, arguments, status, reason, evidence, expires_at${extra !== undefined ? ', target_summary' : ''}) VALUES (?, ?, ?, ?, ?, 'tasks.update', '{}', 'pending', 'r', '[]', '2026-12-01T09:00:00.000Z'${extra !== undefined ? ', ?' : ''})`,
    ...[rowId, AT, AT, ORG, USER, ...(extra !== undefined ? [extra] : [])],
  )

describe('migration 0030 over a database at 0029 holding an action request', () => {
  it('adds target_summary, leaves the old row NULL and every other column as it was, and bounds the length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig29-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0030')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    expect(await insertRequest(id(1))).toBeNull()
    const before = await all('select * from action_requests')

    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0030'))
    expect(name).toBe('0030_action_request_target_summary.sql')
    const lone = mkdtempSync(join(tmpdir(), 'mig30only-'))
    cpSync(join(MIGRATIONS_DIR, name!), join(lone, name!))
    expect(await applyMigrations(d1, lone)).toEqual([name])

    const after = await all('select * from action_requests')
    expect(after.map((r) => r.target_summary)).toEqual([null])
    expect(after.map(({ target_summary: _t, ...rest }) => rest)).toEqual(before)
    const cols = await all<{ name: string; notnull: number }>(
      'select name, "notnull" from pragma_table_info(\'action_requests\')',
    )
    expect(cols.find((c) => c.name === 'target_summary')).toEqual({ name: 'target_summary', notnull: 0 })

    expect(await insertRequest(id(2), 'Update tasks record "x"')).toBeNull()
    expect(await insertRequest(id(3), 'x'.repeat(500))).toBeNull()
    expect(await insertRequest(id(4), 'x'.repeat(501))).toMatch(/action_requests_target_summary/)
    expect(await insertRequest(id(5), '')).toMatch(/action_requests_target_summary/)
  })
})
