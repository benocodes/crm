import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CHN421]] D10, D11, D19 (cycle 1): migration 0024 rebuilds threads, messages, interactions and the two source tables over a
// database at 0023 holding data, then the channel and source-key constraints. Raw inserts are the permitted exception: the
// schema test proves what the database refuses, which no operation reaches.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-17T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const CONTACT = id(11)
const IDENT = id(12)
const OWN = id(10)
const CONN = id(14)
const THREAD = id(15)
const MSG = id(16)
const INTER = id(17)
const PART = id(18)
const FILE = id(19)
const ATT = id(20)
const MSRC = id(21)
const TSRC = id(22)
const REQ = id(23)
const FORM = id(30)
const FORM2 = id(31)

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
const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return run(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(row),
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
const dump = async () => {
  const out: Record<string, unknown[]> = {}
  for (const t of [
    'threads',
    'messages',
    'interactions',
    'interaction_participants',
    'message_attachments',
    'action_requests',
  ])
    out[t] = await all(`select * from ${t} order by id`)
  return out
}
const schema = async () =>
  all<{ type: string; name: string; tbl_name: string; sql: string }>(
    `select type, name, tbl_name, sql from sqlite_master
     where tbl_name in ('threads','messages','interactions','message_sources','thread_sources') and type in ('index','trigger')
     order by name`,
  )
const msg = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  ...base,
  thread_id: THREAD,
  channel: 'email',
  kind: 'message',
  external_id: `m${n}@y`,
  in_reply_to: null,
  author: '{"user_id":"u"}',
  occurred_at: AT,
  preview: 'hi',
  content_key: 'orgs/x/',
  version: 1,
  retracted_at: null,
  ...over,
})

describe('migration 0024_form_channel over a database at 0023 holding data', () => {
  let before: Record<string, unknown[]>
  let schemaBefore: Awaited<ReturnType<typeof schema>>
  it('keeps every row and column, the foreign keys, and every index and trigger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0024')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0023_forms.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    const ident = (n: number, over: Record<string, unknown>) => ({
      id: id(n),
      ...base,
      updated_at: AT,
      kind: 'email',
      value: `a${n}@example.test`,
      ...over,
    })
    expect(await insert('contacts', { id: CONTACT, ...base, updated_at: AT, name: 'Ann' })).toBeNull()
    expect(await insert('identities', ident(10, { value: 'me@example.test', contact_id: null, own: 1 }))).toBeNull()
    expect(await insert('identities', ident(12, { contact_id: CONTACT, own: 0 }))).toBeNull()
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
    expect(await insert('messages', msg(16))).toBeNull()
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
        identity_id: IDENT,
        role: 'from',
      }),
    ).toBeNull()
    expect(
      await insert('files', {
        id: FILE,
        ...base,
        name: 'a.png',
        mime_type: 'image/png',
        size_bytes: 3,
        sha256: 'a'.repeat(64),
        storage_key: 'k',
      }),
    ).toBeNull()
    expect(
      await insert('message_attachments', {
        id: ATT,
        ...base,
        message_id: MSG,
        position: 0,
        file_id: FILE,
        type: 'image',
        name: 'a.png',
        mime_type: 'image/png',
        size_bytes: 3,
        inline: 0,
        content_id: null,
        fetch_status: 'stored',
        fetch_metadata: null,
        fetch_error: null,
      }),
    ).toBeNull()
    expect(
      await insert('message_sources', {
        id: MSRC,
        ...base,
        message_id: MSG,
        connection_id: CONN,
        provider_message_id: 'pm1',
        provider_thread_id: 'pt1',
      }),
    ).toBeNull()
    expect(
      await insert('thread_sources', {
        id: TSRC,
        ...base,
        thread_id: THREAD,
        connection_id: CONN,
        provider_thread_id: 'pt1',
      }),
    ).toBeNull()
    expect(
      await insert('action_requests', {
        id: REQ,
        ...base,
        updated_at: AT,
        operation: 'tasks.update',
        arguments: '{"id":"x"}',
        status: 'pending',
        reason: 'r',
        evidence: '[]',
        thread_id: THREAD,
        interaction_id: INTER,
        expires_at: '2026-11-18T09:00:00.000Z',
      }),
    ).toBeNull()
    before = await dump()
    expect(before.messages).toHaveLength(1)
    const sources = [await all('select * from message_sources'), await all('select * from thread_sources')]
    schemaBefore = await schema()

    const only = mkdtempSync(join(tmpdir(), 'mig24-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0024')))
      cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0024_form_channel.sql'])

    expect(await dump()).toEqual(before)
    // the source rows keep every old column; form_id is the new one, null
    expect(await all('select * from message_sources')).toEqual(
      sources[0]!.map((r) => ({ ...(r as object), form_id: null })),
    )
    expect(await all('select * from thread_sources')).toEqual(
      sources[1]!.map((r) => ({ ...(r as object), form_id: null })),
    )
    expect(await all('PRAGMA foreign_key_check')).toEqual([])

    // every index and trigger is still there; the only difference is the new form-keyed unique indexes
    const after = await schema()
    const names = (rows: typeof after) => rows.map((r) => r.name)
    expect(names(after).filter((n) => !names(schemaBefore).includes(n))).toEqual([
      'idx_message_sources_form_unique',
      'idx_thread_sources_form_unique',
    ])
    expect(names(schemaBefore).filter((n) => !names(after).includes(n))).toEqual([])
    for (const row of schemaBefore.filter((r) => r.type === 'trigger')) {
      expect(after.find((a) => a.name === row.name)?.sql).toBe(row.sql)
    }
  })

  it('each append-only trigger still refuses an UPDATE', async () => {
    for (const [table, col, val] of [
      ['threads', 'subject', 'x'],
      ['messages', 'preview', 'x'],
      ['interactions', 'direction', 'outbound'],
      ['message_sources', 'provider_message_id', 'x'],
      ['thread_sources', 'provider_thread_id', 'x'],
    ] as const) {
      expect(await run(`update ${table} set ${col} = ? where organization_id = ?`, val, ORG)).toMatch(/append_only/)
    }
  })

  it('existing parent foreign keys still bind (a message needs its thread, a request its interaction)', async () => {
    expect(await insert('messages', msg(40, { thread_id: id(99) }))).toMatch(/FOREIGN KEY|constraint/i)
  })
})

