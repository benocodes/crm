import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE679]] D4: a keyed id column lost its CHECK because a foreign key refuses the same values; the canonical id and
// timestamp CHECKs refuse what the short and unnamed forms let through. Raw inserts are the permitted exception: this proves what
// the database refuses, which no operation reaches. One parent row per keyed table is seeded so a composite key onto
// (organization_id, id) with no unique index ("foreign key mismatch", raised at write time) would show here.
const uid = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const ORG = uid(1)
const USER = uid(2)
const AGENT = uid(3)
const AT = '2026-11-27T09:00:00.000Z'
const WELL_FORMED_STRANGER = uid(999_999)
const MALFORMED = 'not-a-uuid'

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['REF'])
  d1 = local.bindings.REF!
  await seedDeployment(d1, { organizationId: ORG })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})
afterAll(() => local.dispose())

const run = (sqlText: string, ...binds: unknown[]) =>
  d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
    () => null,
    (e: Error) => e.message,
  )
const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(row),
  )
}
const must = async (table: string, row: Record<string, unknown>) => expect(await insert(table, row), table).toBeNull()

// parents, one of each keyed table
const COMPANY = uid(10)
const CONTACT = uid(11)
const FILE = uid(12)
const THREAD = uid(13)
const MESSAGE = uid(14)
const IDENTITY = uid(15)
const CONNECTION = uid(16)
const INTERACTION = uid(17)
const CONTACT2 = uid(18)
const COMPANY2 = uid(19)
const base = { organization_id: ORG, created_by: USER, created_at: AT }
beforeAll(async () => {
  await must('companies', { id: COMPANY, ...base, updated_at: AT, name: 'Acme' })
  await must('contacts', { id: CONTACT, ...base, updated_at: AT })
  await must('contacts', { id: CONTACT2, ...base, updated_at: AT })
  await must('companies', { id: COMPANY2, ...base, updated_at: AT, name: 'Beta' })
  await must('files', {
    id: FILE,
    ...base,
    name: 'f',
    mime_type: 'text/plain',
    size_bytes: 1,
    sha256: 'a'.repeat(64),
    storage_key: 'k',
  })
  await must('threads', { id: THREAD, ...base, channel: 'email' })
  await must('messages', {
    id: MESSAGE,
    ...base,
    thread_id: THREAD,
    channel: 'email',
    kind: 'message',
    external_id: 'm1',
    author: '{}',
    occurred_at: AT,
    preview: '',
    content_key: 'c',
    version: 1,
  })
  await must('identities', { id: IDENTITY, ...base, updated_at: AT, kind: 'email', value: 'a@b.test' })
  await must('connections', {
    id: CONNECTION,
    ...base,
    updated_at: AT,
    provider: 'google',
    account_id: 'acct',
    identity_id: IDENTITY,
    owner_id: USER,
    status: 'active',
    granted_scopes: '[]',
    connected_at: AT,
  })
  await must('interactions', {
    id: INTERACTION,
    ...base,
    kind: 'message',
    channel: 'email',
    direction: 'inbound',
    occurred_at: AT,
    thread_id: THREAD,
    message_id: MESSAGE,
  })
  await seedPrincipal(d1, { id: AGENT, kind: 'agent' })
})

let n = 100
type KeyedCase = { table: string; column: string; row: (value: string) => Record<string, unknown>; valid: string }
const fresh = () => uid(n++)
const keyed: KeyedCase[] = [
  { table: 'agents', column: 'id', valid: AGENT, row: (v) => ({ id: v, ...base, updated_at: AT, name: 'a' }) },
  {
    table: 'forms',
    column: 'id',
    valid: '',
    row: (v) => ({
      id: v,
      ...base,
      updated_at: AT,
      name: `f${n++}`,
      public_id: `frm_${String(n++).padStart(26, '0')}`,
      email_field: 'email',
    }),
  },
  {
    table: 'contact_files',
    column: 'contact_id',
    valid: CONTACT,
    row: (v) => ({ id: fresh(), ...base, updated_at: AT, contact_id: v, file_id: FILE }),
  },
  {
    table: 'contact_files',
    column: 'file_id',
    valid: FILE,
    row: (v) => ({ id: fresh(), ...base, updated_at: AT, contact_id: CONTACT2, file_id: v }),
  },
  {
    table: 'company_files',
    column: 'company_id',
    valid: COMPANY,
    row: (v) => ({ id: fresh(), ...base, updated_at: AT, company_id: v, file_id: FILE }),
  },
  {
    table: 'company_files',
    column: 'file_id',
    valid: FILE,
    row: (v) => ({ id: fresh(), ...base, updated_at: AT, company_id: COMPANY2, file_id: v }),
  },
  {
    table: 'connection_watches',
    column: 'connection_id',
    valid: CONNECTION,
    row: (v) => ({ connection_id: v, ...base, address: 'a@b.test', expires_at: AT }),
  },
  { table: 'connection_sync_state', column: 'connection_id', valid: CONNECTION, row: (v) => ({ connection_id: v, ...base }) },
  {
    table: 'connection_sync_cursors',
    column: 'connection_id',
    valid: CONNECTION,
    row: (v) => ({ connection_id: v, ...base, cursor: '1' }),
  },
  {
    table: 'messages',
    column: 'thread_id',
    valid: THREAD,
    row: (v) => ({
      id: fresh(),
      ...base,
      thread_id: v,
      channel: 'email',
      kind: 'message',
      external_id: `m${n}`,
      author: '{}',
      occurred_at: AT,
      preview: '',
      content_key: 'c',
      version: 1,
    }),
  },
  {
    table: 'message_sources',
    column: 'message_id',
    valid: MESSAGE,
    row: (v) => ({
      id: fresh(),
      ...base,
      message_id: v,
      connection_id: CONNECTION,
      provider_message_id: `p${n++}`,
      provider_thread_id: 'q',
    }),
  },
  {
    table: 'thread_sources',
    column: 'thread_id',
    valid: THREAD,
    row: (v) => ({ id: fresh(), ...base, thread_id: v, connection_id: CONNECTION, provider_thread_id: `q${n++}` }),
  },
  {
    table: 'message_attachments',
    column: 'message_id',
    valid: MESSAGE,
    row: (v) => ({
      id: fresh(),
      ...base,
      message_id: v,
      position: n++,
      type: 'file',
      inline: 0,
      fetch_status: 'pending',
    }),
  },
  {
    table: 'message_attachments',
    column: 'file_id',
    valid: FILE,
    row: (v) => ({
      id: fresh(),
      ...base,
      message_id: MESSAGE,
      position: n++,
      file_id: v,
      type: 'file',
      inline: 0,
      fetch_status: 'stored',
    }),
  },
  {
    table: 'interaction_participants',
    column: 'interaction_id',
    valid: INTERACTION,
    row: (v) => ({ id: fresh(), ...base, interaction_id: v, identity_id: IDENTITY, role: 'from' }),
  },
  {
    table: 'interaction_participants',
    column: 'identity_id',
    valid: IDENTITY,
    row: (v) => ({ id: fresh(), ...base, interaction_id: INTERACTION, identity_id: v, role: 'to' }),
  },
]

