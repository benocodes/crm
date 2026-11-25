import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CHN193]] D5 ([[AGT588]]): migration 0029 sets `messages.content_sha256` to NULL on every row and touches nothing else. Seeded at 0028 with
// fingerprinted rows by raw SQL (the permitted exception: the test proves what the database does, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-25T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const THREAD = id(15)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})

const run = (sqlText: string, ...binds: unknown[]) => d1.batch([d1.prepare(sqlText).bind(...binds)])
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const insertMessage = (rowId: string, sha: string | null) =>
  run(
    `INSERT INTO messages (id, organization_id, created_by, created_at, thread_id, channel, kind, external_id, author, occurred_at, preview, content_key, version, content_sha256) VALUES (?, ?, ?, ?, ?, 'email', 'message', ?, '{}', ?, 'hi', 'orgs/x/', 1, ?)`,
    rowId,
    ORG,
    USER,
    AT,
    THREAD,
    `ext-${rowId}`,
    AT,
    sha,
  )

describe('migration 0029 over a database at 0028 holding fingerprinted messages', () => {
  it('nulls every content_sha256, leaves every other column alone, and adds no event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig28-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0029')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await run(
      `INSERT INTO threads (id, organization_id, created_by, created_at, channel, subject) VALUES (?, ?, ?, ?, 'email', 's')`,
      THREAD,
      ORG,
      USER,
      AT,
    )
    await insertMessage(id(16), 'ab'.repeat(32))
    await insertMessage(id(17), 'cd'.repeat(32))
    await insertMessage(id(18), null)
    const before = await all('select * from messages order by id')
    const eventsBefore = await all('select count(*) as n from events')

    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0029'))
    expect(name).toBe('0029_reset_content_sha256.sql')
    const lone = mkdtempSync(join(tmpdir(), 'mig29only-'))
    cpSync(join(MIGRATIONS_DIR, name!), join(lone, name!))
    expect(await applyMigrations(d1, lone)).toEqual([name])

    const after = await all('select * from messages order by id')
    expect(after.map((r) => r.content_sha256)).toEqual([null, null, null])
    expect(after.map(({ content_sha256: _a, ...rest }) => rest)).toEqual(
      before.map(({ content_sha256: _b, ...rest }) => rest),
    )
    expect(before.map((r) => r.content_sha256)).toEqual(['ab'.repeat(32), 'cd'.repeat(32), null])
    expect(await all('select count(*) as n from events')).toEqual(eventsBefore)
    // the append-only guard is back: messages still refuse any other update
    await expect(run('UPDATE messages SET preview = ? WHERE id = ?', 'x', id(16))).rejects.toThrow(/append_only/)
    expect(
      await all("select name from sqlite_master where type = 'trigger' and name = 'messages_append_only'"),
    ).toHaveLength(1)
  })
})
