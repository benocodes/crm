import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE408]] D3, group 1: migration 0022 rebuilds `identities` over a database at 0021 holding an own identity on a
// connection, a contact's identity with an interaction participant, and a soft-deleted identity; then the new owner rule.
// Raw inserts are the permitted exception: the schema test proves what the database refuses, which no operation reaches.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-17T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const OWN = id(10)
const CONTACT = id(11)
const ATTACHED = id(12)
const GONE = id(13)
const CONN = id(14)
const THREAD = id(15)
const MSG = id(16)
const INTER = id(17)
const PART = id(18)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1
    .batch([
      d1
        .prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .bind(...Object.values(row)),
    ])
    .then(
      () => null,
      (e: Error) => e.message,
    )
}
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const base = { organization_id: ORG, created_at: AT, created_by: USER }
const ident = (n: number, over: Record<string, unknown>) => ({
  id: id(n),
  ...base,
  updated_at: AT,
  kind: 'email',
  value: `a${n}@example.test`,
  ...over,
})

describe('migration 0022_unattached_identities over a database at 0021', () => {
  let before: Record<string, unknown>[]
  it('keeps every row and column, the indexes and the foreign keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0022')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0021_capture_settings.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    expect(await insert('contacts', { id: CONTACT, ...base, updated_at: AT, name: 'Ann' })).toBeNull()
    expect(await insert('identities', ident(10, { value: 'me@example.test', contact_id: null, own: 1 }))).toBeNull()
    expect(await insert('identities', ident(12, { contact_id: CONTACT, own: 0 }))).toBeNull()
    expect(
      await insert(
        'identities',
        ident(13, { value: 'gone@example.test', contact_id: CONTACT, own: 0, deleted_at: AT }),
      ),
    ).toBeNull()
    expect(
      await insert('channel_connections', {
        id: CONN,
        ...base,
        updated_at: AT,
        provider: 'google',
        account_id: 'sub-1',
        identity_id: OWN,
        owner_id: USER,
        status: 'active',
        granted_scopes: '["openid"]',
        connected_at: AT,
      }),
    ).toBeNull()
    expect(await insert('threads', { id: THREAD, ...base, channel: 'email', subject: 's' })).toBeNull()
    expect(
      await insert('messages', {
        id: MSG,
        ...base,
        thread_id: THREAD,
        channel: 'email',
        kind: 'message',
        external_id: 'm@y',
        in_reply_to: null,
        author: '{"user_id":"u"}',
        occurred_at: AT,
        preview: 'hi',
        content_key: 'orgs/x/',
        version: 1,
        retracted_at: null,
      }),
    ).toBeNull()
    expect(
      await insert('interactions', {
        id: INTER,
        ...base,
        kind: 'message',
        channel: 'email',
        direction: 'inbound',
        occurred_at: AT,
        thread_id: THREAD,
        message_id: MSG,
      }),
    ).toBeNull()
    expect(
      await insert('interaction_participants', {
        id: PART,
        ...base,
        interaction_id: INTER,
        identity_id: ATTACHED,
        role: 'from',
      }),
    ).toBeNull()
    before = await all('select * from identities order by id')
    expect(before).toHaveLength(3)

    const only = mkdtempSync(join(tmpdir(), 'mig22-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0022')))
      cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0022_unattached_identities.sql'])

    expect(await all('select * from identities order by id')).toEqual(before)
    expect(await all('PRAGMA foreign_key_check')).toEqual([])
    expect(await all('select id, identity_id from interaction_participants')).toEqual([
      { id: PART, identity_id: ATTACHED },
    ])
    expect(await all('select id, identity_id from channel_connections')).toEqual([{ id: CONN, identity_id: OWN }])
    const idx = await all<{ name: string }>(
      "select name from sqlite_master where type = 'index' and tbl_name = 'identities' and name like 'idx_%' order by name",
    )
    expect(idx.map((i) => i.name)).toEqual(['idx_identities_address_unique', 'idx_identities_contact_id'])
    const ddl = (await all<{ sql: string }>("select sql from sqlite_master where name = 'identities'"))[0]!.sql
    expect(ddl).toContain('identities_own_has_no_contact')
    expect(ddl).not.toContain('identities_own_xor_contact')
  })

  it('the new owner rule: accepts own 0 / null, own 0 / contact and own 1 / null; refuses own 1 / contact', async () => {
    expect(await insert('identities', ident(20, { contact_id: null, own: 0 }))).toBeNull()
    expect(await insert('identities', ident(21, { contact_id: CONTACT, own: 0 }))).toBeNull()
    expect(await insert('identities', ident(22, { contact_id: null, own: 1 }))).toBeNull()
    expect(await insert('identities', ident(23, { contact_id: CONTACT, own: 1 }))).toMatch(/CHECK/)
    expect(await insert('identities', ident(24, { contact_id: null, own: 2 }))).toMatch(/CHECK/)
  })

  it('the partial unique index still refuses a second live address and allows one after a soft delete', async () => {
    expect(await insert('identities', ident(30, { value: 'dup@example.test', contact_id: null, own: 0 }))).toBeNull()
    expect(await insert('identities', ident(31, { value: 'dup@example.test', contact_id: null, own: 0 }))).toMatch(
      /UNIQUE/,
    )
    await d1.prepare('update identities set deleted_at = ? where id = ?').bind(AT, id(30)).run()
    expect(await insert('identities', ident(32, { value: 'dup@example.test', contact_id: null, own: 0 }))).toBeNull()
  })

  it('the composite foreign key to contacts still holds', async () => {
    expect(await insert('identities', ident(40, { contact_id: id(99), own: 0 }))).toMatch(/FOREIGN KEY|constraint/i)
  })
})
