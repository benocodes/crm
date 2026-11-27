import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { applyControlMigrations, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE329]] (P1, [[CORE259]] D13 CRM half): the CRM database has none of `api_keys` and the four webhook tables, and the control database still has them.
const DROPPED = [
  'api_keys',
  'webhook_deliveries',
  'webhook_dispatch_state',
  'webhook_secrets',
  'webhook_subscriptions',
] as const

let local: LocalD1
let control: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL'], { migrate: false })
  control = local.bindings.CONTROL!
  await applyControlMigrations(control)
})
afterAll(async () => {
  await local.dispose()
})

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
describe('the CRM database holds no api_keys or webhook tables (CORE329 P1)', () => {
  it('the whole CRM directory leaves none of the five tables in a fresh database, and the control directory still has api_keys and the webhook tables', async () => {
    const fresh = (await openLocalD1(['CRM'], { migrate: false })).bindings.CRM!
    await applyMigrations(fresh)
    const names = await tablesOf(fresh)
    for (const t of DROPPED) expect(names, t).not.toContain(t)
    const ctl = await tablesOf(control)
    for (const t of DROPPED) expect(ctl, t).toContain(t)
  })
})
