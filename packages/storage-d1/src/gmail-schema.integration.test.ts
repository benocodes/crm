import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CHN140 D22, D27, D30, D41: migration 0010 applied over a database at 0009 that already holds data, the five new tables and the two
// rebuilt source tables. The raw inserts are the permitted exception (the schema test proves what the database refuses, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-05T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const IDENT = id(10)
const CONN = id(11)
const THREAD = id(20)
const MSG = id(21)

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
  return d1.batch([d1.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row))]).then(() => null, (e: Error) => e.message)
}
const run = (sqlText: string, ...binds: unknown[]) => d1.prepare(sqlText).bind(...binds).run().then(() => null, (e: Error) => e.message)
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as T[]
const count = async (table: string) => ((await d1.prepare(`select count(*) as n from "${table}"`).first()) as { n: number }).n
const base = { organization_id: ORG, created_by: USER, created_at: AT }
const conn = (over: Record<string, unknown> = {}) => ({
  id: CONN, ...base, updated_at: AT, provider: 'google', account_id: 'sub-1', identity_id: IDENT, owner_id: USER, status: 'active', granted_scopes: '["openid"]', connected_at: AT, ...over,
})
const msgSource = (over: Record<string, unknown> = {}) => ({ id: id(30), ...base, message_id: MSG, connection_id: CONN, provider_message_id: 'gm-1', provider_thread_id: 'gt-1', ...over })
const thrSource = (over: Record<string, unknown> = {}) => ({ id: id(31), ...base, thread_id: THREAD, connection_id: CONN, provider_thread_id: 'gt-1', ...over })

const NEW_TABLES = ['channel_connections', 'channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors']

