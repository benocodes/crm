import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE574]] D6: migration 0028 adds the nullable `messages.content_sha256` (the capture fingerprint of [[CORE571]] D6/D7). Seeded at 0027
// with a message; raw inserts are the permitted exception (the test proves what the database does, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-25T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const THREAD = id(15)
const OLD = id(16)
const HEX = 'ab'.repeat(32)

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
const refused = (sqlText: string, ...binds: unknown[]) =>
  run(sqlText, ...binds).then(
    () => null,
    (e: Error) => e.message,
  )
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const insertMessage = (rowId: string, extra = '', vals: unknown[] = []) =>
  run(
    `INSERT INTO messages (id, organization_id, created_by, created_at, thread_id, channel, kind, external_id, author, occurred_at, preview, content_key, version${extra}) VALUES (?, ?, ?, ?, ?, 'email', 'message', ?, '{}', ?, 'hi', 'orgs/x/', 1${vals.map(() => ', ?').join('')})`,
    rowId,
    ORG,
    USER,
    AT,
    THREAD,
    `ext-${rowId}`,
    AT,
    ...vals,
  )

describe('migration 0028_content_sha256 over a database at 0027 holding messages', () => {
  it('adds a nullable column: existing rows read back null, a digest is stored, a malformed one is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig27-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0028')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
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
    await insertMessage(OLD)

    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0028'))
    expect(name).toBe('0028_content_sha256.sql')
    const lone = mkdtempSync(join(tmpdir(), 'mig28only-'))
    cpSync(join(MIGRATIONS_DIR, name!), join(lone, name!))
    expect(await applyMigrations(d1, lone)).toEqual([name])

    expect(await all('select content_sha256 from messages where id = ?', OLD)).toEqual([{ content_sha256: null }])
    const column = (await all<{ name: string; notnull: number }>('pragma table_info(messages)')).find(
      (c) => c.name === 'content_sha256',
    )
    expect(column).toMatchObject({ notnull: 0 })
    // a writer that names no fingerprint still succeeds; a lowercase hex digest is stored; anything else is refused
    await insertMessage(id(40))
    await insertMessage(id(41), ', content_sha256', [HEX])
    expect(await all('select content_sha256 from messages where id = ?', id(41))).toEqual([{ content_sha256: HEX }])
    for (const bad of ['xyz', 'AB'.repeat(32), 'ab'.repeat(31)])
      expect(await refused('UPDATE messages SET content_sha256 = ? WHERE id = ?', bad, OLD), bad).toMatch(
        /CHECK|constraint/i,
      )
    expect(await all('pragma foreign_key_check')).toEqual([])
  })
})
