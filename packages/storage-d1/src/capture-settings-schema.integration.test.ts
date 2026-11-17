import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CHN406]] D1, D2, D8, D12, D14: migration 0021 applied over a database at 0020 that already holds a live and a soft-deleted
// connection (seeded at the previous migration, never through the new code), then the constraints each new table holds whatever writes it.
// The raw inserts are the permitted exception (the schema test proves what the database refuses, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-17T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const IDENT = id(10)
const LIVE = id(11)
const DELETED = id(12)

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
const base = { organization_id: ORG, created_at: AT }
const conn = (over: Record<string, unknown>) => ({
  ...base,
  created_by: USER,
  updated_at: AT,
  provider: 'google',
  identity_id: IDENT,
  owner_id: USER,
  status: 'active',
  granted_scopes: '["openid"]',
  connected_at: AT,
  ...over,
})
const label = (over: Record<string, unknown> = {}) => ({
  id: id(40),
  ...base,
  connection_id: LIVE,
  label_id: 'Label_1',
  ...over,
})
const blocked = (over: Record<string, unknown> = {}) => ({
  id: id(50),
  ...base,
  connection_id: LIVE,
  kind: 'domain',
  value: 'spam.example',
  ...over,
})
const workspace = (over: Record<string, unknown> = {}) => ({
  id: id(60),
  ...base,
  created_by: USER,
  updated_at: AT,
  kind: 'domain',
  value: 'spam.example',
  ...over,
})

describe('migration 0021_capture_settings over a database at 0020 with connections', () => {
  it('gives a live and a soft-deleted connection exactly INBOX and SENT and the scalar defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0021')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0020_drop_api_key_webhook_tables.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    expect(
      await insert('identities', {
        id: IDENT,
        ...base,
        created_by: USER,
        updated_at: AT,
        kind: 'email',
        value: 'ann@example.test',
        contact_id: null,
        own: 1,
      }),
    ).toBeNull()
    expect(await insert('channel_connections', conn({ id: LIVE, account_id: 'sub-live' }))).toBeNull()
    expect(
      await insert('channel_connections', conn({ id: DELETED, account_id: 'sub-gone', deleted_at: AT })),
    ).toBeNull()
    for (const t of ['connection_capture_labels', 'connection_blocked_senders', 'blocked_senders'])
      expect(await all('select name from sqlite_master where name = ?', t), t).toEqual([])

    const only = mkdtempSync(join(tmpdir(), 'mig21-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0021')))
      cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0021_capture_settings.sql'])

    const labels = await all<{ connection_id: string; label_id: string }>(
      'select connection_id, label_id from connection_capture_labels order by connection_id, label_id',
    )
    expect(labels).toEqual([
      { connection_id: LIVE, label_id: 'INBOX' },
      { connection_id: LIVE, label_id: 'SENT' },
      { connection_id: DELETED, label_id: 'INBOX' },
      { connection_id: DELETED, label_id: 'SENT' },
    ])
    expect(
      await all(
        'select id, exclude_group_addresses, exclude_personal_domains, contact_creation from channel_connections order by id',
      ),
    ).toEqual([
      { id: LIVE, exclude_group_addresses: 0, exclude_personal_domains: 0, contact_creation: 'sent_and_received' },
      { id: DELETED, exclude_group_addresses: 0, exclude_personal_domains: 0, contact_creation: 'sent_and_received' },
    ])
    expect(await all('select count(*) as n from connection_blocked_senders')).toEqual([{ n: 0 }])
    expect(await all('select count(*) as n from blocked_senders')).toEqual([{ n: 0 }])
    // The backfilled rows are valid rows: ids are UUIDs the id check accepts, in the organisation of their connection.
    const ids = await all<{ id: string; organization_id: string }>(
      'select id, organization_id from connection_capture_labels',
    )
    for (const r of ids) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(r.organization_id).toBe(ORG)
    }
    expect(new Set(ids.map((r) => r.id)).size).toBe(4)
  })
})

