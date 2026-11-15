import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { applyControlMigrations, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE327]] group 1 (P1, [[CORE259]] D8, D13): control 0004 creates the four webhook tables with 0016/0017's columns, checks, unique keys, lease check and the UPDATE-refusing trigger on
// `webhook_secrets`; no foreign key names a CRM table; the in-control foreign keys hold; the CRM schema is unchanged. The raw inserts are the permitted exception (what the database refuses).
const TABLES = ['webhook_subscriptions', 'webhook_secrets', 'webhook_dispatch_state', 'webhook_deliveries'] as const
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-15T09:00:00.000Z'
let n = 0
const id = () => `0190b2c4-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`

let local: LocalD1
let control: D1Like
let crm: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL', 'CRM'], { migrate: false })
  control = local.bindings.CONTROL!
  crm = local.bindings.CRM!
  await applyControlMigrations(control)
  await applyMigrations(crm)
})
afterAll(() => local.dispose())

const all = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const run = (text: string, ...binds: unknown[]) =>
  control
    .prepare(text)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )
const insert = (table: string, row: Record<string, unknown>) =>
  run(
    `insert into ${table} (${Object.keys(row).join(', ')}) values (${Object.keys(row)
      .map(() => '?')
      .join(', ')})`,
    ...Object.values(row),
  )
const subRow = (over: Record<string, unknown> = {}) => ({
  id: id(),
  created_at: AT,
  updated_at: AT,
  organization_id: ORG,
  created_by: ACTOR,
  agent_id: AGENT,
  url: 'https://hooks.example.com/in',
  event_types: '["interaction.created"]',
  status: 'active',
  deleted_at: null,
  ...over,
})
const delivery = (subscriptionId: string, over: Record<string, unknown> = {}) => ({
  id: id(),
  created_at: AT,
  organization_id: ORG,
  created_by: ACTOR,
  subscription_id: subscriptionId,
  event_id: id(),
  event_type: 'interaction.created',
  status: 'pending',
  attempts: 0,
  next_attempt_at: AT,
  ...over,
})
const seedSub = async () => {
  const row = subRow()
  expect(await insert('webhook_subscriptions', row)).toBeNull()
  return row.id
}

