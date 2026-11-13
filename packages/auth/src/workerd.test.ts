import { fileURLToPath } from 'node:url'
import { seedDeployment, seedPrincipal } from '@vault/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from './index.js'
import { bundleWorker, startWorkerd, type Bundle, type Workerd } from './test/index.js'

const ENTRY = fileURLToPath(new URL('./test/entry.ts', import.meta.url))
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const OWNER = '0190b2c4-0000-7000-8000-00000000b001'
const PASSWORD = 'a long enough password 123'

let bundle: Bundle
let open: Workerd
let shut: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  open = await startWorkerd({ bundle, bindings: { OPEN_ADMISSION: '1' } })
  shut = await startWorkerd({ bundle })
}, 120_000)
afterAll(async () => {
  await open?.dispose()
  await shut?.dispose()
  bundle?.dispose()
})

const vaultRows = (w: Workerd) => Promise.all(['events', 'users', 'principals', 'memberships'].map((t) => w.rows(`select * from ${t} order by 1`)))
const idsOf = async (w: Workerd, table: string) => (await w.rows<{ id: string }>(`select id from ${table}`)).map((r) => r.id)

// [[CORE243]] D4, D5, P1, P3 in workerd: Better Auth writes into the migrated auth_* tables through the test composition (the only one that admits sign-up and
// client registration), the hasher round-trips, and a vault with data in it is untouched.
describe('Better Auth in workerd on migration 0018 (test admission)', () => {
  let cookie: string
  let vaultBefore: unknown[]

  it('sign-up, session and sign-in write auth_users, auth_accounts and auth_sessions with UUIDv7 ids and the vault hasher', async () => {
    await seedDeployment(open.d1, { organizationId: ORG, provider: 'better-auth', externalId: 'org_auth' })
    await seedPrincipal(open.d1, { id: OWNER, kind: 'user', email: 'owner@vault.test' })
    vaultBefore = await vaultRows(open)
    const up = await open.call('/auth/sign-up/email', { body: { name: 'Owner', email: 'owner@auth.test', password: PASSWORD } })
    expect(up.status, await up.clone().text()).toBe(200)
    cookie = up.headers.get('set-cookie')!.split(';')[0]!
    const session = (await (await open.call('/auth/get-session', { cookie })).json()) as { user: { email: string } }
    expect(session.user.email).toBe('owner@auth.test')
    expect((await open.call('/auth/sign-in/email', { body: { email: 'owner@auth.test', password: PASSWORD } })).status).toBe(200)
    const wrong = await open.call('/auth/sign-in/email', { body: { email: 'owner@auth.test', password: 'not the password at all' } })
    expect(wrong.status).toBe(401)
    for (const t of ['auth_users', 'auth_accounts', 'auth_sessions']) {
      const ids = await idsOf(open, t)
      expect(ids.length, t).toBeGreaterThan(0)
      for (const id of ids) expect(id, `${t}.id`).toMatch(UUIDV7)
    }
    const [account] = await open.rows<{ password: string }>('select password from auth_accounts')
    expect(account!.password).toMatch(/^pbkdf2-sha256\$100000\$/)
  })

  it('records the timestamp form Better Auth writes: ISO-8601 text', async () => {
    const [u] = await open.rows<{ created_at: unknown; email_verified: unknown }>('select created_at, email_verified from auth_users')
    expect(typeof u!.created_at).toBe('string')
    expect(new Date(u!.created_at as string).toISOString()).toBe(u!.created_at)
    expect(u!.email_verified).toBe(0)
  })

  it('creates the signing key (auth_jwks) on first use, with the private key stored encrypted', async () => {
    const res = await open.call('/auth/jwks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<{ kid: string }> }
    expect(body.keys.length).toBeGreaterThan(0)
    const rows = await open.rows<{ id: string; public_key: string; private_key: string }>('select id, public_key, private_key from auth_jwks')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.id).toMatch(UUIDV7)
      expect(r.private_key).not.toContain('"d"')
    }
  })

  it('registers a dynamic client and issues a device code, both into auth_* tables', async () => {
    const reg = await open.call('/auth/oauth2/register', {
      body: {
        client_name: 'Foundation test client',
        token_endpoint_auth_method: 'none',
        resources: ['http://localhost:8787'],
        grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'openid offline_access',
        redirect_uris: ['https://client.test/callback'],
      },
    })
    expect(reg.status, await reg.clone().text()).toBe(200)
    const client = (await reg.json()) as { client_id: string }
    const codes = await open.call('/auth/device/code', { body: { client_id: client.client_id, scope: 'openid offline_access', resource: 'http://localhost:8787' } })
    expect(codes.status, await codes.clone().text()).toBe(200)
    for (const t of ['auth_oauth_clients', 'auth_device_codes']) {
      const ids = await idsOf(open, t)
      expect(ids.length, t).toBe(1)
      expect(ids[0], t).toMatch(UUIDV7)
    }
    const [c] = await open.rows<{ client_id: string; redirect_uris: string; token_endpoint_auth_method: string }>('select client_id, redirect_uris, token_endpoint_auth_method from auth_oauth_clients')
    expect(c!.client_id).toBe(client.client_id)
    expect(c!.token_endpoint_auth_method).toBe('none')
    const [d] = await open.rows<{ client_id: string; status: string; polling_interval: number }>('select client_id, status, polling_interval from auth_device_codes')
    expect(d).toMatchObject({ client_id: client.client_id, status: 'pending' })
  })

  it('the rate limiter keeps its counters in auth_rate_limits', async () => {
    const rows = await open.rows<{ id: string }>('select id from auth_rate_limits')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.id).toMatch(UUIDV7)
  })

  it('D5: none of it touched a vault table: events, users, principals and memberships are as they were', async () => {
    expect(await vaultRows(open)).toEqual(vaultBefore)
  })
})

describe('the shipped composition (no test admission) refuses admission (P1)', () => {
  it('refuses sign-up and writes no user', async () => {
    const res = await shut.call('/auth/sign-up/email', { body: { name: 'Nobody', email: 'nobody@auth.test', password: PASSWORD } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await shut.rows('select id from auth_users')).toEqual([])
  })

  it('refuses dynamic client registration and writes no client', async () => {
    const res = await shut.call('/auth/oauth2/register', {
      body: { client_name: 'Nobody', token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'openid', redirect_uris: ['https://client.test/callback'] },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await shut.rows('select id from auth_oauth_clients')).toEqual([])
  })
})

// P3: the hasher inside workerd, where Web Crypto's PBKDF2 has a cap.
describe('the hasher in workerd (P3)', () => {
  const hashProbe = (iterations: number) => open.call(`/__hash?kdf=pbkdf2&iterations=${iterations}`)

  it('hashes at the configured iteration count, and workerd refuses one more (the cap is what the constant is set to)', async () => {
    expect((await hashProbe(100_000)).status).toBe(200)
    expect((await hashProbe(100_001)).status).toBe(500)
  })

  it('verifies, inside workerd, a hash made elsewhere with other parameters', async () => {
    const old = await hashPassword('made in node', { iterations: 5_000 })
    const verify = async (password: string) => ((await (await open.call(`/__verify?hash=${encodeURIComponent(old)}&password=${encodeURIComponent(password)}`)).json()) as { ok: boolean }).ok
    expect(await verify('made in node')).toBe(true)
    expect(await verify('made in nodf')).toBe(false)
  })
})
