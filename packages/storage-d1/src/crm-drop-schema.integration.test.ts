import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { MIGRATIONS_DIR, applyControlMigrations, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE329]] (P1, [[CORE259]] D13 CRM half): the CRM drop of `api_keys` and the four webhook tables, proven by applying the REAL migration file over a database at the previous head that holds a row in every
// one of the five tables (a subscription with a child in each machinery table, and a key referencing an agent). The raw inserts are the permitted exception (schema test). The control tables are not touched.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-16T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const DROPPED = [
  'api_keys',
  'webhook_deliveries',
  'webhook_dispatch_state',
  'webhook_secrets',
  'webhook_subscriptions',
] as const

let local: LocalD1
let crm: D1Like
let control: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL', 'CRM'], { migrate: false })
  crm = local.bindings.CRM!
  control = local.bindings.CONTROL!
  await applyControlMigrations(control)
})
afterAll(async () => {
  await local.dispose()
})

const run = (db: D1Like, sqlText: string, ...binds: unknown[]) =>
  db
    .prepare(sqlText)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )
const all = async <T = Record<string, unknown>>(db: D1Like, sqlText: string, ...binds: unknown[]) =>
  ((
    await db
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const tablesOf = async (db: D1Like) =>
  (await all<{ name: string }>(db, "select name from sqlite_master where type = 'table' order by name")).map(
    (r) => r.name,
  )
const countsOf = async (db: D1Like, tables: string[]) =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (t) => [t, (await all<{ n: number }>(db, `select count(*) as n from "${t}"`))[0]!.n] as const),
    ),
  )

function dirUpTo(before: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig19-'))
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < before)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
  return dir
}
function dirOnly(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig20-'))
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(prefix)))
    cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
  return dir
}

async function seedFive(db: D1Like): Promise<void> {
  const rows: Array<[string, unknown[]]> = [
    [
      'insert into webhook_subscriptions (id, created_at, updated_at, organization_id, created_by, agent_id, url, event_types, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id(1), AT, AT, ORG, USER, AGENT, 'https://example.com/h', '["task.created"]', 'active'],
    ],
    [
      'insert into webhook_secrets (id, created_at, organization_id, created_by, subscription_id, sealed, key_version) values (?, ?, ?, ?, ?, ?, ?)',
      [id(2), AT, ORG, USER, id(1), 'AAAA', 1],
    ],
    [
      'insert into webhook_dispatch_state (subscription_id, created_at, organization_id, created_by, cursor_event_id) values (?, ?, ?, ?, ?)',
      [id(1), AT, ORG, USER, id(30)],
    ],
    [
      'insert into webhook_deliveries (id, created_at, organization_id, created_by, subscription_id, event_id, event_type, status, next_attempt_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id(3), AT, ORG, USER, id(1), id(31), 'task.created', 'pending', AT],
    ],
    [
      'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)',
      [id(4), AT, AT, ORG, AGENT, 'hash-1', 'vk_aaaaaaaa', USER],
    ],
    [
      'insert into events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) values (?, ?, ?, ?, ?, ?, ?)',
      [id(40), AT, ORG, 'api_key.created', 'api_key', id(4), USER],
    ],
    [
      'insert into events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) values (?, ?, ?, ?, ?, ?, ?)',
      [id(41), AT, ORG, 'webhook.created', 'webhook_subscription', id(1), USER],
    ],
  ]
  for (const [text, binds] of rows) expect(await run(db, text, ...binds), text).toBeNull()
}

describe('migration 0020 drops the CRM api_keys and webhook tables (CORE329 P1), over data', () => {
  it('is the next migration in the manifest', () => {
    expect(MIGRATIONS.map((m) => m.name).at(-1)).toBe('0020_drop_api_key_webhook_tables.sql')
  })

  it('a CRM database at 0019 with a row in every one of the five tables applies 0020: none is left, every other table keeps its rows (events included), the control database is unchanged', async () => {
    await applyMigrations(crm, dirUpTo('0020'))
    await seedDeployment(crm, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(crm, { id: USER, kind: 'user' })
    await seedAgent(crm, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
    await seedFive(crm)
    const before = await tablesOf(crm)
    for (const t of DROPPED) expect(before).toContain(t)
    const keep = before.filter((t) => !(DROPPED as readonly string[]).includes(t) && !t.startsWith('sqlite_') && !t.startsWith('_'))
    const rowsBefore = await countsOf(crm, keep)
    expect(rowsBefore.events).toBe(2)
    expect(rowsBefore.agents).toBe(1)
    const controlBefore = await tablesOf(control)
    const controlCounts = await countsOf(
      control,
      controlBefore.filter((t) => !t.startsWith('sqlite_') && !t.startsWith('_')),
    )

    expect(await applyMigrations(crm, dirOnly('0020'))).toEqual(['0020_drop_api_key_webhook_tables.sql'])

    const after = await tablesOf(crm)
    for (const t of DROPPED) expect(after, t).not.toContain(t)
    expect(await countsOf(crm, keep)).toEqual(rowsBefore)
    expect((await all(crm, "select type from events where type like 'api_key.%' or type like 'webhook.%'")).length).toBe(
      2,
    )
    expect(await tablesOf(control)).toEqual(controlBefore)
    expect(
      await countsOf(
        control,
        controlBefore.filter((t) => !t.startsWith('sqlite_') && !t.startsWith('_')),
      ),
    ).toEqual(controlCounts)
  })

  it('applies over a database at 0019 with the five tables empty, and over one with only the parent tables filled', async () => {
    for (const fill of [false, true]) {
      const db = (await openLocalD1(['CRM'], { migrate: false })).bindings.CRM!
      await applyMigrations(db, dirUpTo('0020'))
      if (fill) {
        await seedDeployment(db, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
        await seedPrincipal(db, { id: USER, kind: 'user' })
        await seedAgent(db, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
        await run(
          db,
          'insert into webhook_subscriptions (id, created_at, updated_at, organization_id, created_by, agent_id, url, event_types, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id(1),
          AT,
          AT,
          ORG,
          USER,
          AGENT,
          'https://example.com/h',
          '["task.created"]',
          'active',
        )
      }
      expect(await applyMigrations(db, dirOnly('0020'))).toEqual(['0020_drop_api_key_webhook_tables.sql'])
      const after = await tablesOf(db)
      for (const t of DROPPED) expect(after, t).not.toContain(t)
    }
  })

  it('the whole CRM directory leaves none of the five tables in a fresh database, and the control directory still has api_keys and the webhook tables', async () => {
    const fresh = (await openLocalD1(['CRM'], { migrate: false })).bindings.CRM!
    await applyMigrations(fresh)
    const names = await tablesOf(fresh)
    for (const t of DROPPED) expect(names, t).not.toContain(t)
    const ctl = await tablesOf(control)
    for (const t of DROPPED) expect(ctl, t).toContain(t)
  })
})