describe('constraints after 0024', () => {
  const agent = async (agentId: string) => {
    await seedPrincipal(d1, { id: agentId, kind: 'agent' })
    expect(
      await insert('agents', {
        id: agentId,
        created_at: AT,
        updated_at: AT,
        organization_id: ORG,
        name: 'form agent',
        scopes: '[]',
        created_by: USER,
      }),
    ).toBeNull()
    expect(
      await insert('forms', {
        id: agentId,
        created_at: AT,
        updated_at: AT,
        organization_id: ORG,
        created_by: USER,
        name: `Form ${agentId}`,
        public_id: `frm_${agentId === FORM ? 'a' : 'b'}${'0'.repeat(25)}`,
        enabled: 1,
        email_field: 'email',
        phone_field: null,
        name_field: null,
        consent_text: null,
      }),
    ).toBeNull()
  }
  const t = (n: number, channel: string) => ({ id: id(n), ...base, channel, subject: null })
  const i = (n: number, channel: string, threadId: string, messageId: string) => ({
    id: id(n),
    ...base,
    kind: 'message',
    channel,
    direction: 'inbound',
    occurred_at: AT,
    thread_id: threadId,
    message_id: messageId,
  })

  it("channel 'form' is accepted on threads, messages and interactions; an unknown channel is refused", async () => {
    await agent(FORM)
    await agent(FORM2)
    expect(await insert('threads', t(50, 'form'))).toBeNull()
    expect(await insert('threads', t(51, 'sms'))).toMatch(/threads_channel/)
    expect(await insert('messages', msg(52, { thread_id: id(50), channel: 'form' }))).toBeNull()
    expect(await insert('messages', msg(53, { thread_id: id(50), channel: 'sms' }))).toMatch(/messages_channel/)
    expect(await insert('interactions', i(54, 'form', id(50), id(52)))).toBeNull()
    expect(await insert('interactions', i(55, 'sms', id(50), id(52)))).toMatch(/interactions_channel/)
  })

  it.each([
    [
      'message_sources',
      'message_sources_one_source',
      (n: number, over: Record<string, unknown>) => ({
        id: id(n),
        ...base,
        message_id: id(52),
        connection_id: null,
        form_id: null,
        provider_message_id: `p${n}`,
        provider_thread_id: 'pt',
        ...over,
      }),
      'provider_message_id',
      'provider_thread_id',
    ],
    [
      'thread_sources',
      'thread_sources_one_source',
      (n: number, over: Record<string, unknown>) => ({
        id: id(n),
        ...base,
        thread_id: id(50),
        connection_id: null,
        form_id: null,
        provider_thread_id: `p${n}`,
        ...over,
      }),
      'provider_thread_id',
      null,
    ],
  ] as const)('%s: exactly one source, FK on form, form-keyed uniqueness', async (table, check, row, col, col2) => {
    const dup = { [col]: 'dup', ...(col2 ? { [col2]: 'dup' } : {}) }
    const k = table === 'message_sources' ? 60 : 70
    expect(await insert(table, row(k, {}))).toMatch(new RegExp(check))
    expect(await insert(table, row(k + 1, { connection_id: CONN, form_id: FORM }))).toMatch(new RegExp(check))
    expect(await insert(table, row(k + 2, { form_id: id(98) }))).toMatch(/FOREIGN KEY|constraint/i)
    expect(await insert(table, row(k + 3, { form_id: FORM, ...dup }))).toBeNull()
    expect(await insert(table, row(k + 4, { form_id: FORM, ...dup }))).toMatch(/UNIQUE/)
    // the same provider id under another form, and under a connection, is accepted
    expect(await insert(table, row(k + 5, { form_id: FORM2, ...dup }))).toBeNull()
    expect(await insert(table, row(k + 6, { connection_id: CONN, ...dup }))).toBeNull()
  })
})
