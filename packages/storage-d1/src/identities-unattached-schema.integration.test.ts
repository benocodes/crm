import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
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
const CONN = id(14)
const THREAD = id(15)
const MSG = id(16)
const INTER = id(17)
const PART = id(18)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'])
  d1 = local.bindings.G!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
  expect(await insert('contacts', { id: CONTACT, ...base, updated_at: AT, name: 'Ann' })).toBeNull()
  expect(await insert('identities', ident(10, { value: 'me@example.test', contact_id: null, own: 1 }))).toBeNull()
  expect(await insert('identities', ident(12, { contact_id: CONTACT, own: 0 }))).toBeNull()
  expect(
    await insert('identities', ident(13, { value: 'gone@example.test', contact_id: CONTACT, own: 0, deleted_at: AT })),
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
const base = { organization_id: ORG, created_at: AT, created_by: USER }
const ident = (n: number, over: Record<string, unknown>) => ({
  id: id(n),
  ...base,
  updated_at: AT,
  kind: 'email',
  value: `a${n}@example.test`,
  ...over,
})

describe('unattached identities', () => {
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
