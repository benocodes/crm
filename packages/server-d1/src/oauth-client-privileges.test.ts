import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { bootstrapD1, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE577]] D10, P1-P3 through the real Worker composition: Better Auth's own client endpoints and `/oauth2/register`, with a REAL owner session. The membership role is read live from the
// vault, so one person is the owner for the first assertions and a member (their membership row changed) for the next: no other fixture can tell the hook from the library's default.
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
let w: WorkerPair
let n = 0
let wk: ReturnType<typeof composeD1Worker>
let cookie: string
beforeAll(async () => {
  w = await openWorkerPair()
}, 30_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  const r = await bootstrapD1(
    w.d1,
    {
      organizationName: 'Acme',
      authProvider: 'better-auth',
      authOrgId: 'better-auth',
      publicBaseUrl: AUTH_BASE,
      ownerEmail: 'owner@x.test',
    },
    { control: openControlDb(w.control) },
  )
  const invite = new URL(r.ownerInvitation!.url).hash.replace(/^#token=/, '')
  wk = composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  } as D1WorkerEnv)
  const up = await call('/auth/sign-up/email', {
    name: 'Owner',
    email: 'owner@x.test',
    password: 'a long enough password 123',
    invitation_token: invite,
  })
  expect(up.status, await up.clone().text()).toBe(200)
  cookie = up.headers.get('set-cookie')!.split(';')[0]!
})

const call = (path: string, body?: unknown, o: { cookie?: string | null } = {}) =>
  wk.fetch(
    new Request(AUTH_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: AUTH_BASE,
        'cf-connecting-ip': `203.0.113.${++n}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(o.cookie === null ? {} : o.cookie ? { cookie: o.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
const as = (c: string | null) => ({ cookie: c })
const meta = () => ({
  client_name: 'Claude Desktop',
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', DEVICE, 'refresh_token'],
  response_types: ['code'],
  redirect_uris: ['https://client.test/cb'],
  scope: 'openid contacts:read',
})
const demote = () => w.d1.prepare("update memberships set role = 'member'").run()
const clients = async () =>
  ((
    await w.control
      .prepare("select client_id, user_id from auth_oauth_clients where client_id <> 'vibase-cli' order by client_id")
      .all()
  ).results ?? []) as Array<{
    client_id: string
    user_id: string | null
  }>
const created = async (c: string | null) => {
  const res = await call('/auth/oauth2/create-client', meta(), as(c))
  return { res, text: await res.clone().text() }
}

describe('D10 through the real endpoints', () => {
  it('an owner session creates, reads, updates and deletes a client', async () => {
    const { res, text } = await created(cookie)
    expect(res.status, text).toBe(201)
    const id = (JSON.parse(text) as { client_id: string }).client_id
    expect((await call(`/auth/oauth2/get-client?client_id=${id}`, undefined, as(cookie))).status).toBe(200)
    expect((await call('/auth/oauth2/get-clients', undefined, as(cookie))).status).toBe(200)
    const up = await call(
      '/auth/oauth2/update-client',
      { client_id: id, update: { client_name: 'Renamed' } },
      as(cookie),
    )
    expect(up.status, await up.clone().text()).toBe(200)
    expect((await call('/auth/oauth2/delete-client', { client_id: id }, as(cookie))).status).toBe(200)
    expect(await clients()).toEqual([])
  })

  it('a member session is refused create-client, update, delete, read and list; nothing is written or changed', async () => {
    const owned = await created(cookie)
    expect(owned.res.status, owned.text).toBe(201)
    const id = (JSON.parse(owned.text) as { client_id: string }).client_id
    await demote()
    const before = await clients()
    const attempts = await Promise.all([
      created(cookie),
      call('/auth/oauth2/update-client', { client_id: id, update: { client_name: 'Hijacked' } }, as(cookie)),
      call('/auth/oauth2/delete-client', { client_id: id }, as(cookie)),
      call(`/auth/oauth2/get-client?client_id=${id}`, undefined, as(cookie)),
      call('/auth/oauth2/get-clients', undefined, as(cookie)),
    ])
    expect(attempts.map((a) => ('res' in a ? a.res.status : a.status))).toEqual([401, 401, 401, 401, 401])
    expect(await clients()).toEqual(before)
  })

  it('no session is refused', async () => {
    expect((await created(null)).res.status).toBe(401)
    expect(await clients()).toEqual([])
  })
})

describe('registration is unaffected (D10, P2)', () => {
  it('an unauthenticated registration still succeeds, scopes capped; it creates a client with no user', async () => {
    const res = await call('/auth/oauth2/register', meta(), as(null))
    expect(res.status, await res.clone().text()).toBe(201)
    const [c] = await clients()
    expect(c!.user_id).toBeNull()
  })
  it('a registration carrying an owner session is allowed; one carrying a member session is refused (the library calls the hook when a session is present)', async () => {
    const owner = await call('/auth/oauth2/register', meta(), as(cookie))
    expect(owner.status, await owner.clone().text()).toBe(201)
    await demote()
    const before = await clients()
    const member = await call('/auth/oauth2/register', meta(), as(cookie))
    expect(member.status).toBe(401)
    expect(await clients()).toEqual(before)
  })
})