describe('a keyed id column that lost its CHECK still refuses a value that is not a key of its target (D4)', () => {
  for (const c of keyed) {
    it(`${c.table}.${c.column}`, async () => {
      // forms.id is a key onto agents: its valid parent is an agents row made here.
      const valid = c.valid || fresh()
      if (!c.valid) {
        await seedPrincipal(d1, { id: valid, kind: 'agent' })
        await must('agents', { id: valid, ...base, updated_at: AT, name: 'form agent' })
      }
      // the parent for agents.id is a bare agent principal (seeded)
      expect(await insert(c.table, c.row(valid)), `${c.table}.${c.column} accepts a key`).toBeNull()
      // a second row with a malformed value and one with a well-formed stranger: both refused by the key
      for (const bad of [MALFORMED, WELL_FORMED_STRANGER]) {
        const message = await insert(c.table, c.row(bad))
        expect(message, `${c.table}.${c.column} = ${bad}`).toMatch(/FOREIGN KEY constraint failed/)
      }
    })
  }
})

describe('the canonical CHECKs refuse what a short-form CHECK would let through', () => {
  // 36 characters with the first dash one place early: a short form (length and alphabet only) would accept it.
  // Every CRM id CHECK was already the full form (decision 679.28); the short form lives in the control database.
  const DASH_MISPLACED = '0190b2c40-000-7000-8000-000000000001'
  it('an id with a dash out of place is refused by the named canonical CHECK', async () => {
    expect(DASH_MISPLACED).toHaveLength(36)
    expect(
      await run('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)', DASH_MISPLACED, 'user', AT),
    ).toMatch(/CHECK constraint failed: principals_id_uuid/)
    for (const [column, table] of [
      ['a_id', 'associations'],
      ['b_id', 'associations'],
    ] as const) {
      const row: Record<string, unknown> = {
        id: fresh(),
        ...base,
        updated_at: AT,
        a_type: 'contacts',
        b_type: 'deals',
        a_id: CONTACT,
        b_id: CONTACT,
        [column]: DASH_MISPLACED,
      }
      expect(await insert(table, row), `${table}.${column}`).toMatch(
        new RegExp(`CHECK constraint failed: ${table}_${column}_uuid`),
      )
    }
  })
  it('a polymorphic id (events.resource_id, no key possible) is refused when it is not a UUID', async () => {
    const message = await insert('events', {
      id: fresh(),
      created_at: AT,
      organization_id: ORG,
      type: 't',
      resource_type: 'contacts',
      resource_id: MALFORMED,
      actor_id: USER,
    })
    expect(message).toMatch(/CHECK constraint failed: events_resource_id_uuid/)
  })
  it('a timestamp column still refuses a value that is not the canonical ISO form', async () => {
    for (const bad of ['yesterday', '2026-11-27', '2026-11-27T09:00:00Z', '2026-11-27 09:00:00.000']) {
      const message = await insert('contacts', { id: fresh(), ...base, updated_at: AT, deleted_at: bad })
      expect(message, bad).toMatch(/CHECK constraint failed: contacts_deleted_at_timestamp/)
    }
    expect(await insert('contacts', { id: fresh(), ...base, updated_at: 'not a time' })).toMatch(
      /CHECK constraint failed: contacts_updated_at_timestamp/,
    )
  })
})
