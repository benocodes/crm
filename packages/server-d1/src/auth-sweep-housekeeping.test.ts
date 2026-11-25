import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import {
  MIGRATIONS,
  SWEEP_HOUSEKEEPING_CAP,
  openControlDb,
  runAuthSweep,
  type D1Like,
  type D1PreparedLike,
} from '@vibase/storage-d1'
import { CLI_CLIENT_ID } from '@vibase/auth'
import { RAIL_CRON } from '@vibase/api'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, NOW, faultD1, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE577]] D20, P4, P5: the sweep also deletes expired device codes and never-used registered clients. The accounts and the tokens are written by the REAL Better Auth (a signed-in user, a device
// grant); the housekeeping rows are seeded in the format Better Auth writes them (read from a real registration and device code: ISO-8601 text with milliseconds and a Z, `created_at` of a
// client to the second). The clock is fixed, so ages are exact.
const DAY = 86_400_000
const HOUR = 3_600_000
const T = Date.now()
const clock = () => new Date(T)
const iso = (ms: number) => new Date(ms).toISOString()
let w: WorkerPair
let kit: AuthKit
let ownerId: string
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
  ownerId = (await kit.signUp('person@x.test')).userId
})
afterEach(() => vi.restoreAllMocks())

const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const ids = async (table: string, col: string) =>
  (await rows(w.control, `select ${col} from ${table}`)).map((r) => r[col] as string)
