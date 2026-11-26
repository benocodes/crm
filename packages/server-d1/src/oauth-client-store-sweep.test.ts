import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, openControlDb, runAuthSweep } from '@vibase/storage-d1'
import { CLI_CLIENT_ID } from '@vibase/auth'
import { authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE623]] cycle 1, charter group 2 (D5): a first-party client is not a "never used registered client" and is not an owner's client. The seven-day sweep leaves it alone while it deletes a DCR-shaped client
// of the same age and use in the same run (so the survival is not vacuous), and removing an `auth_users` row (an owner leaving) cascades nothing onto it.
const DAY = 86_400_000
const T = Math.floor(Date.now() / 1000) * 1000
const ACTOR = '0190b2c4-0000-7000-8000-0000000000a1'
const iso = (ms: number) => new Date(ms).toISOString()
let w: WorkerPair
let kit: AuthKit
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
  kit = authKit(w.control, { scopes: [] })
})
const ids = async () =>
  (
    ((await w.control.prepare('select client_id from auth_oauth_clients').all()).results ?? []) as Array<{
      client_id: string
    }>
  )
    .map((r) => r.client_id)
    .sort()
const sweep = () =>
  runAuthSweep(openControlDb(w.control), w.d1, () => new Date(T), { firstPartyClientIds: [CLI_CLIENT_ID] })
const makeFirstParty = (clientId: string) =>
  createOAuthClient(openControlDb(w.control), {
    organizationId: 'org-1',
    clientId,
    name: 'Acme App',
    redirectUris: ['https://app.test/cb'],
    scopes: ['openid'],
    skipConsent: true,
    resources: ['https://api.test', 'https://api.test/mcp'],
    actorId: ACTOR,
    now: iso(T - 8 * DAY),
    newId: uuidv7,
  })
const dcr = (clientId: string) =>
  w.control
    .prepare(
      "insert into auth_oauth_clients (id, client_id, redirect_uris, user_id, reference_id, created_at, updated_at, name) values (?, ?, '[\"https://c.test/cb\"]', null, null, ?, ?, 'Claude Desktop')",
    )
    .bind(`id-${clientId}`, clientId, iso(T - 8 * DAY), iso(T - 8 * DAY))
    .run()

describe('D5: the sweep and an owner leaving', () => {
  it('a first-party client older than seven days with no tokens survives the sweep, while a DCR-shaped client of the same age and use is deleted in the same run', async () => {
    await makeFirstParty('first-party-client')
    await dcr('dcr-client')
    expect(await sweep()).toMatchObject({ unusedClients: 1 })
    expect(await ids()).toEqual(['first-party-client'])
  })

  it('deleting an auth_users row (an owner leaving) leaves the first-party client in place', async () => {
    const { userId } = await kit.signUp('person@x.test')
    await makeFirstParty('first-party-client')
    await dcr('dcr-client')
    await w.control.prepare('delete from auth_users where id = ?').bind(userId).run()
    expect(await ids()).toEqual(['dcr-client', 'first-party-client'])
    const row = await w.control
      .prepare("select user_id, reference_id from auth_oauth_clients where client_id = 'first-party-client'")
      .first()
    expect(row).toEqual({ user_id: null, reference_id: 'org-1' })
  })
})