describe('the capture-settings constraints hold whatever writes (one drift case per constraint)', () => {
  it('channel_connections refuses a third contact_creation value and a non-0/1 flag; updates are held too', async () => {
    const mk = (over: Record<string, unknown>) => conn({ id: id(20), account_id: 'sub-x', ...over })
    expect(await insert('channel_connections', mk({ contact_creation: 'everyone' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', mk({ exclude_group_addresses: 2 }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', mk({ exclude_personal_domains: -1 }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', mk({ contact_creation: 'none', exclude_group_addresses: 1 }))).toBeNull()
    const upd = (s: string) =>
      d1
        .prepare(`update channel_connections set ${s} where id = ?`)
        .bind(LIVE)
        .run()
        .then(
          () => null,
          (e: Error) => e.message,
        )
    expect(await upd("contact_creation = 'bogus'")).toMatch(/CHECK/)
    expect(await upd('exclude_personal_domains = 5')).toMatch(/CHECK/)
  })

  it('connection_capture_labels: shape, uniqueness and the composite foreign key', async () => {
    expect(await insert('connection_capture_labels', label({ label_id: 'Label_9' }))).toBeNull()
    expect(await insert('connection_capture_labels', label({ id: id(41), label_id: 'Label_9' }))).toMatch(/UNIQUE/)
    expect(await insert('connection_capture_labels', label({ id: id(42), label_id: '' }))).toMatch(/CHECK/)
    expect(await insert('connection_capture_labels', label({ id: id(42), label_id: 'has space' }))).toMatch(/CHECK/)
    expect(await insert('connection_capture_labels', label({ id: id(42), label_id: 'x'.repeat(101) }))).toMatch(/CHECK/)
    expect(await insert('connection_capture_labels', label({ id: id(42), connection_id: id(99) }))).toMatch(
      /FOREIGN KEY/,
    )
    // right connection id, wrong organisation: the pair must name a connection
    expect(
      await insert('connection_capture_labels', label({ id: id(42), organization_id: id(98), label_id: 'L2' })),
    ).toMatch(/FOREIGN KEY|constraint/i)
    expect(await insert('connection_capture_labels', label({ id: 'not-a-uuid', label_id: 'L3' }))).toMatch(/CHECK/)
  })

  it('connection_blocked_senders: kind, case, the @ rules, uniqueness and the composite foreign key', async () => {
    expect(await insert('connection_blocked_senders', blocked())).toBeNull()
    expect(await insert('connection_blocked_senders', blocked({ id: id(51) }))).toMatch(/UNIQUE/)
    // same value, other kind is a different entry
    expect(
      await insert('connection_blocked_senders', blocked({ id: id(52), kind: 'address', value: 'a@spam.example' })),
    ).toBeNull()
    expect(await insert('connection_blocked_senders', blocked({ id: id(53), kind: 'host' }))).toMatch(/CHECK/)
    expect(await insert('connection_blocked_senders', blocked({ id: id(53), value: 'Spam.Example' }))).toMatch(/CHECK/)
    expect(
      await insert('connection_blocked_senders', blocked({ id: id(53), kind: 'address', value: 'nobody.example' })),
    ).toMatch(/CHECK/)
    expect(
      await insert('connection_blocked_senders', blocked({ id: id(53), kind: 'address', value: '@spam.example' })),
    ).toMatch(/CHECK/)
    expect(
      await insert('connection_blocked_senders', blocked({ id: id(53), kind: 'domain', value: 'a@spam.example' })),
    ).toMatch(/CHECK/)
    expect(await insert('connection_blocked_senders', blocked({ id: id(53), value: '' }))).toMatch(/CHECK/)
    expect(
      await insert('connection_blocked_senders', blocked({ id: id(53), value: 'b.example', connection_id: id(99) })),
    ).toMatch(/FOREIGN KEY/)
  })

  it('blocked_senders: the same shape checks, one live (organisation, kind, value), a soft-deleted twin accepted', async () => {
    expect(await insert('blocked_senders', workspace())).toBeNull()
    expect(await insert('blocked_senders', workspace({ id: id(61) }))).toMatch(/UNIQUE/)
    expect(await insert('blocked_senders', workspace({ id: id(62), deleted_at: AT }))).toBeNull()
    expect(await insert('blocked_senders', workspace({ id: id(63), deleted_at: AT }))).toBeNull()
    // once the live one is soft-deleted, a new live one may exist
    await d1.prepare('update blocked_senders set deleted_at = ? where id = ?').bind(AT, id(60)).run()
    expect(await insert('blocked_senders', workspace({ id: id(64) }))).toBeNull()
    expect(await insert('blocked_senders', workspace({ id: id(65), kind: 'host', value: 'x.example' }))).toMatch(
      /CHECK/,
    )
    expect(await insert('blocked_senders', workspace({ id: id(65), value: 'UPPER.example' }))).toMatch(/CHECK/)
    expect(await insert('blocked_senders', workspace({ id: id(65), kind: 'address', value: 'noat' }))).toMatch(/CHECK/)
    expect(await insert('blocked_senders', workspace({ id: id(65), kind: 'domain', value: 'a@b.example' }))).toMatch(
      /CHECK/,
    )
    expect(await insert('blocked_senders', workspace({ id: id(65), created_by: id(97), value: 'z.example' }))).toMatch(
      /FOREIGN KEY/,
    )
  })
})