describe('migration 0010_gmail_capture over a database at 0009 with data', () => {
  it('applies, keeps the rows of the other tables, creates the five tables and rebuilds the source tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0010')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0009_deals.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    expect(await insert('identities', { id: IDENT, ...base, updated_at: AT, kind: 'email', value: 'ann@example.test', contact_id: null, own: 1 })).toBeNull()
    expect(await insert('companies', { id: id(40), name: 'Acme', ...base, updated_at: AT })).toBeNull()
    expect(await insert('threads', { id: THREAD, ...base, channel: 'email', subject: 's' })).toBeNull()
    expect(await insert('messages', { id: MSG, ...base, thread_id: THREAD, channel: 'email', kind: 'message', external_id: 'm@x', in_reply_to: null, author: '{"user_id":"u"}', occurred_at: AT, preview: 'p', content_key: 'orgs/x/', version: 1, retracted_at: null })).toBeNull()
    const snapshot = async () => ({
      identities: await all('select * from identities'),
      companies: await all('select * from companies'),
      threads: await all('select * from threads'),
      messages: await all('select * from messages'),
      events: await all('select * from events'),
    })
    const before = await snapshot()
    expect(before.identities).toHaveLength(1)
    for (const t of NEW_TABLES) expect(await all('select name from sqlite_master where name = ?', t), t).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig10-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0010'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0010_gmail_capture.sql'])
    expect(await snapshot()).toEqual(before)
    for (const t of NEW_TABLES) expect(await all('select name from sqlite_master where name = ?', t), t).toEqual([{ name: t }])
    for (const t of NEW_TABLES) expect(await count(t), `${t} starts empty`).toBe(0)
  })

  it('the rebuilt source tables refuse a row whose connection_id names no connection, on both tables', async () => {
    const before = [await count('message_sources'), await count('thread_sources')]
    expect(await insert('message_sources', msgSource({ connection_id: id(99) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('thread_sources', thrSource({ connection_id: id(99) }))).toMatch(/FOREIGN KEY/)
    expect([await count('message_sources'), await count('thread_sources')]).toEqual(before)
  })

  it('accepts sources of a real connection; UPDATE is still refused (append_only), a connection with sources cannot be deleted', async () => {
    expect(await insert('channel_connections', conn())).toBeNull()
    expect(await insert('message_sources', msgSource())).toBeNull()
    expect(await insert('thread_sources', thrSource())).toBeNull()
    expect(await run('UPDATE message_sources SET provider_message_id = ? WHERE id = ?', 'x', id(30))).toContain('append_only')
    expect(await run('UPDATE thread_sources SET provider_thread_id = ? WHERE id = ?', 'x', id(31))).toContain('append_only')
    expect((await all<{ provider_message_id: string }>('select provider_message_id from message_sources'))[0]!.provider_message_id).toBe('gm-1')
    expect(await run('DELETE FROM channel_connections WHERE id = ?', CONN)).toMatch(/FOREIGN KEY/)
  })

  it('re-creates the source tables\' indexes: the unique provider id per connection and the message/thread lookups', async () => {
    const idx = async (t: string) => (await all<{ name: string; unique: number }>(`select name, "unique" from pragma_index_list('${t}') where name like 'idx_%'`)).map((r) => `${r.name}:${r.unique}`).sort()
    expect(await idx('message_sources')).toEqual(['idx_message_sources_message:0', 'idx_message_sources_provider_unique:1'])
    expect(await idx('thread_sources')).toEqual(['idx_thread_sources_provider_unique:1', 'idx_thread_sources_thread:0'])
    expect(await insert('message_sources', msgSource({ id: id(32) }))).toMatch(/UNIQUE/)
    expect(await insert('thread_sources', thrSource({ id: id(33) }))).toMatch(/UNIQUE/)
  })

  it('re-creates the append-only triggers on both source tables, under the names 0004 gave them', async () => {
    const trg = await all<{ name: string; tbl_name: string }>("select name, tbl_name from sqlite_master where type = 'trigger' and tbl_name in ('message_sources', 'thread_sources')")
    expect(trg.map((t) => t.name).sort()).toEqual(['message_sources_append_only', 'thread_sources_append_only'])
  })

  it('constrains the connection: provider google, status, scopes a JSON array, unique live account, composite identity key', async () => {
    expect(await insert('channel_connections', conn({ id: id(12), provider: 'microsoft' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: 'sub-2', status: 'paused' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: 'sub-2', granted_scopes: '{"a":1}' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: 'sub-2', granted_scopes: 'nope' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: '' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: 'x', account_id: 'sub-2' }))).toMatch(/CHECK/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: 'sub-2', identity_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('channel_connections', conn({ id: id(12), account_id: 'sub-2', owner_id: id(97) }))).toMatch(/FOREIGN KEY/)
    // The same Google account twice among live rows is refused; once soft-deleted it is free again (D56).
    expect(await insert('channel_connections', conn({ id: id(12) }))).toMatch(/UNIQUE/)
    expect(await run('UPDATE channel_connections SET deleted_at = ? WHERE id = ?', AT, CONN)).toBeNull()
    expect(await insert('channel_connections', conn({ id: id(12) }))).toBeNull()
  })

  it('the machinery tables hang on the connection by the composite key, hold no secret in clear and need no deleted_at', async () => {
    const fks = async (t: string) => (await all<{ from: string; table: string; seq: number; id: number }>(`select * from pragma_foreign_key_list('${t}') order by id, seq`)).filter((f) => f.table === 'channel_connections').map((f) => f.from).sort()
    for (const t of ['channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors']) expect(await fks(t), t).toEqual(['connection_id', 'organization_id'])
    expect(await insert('channel_credentials', { id: id(50), ...base, connection_id: id(98), refresh_token_ciphertext: 'abc', key_version: 1 })).toMatch(/FOREIGN KEY/)
    expect(await insert('channel_credentials', { id: id(50), ...base, connection_id: id(12), refresh_token_ciphertext: '', key_version: 1 })).toMatch(/CHECK/)
    expect(await insert('channel_credentials', { id: id(50), ...base, connection_id: id(12), refresh_token_ciphertext: 'abc', key_version: 0 })).toMatch(/CHECK/)
    expect(await insert('channel_credentials', { id: id(50), ...base, connection_id: id(12), refresh_token_ciphertext: 'abc', key_version: 1 })).toBeNull()
    expect(await insert('gmail_watches', { connection_id: id(12), ...base, mailbox: 'Ann@Example.test', expires_at: AT })).toMatch(/CHECK/)
    expect(await insert('gmail_watches', { connection_id: id(12), ...base, mailbox: 'ann@example.test', expires_at: AT })).toBeNull()
    expect(await insert('mail_sync_state', { connection_id: id(12), ...base })).toBeNull()
    expect(await insert('mail_sync_cursors', { connection_id: id(12), ...base, history_id: '' })).toMatch(/CHECK/)
    expect(await insert('mail_sync_cursors', { connection_id: id(12), ...base, history_id: '555' })).toBeNull()
    expect(await insert('mail_sync_cursors', { connection_id: id(12), ...base, history_id: '556' })).toMatch(/UNIQUE|PRIMARY/)
    const idx = async (t: string) => (await all<{ name: string }>(`select name from pragma_index_list('${t}') where name like 'idx_%'`)).map((r) => r.name).sort()
    expect(await idx('channel_credentials')).toEqual(['idx_channel_credentials_connection'])
    expect(await idx('gmail_watches')).toEqual(['idx_gmail_watches_mailbox'])
  })
})