describe('control 0004: the four webhook tables', () => {
  it('creates them in the control database, with the columns, types and nullability of CRM 0016/0017', async () => {
    for (const t of TABLES) {
      const info = (d1: D1Like) =>
        all(d1, `select name, type, "notnull", dflt_value, pk from pragma_table_info('${t}') order by cid`)
      const mine = await info(control)
      expect(mine.length, t).toBeGreaterThan(0)
      expect(mine, t).toEqual(await info(crm))
    }
  })

  it('keeps the indexes (and their partial predicates) and the unique keys of the CRM tables', async () => {
    for (const t of TABLES) {
      const idx = (d1: D1Like) =>
        all(
          d1,
          `select name, "unique", partial from pragma_index_list('${t}') where origin <> 'pk' and name not like 'sqlite_autoindex%' order by name`,
        )
      expect(await idx(control), t).toEqual(await idx(crm))
      const uniq = (d1: D1Like) =>
        all(
          d1,
          `select (select group_concat(name) from pragma_index_info(l.name)) as cols from pragma_index_list('${t}') l where l."unique" = 1 and l.origin = 'u' order by cols`,
        )
      expect(await uniq(control), t).toEqual(await uniq(crm))
    }
  })

  it('has no foreign key into a CRM table; the only foreign keys are the three into webhook_subscriptions', async () => {
    const fks: Record<string, string[]> = {}
    for (const t of TABLES)
      fks[t] = (await all(control, `select "table" as ref from pragma_foreign_key_list('${t}')`)).map((r) => r.ref)
    expect(fks).toEqual({
      webhook_subscriptions: [],
      webhook_secrets: ['webhook_subscriptions', 'webhook_subscriptions'],
      webhook_dispatch_state: ['webhook_subscriptions', 'webhook_subscriptions'],
      webhook_deliveries: ['webhook_subscriptions', 'webhook_subscriptions'],
    })
    for (const crmTable of ['organizations', 'principals', 'agents'])
      expect(fks.webhook_subscriptions).not.toContain(crmTable)
  })

  it('a secret, a dispatch state or a delivery for a missing subscription is refused', async () => {
    const ghost = id()
    expect(
      await insert('webhook_secrets', {
        id: id(),
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        subscription_id: ghost,
        sealed: 's',
        key_version: 1,
      }),
    ).toMatch(/FOREIGN KEY/i)
    expect(
      await insert('webhook_dispatch_state', {
        subscription_id: ghost,
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        cursor_event_id: id(),
      }),
    ).toMatch(/FOREIGN KEY/i)
    expect(await insert('webhook_deliveries', delivery(ghost))).toMatch(/FOREIGN KEY/i)
    const sub = await seedSub()
    expect(
      await insert('webhook_secrets', {
        id: id(),
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        subscription_id: sub,
        sealed: 's',
        key_version: 1,
      }),
    ).toBeNull()
    expect(await insert('webhook_deliveries', delivery(sub))).toBeNull()
  })

  it('a CRM organisation, principal or agent need not exist: the owner columns are values with a format check', async () => {
    expect(await insert('webhook_subscriptions', subRow())).toBeNull()
    for (const column of ['organization_id', 'created_by', 'agent_id'])
      expect(await insert('webhook_subscriptions', subRow({ [column]: 'not-a-uuid' })), column).toMatch(/CHECK/i)
  })

  it('refuses what 0016 refuses: status, event_types, url, ids and timestamps', async () => {
    expect(await insert('webhook_subscriptions', subRow({ status: 'bogus' }))).toMatch(
      /webhook_subscriptions_status|CHECK/i,
    )
    expect(await insert('webhook_subscriptions', subRow({ event_types: '[]' }))).toMatch(
      /webhook_subscriptions_event_types|CHECK/i,
    )
    expect(await insert('webhook_subscriptions', subRow({ event_types: '{}' }))).toMatch(/CHECK/i)
    expect(
      await insert(
        'webhook_subscriptions',
        subRow({ event_types: JSON.stringify(Array.from({ length: 21 }, (_, i) => `a.b${i}`)) }),
      ),
    ).toMatch(/CHECK/i)
    expect(await insert('webhook_subscriptions', subRow({ url: '' }))).toMatch(/webhook_subscriptions_url|CHECK/i)
    expect(await insert('webhook_subscriptions', subRow({ url: `https://x.test/${'a'.repeat(2048)}` }))).toMatch(
      /CHECK/i,
    )
    expect(await insert('webhook_subscriptions', subRow({ id: 'XYZ' }))).toMatch(/CHECK/i)
    expect(await insert('webhook_subscriptions', subRow({ created_at: 'yesterday' }))).toMatch(/CHECK/i)
    expect(await insert('webhook_subscriptions', subRow({ deleted_at: 'yesterday' }))).toMatch(/CHECK/i)
    const dup = subRow()
    expect(await insert('webhook_subscriptions', dup)).toBeNull()
    expect(await insert('webhook_subscriptions', dup)).toMatch(/UNIQUE|PRIMARY/i)
    const sub = await seedSub()
    expect(await insert('webhook_deliveries', delivery(sub, { status: 'bogus' }))).toMatch(
      /webhook_deliveries_status|CHECK/i,
    )
    expect(await insert('webhook_deliveries', delivery(sub, { attempts: -1 }))).toMatch(/CHECK/i)
    expect(
      await insert('webhook_secrets', {
        id: id(),
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        subscription_id: sub,
        sealed: '',
        key_version: 1,
      }),
    ).toMatch(/CHECK/i)
    expect(
      await insert('webhook_secrets', {
        id: id(),
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        subscription_id: sub,
        sealed: 's',
        key_version: 0,
      }),
    ).toMatch(/CHECK/i)
    expect(
      await insert('webhook_dispatch_state', {
        subscription_id: sub,
        created_at: AT,
        organization_id: ORG,
        created_by: ACTOR,
        cursor_event_id: 'nope',
      }),
    ).toMatch(/CHECK/i)
  })

  it('a delivery for an (subscription, event) pair already present is refused by the unique key; the lease columns are both or neither, on a pending row only', async () => {
    const sub = await seedSub()
    const d = delivery(sub)
    expect(await insert('webhook_deliveries', d)).toBeNull()
    expect(await insert('webhook_deliveries', delivery(sub, { event_id: d.event_id }))).toMatch(/UNIQUE/i)
    expect(await insert('webhook_deliveries', delivery(sub, { lease_until: AT }))).toMatch(
      /webhook_deliveries_lease|CHECK/i,
    )
    expect(await insert('webhook_deliveries', delivery(sub, { lease_token: 't' }))).toMatch(
      /webhook_deliveries_lease|CHECK/i,
    )
    expect(
      await insert('webhook_deliveries', delivery(sub, { lease_until: AT, lease_token: 't', status: 'delivered' })),
    ).toMatch(/webhook_deliveries_lease|CHECK/i)
    expect(await insert('webhook_deliveries', delivery(sub, { lease_until: AT, lease_token: 't' }))).toBeNull()
  })

  it('webhook_secrets refuses an UPDATE (append-only) and is the only table with a trigger of this set', async () => {
    const sub = await seedSub()
    const secret = {
      id: id(),
      created_at: AT,
      organization_id: ORG,
      created_by: ACTOR,
      subscription_id: sub,
      sealed: 's',
      key_version: 1,
    }
    expect(await insert('webhook_secrets', secret)).toBeNull()
    expect(await run("update webhook_secrets set sealed = 'x' where id = ?", secret.id)).toMatch(/append_only/)
    const triggers = (
      await all(control, "select name, tbl_name from sqlite_master where type = 'trigger' order by name")
    ).map((r) => `${r.tbl_name}:${r.name}`)
    expect(triggers).toEqual([
      'control_audit:control_audit_no_delete',
      'control_audit:control_audit_no_update',
      'webhook_secrets:webhook_secrets_append_only',
    ])
  })

  it('the CRM schema is unchanged: its migration list still ends at 0019 and still holds the four tables', async () => {
    expect(MIGRATIONS.at(-1)?.name).toBe('0019_drop_auth_tables.sql')
    const names = (await all(crm, "select name from sqlite_master where type = 'table'")).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining([...TABLES]))
  })
})
