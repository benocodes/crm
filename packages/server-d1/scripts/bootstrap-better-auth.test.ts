// [[CORE283]] D10, P5: bootstrap gains the `better-auth` provider (no human) and seeds the first-party `vibase-cli` client into the control plane, idempotently, locally and through
// the `--remote` code path (its test seam, `runBootstrap`). The real Better Auth handler then accepts the client at device authorization.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthHandler } from '@vibase/auth'
import { createVibaseRegistry, grantableScopes } from '@vibase/api'
import { openControlDb } from '@vibase/storage-d1'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { runBootstrap, type BootstrapIo } from './bootstrap.js'
import type { Target } from './remote.js'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
afterEach(async () => {
  await pair.reset()
})

const BASE = 'https://vibase.test'
const SECRET = 'test-auth-secret-0123456789-abcdefghij-klmnop'
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const CTL_UUID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const target: Target = { env: 'demo', workerName: 'vb-demo', databaseName: 'vb-crm-demo', databaseId: UUID, control: { databaseName: 'vb-control-demo', databaseId: CTL_UUID } }
const opts = { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: BASE }
const control = () => openControlDb(pair.control)
const rows = async (q: string, ...b: unknown[]) => (await pair.control.prepare(q).bind(...b).all()).results as Array<Record<string, any>>
const clients = () => rows("select * from auth_oauth_clients where client_id = 'vibase-cli'")
const snapshot = async () => JSON.stringify({ c: await rows('select * from auth_oauth_clients'), r: await rows('select * from auth_oauth_resources order by identifier'), l: await rows('select * from auth_oauth_client_resources order by resource_id') })

function io(): BootstrapIo & { logs: string[]; errors: string[] } {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, log: (l) => void logs.push(l), error: (l) => void errors.push(l), readEnvText: () => '', writeEnvText: () => {} }
}

describe('the seeded vibase-cli client (P5)', () => {
  it('a fresh control database gets exactly one vibase-cli row of the P5 shape, linked to both resources', async () => {
    const r = await bootstrapD1(pair.d1, opts, { control: control() })
    expect(r.userId).toBeNull()
    expect(await rows('select count(*) n from auth_oauth_clients')).toEqual([{ n: 1 }])
    const [c] = await clients()
    expect(c).toMatchObject({ client_id: 'vibase-cli', token_endpoint_auth_method: 'none', client_secret: null, scopes: null, user_id: null })
    expect(c!.disabled === null || c!.disabled === 0).toBe(true)
    expect(JSON.parse(c!.grant_types)).toEqual([DEVICE, 'refresh_token'])
    expect(await rows('select resource_id from auth_oauth_client_resources where client_id = ? order by resource_id', 'vibase-cli')).toEqual([{ resource_id: BASE }, { resource_id: `${BASE}/mcp` }])
    expect((await rows('select identifier from auth_oauth_resources order by identifier')).map((x) => x.identifier)).toEqual([BASE, `${BASE}/mcp`])
  })

  it('a second run writes nothing new, converges a drifted shape, and leaves disabled alone', async () => {
    await bootstrapD1(pair.d1, opts, { control: control() })
    await pair.control.prepare("update auth_oauth_clients set disabled = 1, scopes = '[\"openid\"]', token_endpoint_auth_method = 'client_secret_basic' where client_id = 'vibase-cli'").run()
    await pair.control.prepare("delete from auth_oauth_client_resources where resource_id like '%/mcp'").run()
    const second = await bootstrapD1(pair.d1, opts, { control: control() })
    expect(second.deployment).toBe('existing')
    const [c] = await clients()
    expect(c).toMatchObject({ scopes: null, token_endpoint_auth_method: 'none', disabled: 1 })
    expect(await rows('select count(*) n from auth_oauth_clients')).toEqual([{ n: 1 }])
    expect(await rows('select count(*) n from auth_oauth_client_resources')).toEqual([{ n: 2 }])
    // and now it converged: a third run changes no row
    await pair.control.prepare('update auth_oauth_clients set updated_at = updated_at').run()
    const before = JSON.stringify((await rows('select * from auth_oauth_clients')).map(({ updated_at, ...rest }) => rest))
    await bootstrapD1(pair.d1, opts, { control: control() })
    expect(JSON.stringify((await rows('select * from auth_oauth_clients')).map(({ updated_at, ...rest }) => rest))).toBe(before)
  })

  it('the --remote code path seeds too, through its test seam', async () => {
    const i = io()
    const code = await runBootstrap({ mode: 'remote', keyEnv: 'OP_KEY', values: { org: 'demo', 'auth-provider': 'better-auth', 'public-base-url': BASE }, authOrgId: 'better-auth', target }, { env: { DB: pair.d1, CONTROL_DB: pair.control } }, i)
    expect(i.errors).toEqual([])
    expect(code).toBe(0)
    expect(await clients()).toHaveLength(1)
    // local mode, a second time: one row still
    expect(await runBootstrap({ mode: 'local', values: { org: 'demo', 'auth-provider': 'better-auth', 'public-base-url': BASE }, authOrgId: 'better-auth' }, { env: { DB: pair.d1, CONTROL_DB: pair.control } }, io())).toBe(0)
    expect(await rows('select count(*) n from auth_oauth_clients')).toEqual([{ n: 1 }])
  })

  it('--email, --name and --auth-subject are refused with better-auth, as with Clerk; so is a missing control database or base URL', async () => {
    for (const extra of [{ email: 'o@x.test' }, { userName: 'Owner' }, { authSubject: 'sub' }]) {
      await expect(bootstrapD1(pair.d1, { ...opts, ...extra }, { control: control() })).rejects.toThrow(/creates no human/)
    }
    await expect(bootstrapD1(pair.d1, opts, {})).rejects.toThrow(/control database/)
    await expect(bootstrapD1(pair.d1, { ...opts, publicBaseUrl: undefined }, { control: control() })).rejects.toThrow(/PUBLIC_BASE_URL/)
    expect(await snapshot()).toBe(JSON.stringify({ c: [], r: [], l: [] }))
  })

  it('the real Better Auth handler accepts client_id=vibase-cli at device authorization, with either resource, and refuses an unknown client', async () => {
    await bootstrapD1(pair.d1, opts, { control: control() })
    const declared = createVibaseRegistry().declaredScopes()
    const handler = createAuthHandler(pair.control, { secret: SECRET, baseURL: BASE, vaultScopes: declared, grantableScopes: grantableScopes(declared) })
    const code = (client: string, resource: string) =>
      handler(new Request(`${BASE}/auth/device/code`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': '203.0.113.5' }, body: JSON.stringify({ client_id: client, scope: 'contacts:read offline_access', resource }) }))
    for (const resource of [BASE, `${BASE}/mcp`]) {
      const res = await code('vibase-cli', resource)
      expect(res.status, await res.clone().text()).toBe(200)
      expect(((await res.json()) as { verification_uri: string }).verification_uri).toContain(`${BASE}/auth/`)
    }
    expect((await code('not-a-client', BASE)).status).toBeGreaterThanOrEqual(400)
  })
})