const sweep = () => runAuthSweep(openControlDb(w.control), w.d1, clock, { firstPartyClientId: CLI_CLIENT_ID })
const seq = 0
const insertDeviceCode = (code: string, expiresAt: number, status: 'pending' | 'approved' | 'denied') =>
  w.control
    .prepare(
      'insert into auth_device_codes (id, device_code, user_code, user_id, expires_at, status, client_id, oauth_client_id) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(code, `dev-${code}`, `usr-${code}`, status === 'approved' ? ownerId : null, iso(expiresAt), status, 'c', 'c')
    .run()
const clientStatement = (clientId: string, o: { age: number; userId?: string; referenceId?: string }): D1PreparedLike =>
  w.control
    .prepare(
      'insert into auth_oauth_clients (id, client_id, redirect_uris, user_id, reference_id, created_at, updated_at, name) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      `id-${clientId}`,
      clientId,
      '["https://c.test/cb"]',
      o.userId ?? null,
      o.referenceId ?? null,
      // Better Auth writes a client's creation time to the second.
      iso(Math.floor((T - o.age) / 1000) * 1000),
      iso(T),
      clientId,
    )
const insertClient = (clientId: string, o: { age: number; userId?: string; referenceId?: string }) =>
  clientStatement(clientId, o).run()

describe('D20 expired device codes', () => {
  it('past expires_at is deleted in each stored status, an unexpired one is kept, with nothing else to sweep (the empty state, P5)', async () => {
    await insertDeviceCode('pending-old', T - HOUR, 'pending')
    await insertDeviceCode('approved-old', T - 2 * HOUR, 'approved')
    await insertDeviceCode('denied-old', T - 3 * HOUR, 'denied')
    await insertDeviceCode('pending-live', T + HOUR, 'pending')
    await insertDeviceCode('approved-live', T + HOUR, 'approved')
    await insertDeviceCode('at-now', T, 'pending')
    await insertDeviceCode('just-past', T - 1, 'pending')
    expect(await sweep()).toMatchObject({ revoked: 0, deleted: 0, expiredDeviceCodes: 4, unusedClients: 0 })
    expect((await ids('auth_device_codes', 'id')).sort()).toEqual(['approved-live', 'at-now', 'pending-live'])
    expect(await sweep()).toMatchObject({ expiredDeviceCodes: 0 })
  })
})

describe('D20 unused registered clients (the P4 matrix)', () => {
  it('a client of an unauthenticated registration, older than 7 days and unused, is deleted with its resource links; every keeper survives', async () => {
    const swept = 'swept'
    await insertClient(swept, { age: 8 * DAY })
    await w.control
      .prepare(
        "insert into auth_oauth_client_resources (id, client_id, resource_id) select 'link-1', ?, identifier from auth_oauth_resources limit 1",
      )
      .bind(swept)
      .run()
    const keepers = [
      'young', // 6 days 23 hours
      'exactly-7-days',
      'has-access-token',
      'has-refresh-token',
      'has-consent',
      'owner-created',
      'referenced',
      CLI_CLIENT_ID,
    ]
    await insertClient('young', { age: 7 * DAY - HOUR })
    await insertClient('exactly-7-days', { age: 7 * DAY })
    await insertClient('has-access-token', { age: 30 * DAY })
    await insertClient('has-refresh-token', { age: 30 * DAY })
    await insertClient('has-consent', { age: 30 * DAY })
    await insertClient('owner-created', { age: 30 * DAY, userId: ownerId })
    await insertClient('referenced', { age: 30 * DAY, referenceId: 'org-1' })
    await insertClient(CLI_CLIENT_ID, { age: 90 * DAY })
    await w.control
      .prepare(
        "insert into auth_oauth_access_tokens (id, token, client_id, expires_at, created_at, scopes) values ('at-1', 'tok-1', 'has-access-token', ?, ?, 'openid')",
      )
      .bind(iso(T + DAY), iso(T - DAY))
      .run()
    await w.control
      .prepare(
        "insert into auth_oauth_refresh_tokens (id, token, client_id, user_id, expires_at, created_at, scopes) values ('rt-1', 'rtok-1', 'has-refresh-token', ?, ?, ?, 'openid')",
      )
      .bind(ownerId, iso(T + DAY), iso(T - DAY))
      .run()
    await w.control
      .prepare(
        "insert into auth_oauth_consents (id, client_id, user_id, scopes, created_at, updated_at) values ('co-1', 'has-consent', ?, 'openid', ?, ?)",
      )
      .bind(ownerId, iso(T - DAY), iso(T - DAY))
      .run()
    expect(await sweep()).toMatchObject({ unusedClients: 1, expiredDeviceCodes: 0, revoked: 0, deleted: 0 })
    expect((await ids('auth_oauth_clients', 'client_id')).sort()).toEqual([...keepers].sort())
    expect(await ids('auth_oauth_client_resources', 'id')).not.toContain('link-1')
  })

  it('a client the real Better Auth registered (unauthenticated) is deleted once it is 7 days old and was never used', async () => {
    const id = await kit.registerClient('Claude Desktop')
    await w.control
      .prepare('update auth_oauth_clients set created_at = ? where client_id = ?')
      .bind(iso(T - 8 * DAY), id)
      .run()
    expect(await sweep()).toMatchObject({ unusedClients: 1 })
    expect(await ids('auth_oauth_clients', 'client_id')).not.toContain(id)
  })
})

describe('P5 the per-sweep cap', () => {
  it('cap + 1 eligible rows leave the newest for the next sweep, in both tables', async () => {
    const n = SWEEP_HOUSEKEEPING_CAP + 1
    const codes: D1PreparedLike[] = []
    const clients: D1PreparedLike[] = []
    for (let i = 0; i < n; i++) {
      // i = 0 is the oldest.
      codes.push(
        w.control
          .prepare(
            "insert into auth_device_codes (id, device_code, user_code, expires_at, status) values (?, ?, ?, ?, 'pending')",
          )
          .bind(`dc-${i}`, `dev-${i}`, `usr-${i}`, iso(T - (n - i) * 60_000)),
      )
      clients.push(clientStatement(`cl-${i}`, { age: 8 * DAY + (n - i) * 1000 }))
    }
    await w.control.batch(codes)
    await w.control.batch(clients)
    expect(await sweep()).toMatchObject({
      expiredDeviceCodes: SWEEP_HOUSEKEEPING_CAP,
      unusedClients: SWEEP_HOUSEKEEPING_CAP,
    })
    expect(await ids('auth_device_codes', 'id')).toEqual([`dc-${n - 1}`])
    expect(await ids('auth_oauth_clients', 'client_id')).toEqual([`cl-${n - 1}`])
    expect(await sweep()).toMatchObject({ expiredDeviceCodes: 1, unusedClients: 1 })
    expect(await ids('auth_device_codes', 'id')).toEqual([])
  })
})

describe("P5 on the rail cron, in the sweep's one control batch", () => {
  const worker = (control: D1Like = w.control, at: () => Date = clock) =>
    composeD1Worker(
      {
        DB: w.d1,
        CONTROL_DB: control,
        AUTH_PROVIDER: 'better-auth',
        AUTH_SECRET,
        PUBLIC_BASE_URL: AUTH_BASE,
      } as D1WorkerEnv,
      { clock: at },
    )
  it('a tick with only housekeeping to do deletes it, logs it once, and an empty tick logs nothing', async () => {
    await insertDeviceCode('old', T - HOUR, 'pending')
    await insertClient('stale', { age: 9 * DAY })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await worker().scheduled({ cron: RAIL_CRON })
    expect(await ids('auth_device_codes', 'id')).toEqual([])
    expect(await ids('auth_oauth_clients', 'client_id')).not.toContain('stale')
    const lines = () => log.mock.calls.map((c) => String(c[0])).filter((l) => /auth sweep/.test(l))
    expect(lines()).toEqual([`[cron] ${RAIL_CRON}: auth sweep removed 1 expired device code(s), 1 unused client(s)`])
    log.mockClear()
    await worker().scheduled({ cron: RAIL_CRON })
    expect(lines()).toEqual([])
  })
  it('the housekeeping rides the same batch as an orphan deletion: a failing batch writes none of it, the next tick all of it', async () => {
    // Two days on, the unlinked account of the fixture is an orphan (older than 24 h, no invitation).
    const later = () => new Date(T + 2 * DAY)
    await insertDeviceCode('old', T - HOUR, 'pending')
    await insertClient('stale', { age: 9 * DAY })
    const state = async () => [
      await ids('auth_device_codes', 'id'),
      await ids('auth_oauth_clients', 'client_id'),
      await ids('auth_users', 'id'),
    ]
    const before = await state()
    expect(before[2]).toContain(ownerId)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fault = faultD1(w.control, {
      match: /delete from auth_/i,
      act: async () => {
        throw new Error('D1 is unavailable')
      },
    })
    await expect(worker(fault.d1, later).scheduled({ cron: RAIL_CRON })).rejects.toThrow('D1 is unavailable')
    expect(fault.fired()).toBe(1)
    expect(await state()).toEqual(before)
    await worker(w.control, later).scheduled({ cron: RAIL_CRON })
    const after = await state()
    expect(after[0]).toEqual([])
    expect(after[1]).not.toContain('stale')
    expect(after[2]).not.toContain(ownerId)
  })
})
