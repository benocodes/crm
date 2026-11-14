import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuthHandler } from '@vibase/auth'
import { createVibaseRegistry, grantableScopes } from '@vibase/api'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE283]] D11, P6: open dynamic client registration under a policy (public clients only, OIDC plus agent-grantable scopes, the two resources, 10 registrations per IP per hour),
// on the real Better Auth handler and a real control-plane database.
let w: WorkerPair
let kit: AuthKit
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
const humanOnly = declared.filter((s) => !grantable.includes(s))
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  kit = authKit(w.control, { scopes: declared })
})

const meta = (over: Record<string, unknown> = {}) => ({
  client_name: 'Claude Desktop',
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', DEVICE, 'refresh_token'],
  response_types: ['code'],
  redirect_uris: ['http://127.0.0.1:33418/cb'],
  scope: 'openid contacts:read',
  ...over,
})
const register = (body: unknown) => kit.call('/auth/oauth2/register', { body })
const rows = async (q: string) => (await w.control.prepare(q).all()).results as Array<Record<string, any>>

describe('DCR policy (P6)', () => {
  it('the human-only scope set is not empty (the cases below mean something)', () => {
    expect(humanOnly.length).toBeGreaterThan(0)
    expect(humanOnly).toContain('agents:write')
  })

  it('an unauthenticated public registration succeeds: 201, a client id, no secret, linked to both resources, holding the OIDC and grantable scopes only', async () => {
    const res = await register(meta())
    expect(res.status, await res.clone().text()).toBe(201)
    const body = (await res.json()) as Record<string, any>
    expect(body.client_id).toBeTruthy()
    expect(body.client_secret).toBeUndefined()
    const [c] = await rows(`select scopes from auth_oauth_clients where client_id = '${body.client_id}'`)
    const stored = JSON.parse(c!.scopes) as string[]
    expect(stored).toEqual(expect.arrayContaining(['openid', 'offline_access', 'contacts:read']))
    for (const h of humanOnly) expect(stored).not.toContain(h)
    const links = (await rows(`select resource_id from auth_oauth_client_resources where client_id = '${body.client_id}' order by resource_id`)).map((r) => r.resource_id)
    expect(links).toEqual([AUTH_BASE, `${AUTH_BASE}/mcp`])
  })

  it('refused: a confidential auth method, an absent auth method (the library default is confidential), a human-only scope, a foreign resource; each leaves no client row', async () => {
    const { token_endpoint_auth_method: _omit, ...noMethod } = meta()
    const cases: Array<[string, unknown]> = [
      ['client_secret_basic', meta({ token_endpoint_auth_method: 'client_secret_basic' })],
      ['client_secret_post', meta({ token_endpoint_auth_method: 'client_secret_post' })],
      ['no method', noMethod],
      ['human-only scope', meta({ scope: `openid ${humanOnly[0]}` })],
      ['foreign resource', meta({ resources: ['https://evil.test'] })],
    ]
    for (const [name, body] of cases) {
      const res = await register(body)
      expect(res.status, name).toBe(400)
    }
    expect(await rows('select client_id from auth_oauth_clients')).toEqual([])
  })

  it('a resource the policy names is accepted explicitly', async () => {
    expect((await register(meta({ resources: [`${AUTH_BASE}/mcp`] }))).status).toBe(201)
  })

  it('a registered client never obtains a token carrying a human-only scope (device grant, at token time)', async () => {
    const { cookie } = await kit.signUp('person@x.test')
    const reg = (await (await register(meta())).json()) as { client_id: string }
    const attempt = async (scope: string) => {
      const res = await kit.call('/auth/device/code', { body: { client_id: reg.client_id, scope, resource: AUTH_BASE } })
      if (!res.ok) return { refused: true as const }
      try {
        const t = await kit.deviceTokens(cookie, reg.client_id, scope)
        const claims = JSON.parse(Buffer.from(t.access_token.split('.')[1]!, 'base64url').toString()) as { scope?: string }
        return { refused: false as const, scopes: (claims.scope ?? '').split(' ') }
      } catch {
        return { refused: true as const }
      }
    }
    const bad = await attempt(`contacts:read ${humanOnly[0]}`)
    if (!bad.refused) expect(bad.scopes).not.toContain(humanOnly[0])
    const good = await attempt('openid contacts:read')
    expect(good.refused).toBe(false)
    if (!good.refused) expect(good.scopes).toContain('contacts:read')
  })

  it('the seeded-shape client (scopes NULL) is not affected: DCR policy bounds registered clients only', async () => {
    // a client with scopes NULL follows the provider list: proven end to end by the resource matrix; here only that the stored DCR scopes are a bounded list
    const res = await register(meta())
    const { client_id } = (await res.json()) as { client_id: string }
    const [c] = await rows(`select scopes from auth_oauth_clients where client_id = '${client_id}'`)
    expect(c!.scopes).not.toBeNull()
  })
})

describe('registration rate limit (P6)', () => {
  const handler = () => createAuthHandler(w.control, { secret: AUTH_SECRET, baseURL: AUTH_BASE, vaultScopes: declared, grantableScopes: grantable })
  const post = (h: ReturnType<typeof handler>, ip: string | null) =>
    h(new Request(`${AUTH_BASE}/auth/oauth2/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: AUTH_BASE, ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify(meta()) }))

  it('the 11th registration from one IP in the window is 429; another IP is unaffected; the counters live in CONTROL_DB and the CRM database has no limiter table', async () => {
    const h = handler()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await post(h, '198.51.100.7')).status)
    expect(statuses).toEqual([...Array(10).fill(201), 429])
    expect((await post(h, '198.51.100.8')).status).toBe(201)
    const limiter = await rows("select key, count from auth_rate_limits where key like '%198.51.100.7%'")
    expect(limiter.length).toBeGreaterThan(0)
    expect(await rows('select client_id from auth_oauth_clients')).toHaveLength(11)
    const crm = (await w.d1.prepare("select name from sqlite_master where name like 'auth\\_%' escape '\\'").all()).results
    expect(crm).toEqual([])
  })

  it('with no cf-connecting-ip header the requests share one bucket and are limited too: the 11th is 429', async () => {
    const h = handler()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await post(h, null)).status)
    expect(statuses).toEqual([...Array(10).fill(201), 429])
    // one shared bucket for the path: a single limiter row, counted to the limit
    expect(await rows('select count from auth_rate_limits')).toEqual([{ count: 10 }])
  })
})
