import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// #451 (user ruling 451.1): `channel_connections` defaults in genesis (exclusions on, contact_creation 'sent'), with an explicit row kept as written and its children and
// foreign keys intact. Raw inserts are the permitted exception (the test proves what the database does, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-18T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const IDENT = id(10)
const OLD = id(11)
const NEW = id(12)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'])
  d1 = local.bindings.G!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
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

const connection = (cid: string, account: string, extra = '') =>
  run(
    `INSERT INTO channel_connections (id, created_at, updated_at, organization_id, created_by, provider, account_id, identity_id, owner_id, status, granted_scopes, connected_at${extra ? ', exclude_group_addresses, exclude_personal_domains, contact_creation' : ''})
     VALUES (?, ?, ?, ?, ?, 'google', ?, ?, ?, 'active', '["openid"]', ?${extra ? ", 0, 0, 'sent_and_received'" : ''})`,
    cid,
    AT,
    AT,
    ORG,
    USER,
    account,
    IDENT,
    USER,
    AT,
  )

describe('capture defaults on channel_connections', () => {
  it('keeps an explicit connection as written, and gives a new one the defaults (exclusions on, contact_creation sent)', async () => {
    await run(
      `INSERT INTO identities (id, organization_id, created_by, created_at, updated_at, kind, value, contact_id, own) VALUES (?, ?, ?, ?, ?, 'email', 'ann@example.test', NULL, 1)`,
      IDENT,
      ORG,
      USER,
      AT,
      AT,
    )
    await connection(OLD, 'sub-old', 'explicit')
    await run(
      `INSERT INTO connection_capture_labels (id, organization_id, connection_id, label_id, created_at) VALUES (?, ?, ?, 'INBOX', ?)`,
      id(40),
      ORG,
      OLD,
      AT,
    )

    expect(
      await all(
        'select id, exclude_group_addresses, exclude_personal_domains, contact_creation from channel_connections',
      ),
    ).toEqual([
      { id: OLD, exclude_group_addresses: 0, exclude_personal_domains: 0, contact_creation: 'sent_and_received' },
    ])
    expect(await all('select connection_id, label_id from connection_capture_labels')).toEqual([
      { connection_id: OLD, label_id: 'INBOX' },
    ])
    expect(
      await all(
        "select name from sqlite_master where tbl_name = 'channel_connections' and name not like 'sqlite_autoindex%' order by name",
      ),
    ).toEqual([
      { name: 'channel_connections' },
      { name: 'idx_channel_connections_live_account' },
      { name: 'idx_channel_connections_owner' },
    ])

    await connection(NEW, 'sub-new')
    expect(
      await all(
        'select exclude_group_addresses, exclude_personal_domains, contact_creation from channel_connections where id = ?',
        NEW,
      ),
    ).toEqual([{ exclude_group_addresses: 1, exclude_personal_domains: 1, contact_creation: 'sent' }])
    expect(await all('pragma foreign_key_check')).toEqual([])
  })
})
