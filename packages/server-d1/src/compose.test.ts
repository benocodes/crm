import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { seedConversation } from '@vault/api/test/messaging'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { messageBodyKey } from '@vault/api'
import { clerkMembership, clerkOrganization, clerkWebhook, mintClerkToken, orgClaim, signClerkWebhook } from '@vault/api/test/clerk'
import { MIGRATIONS } from '@vault/storage-d1'
import { bootstrapD1 } from './bootstrap-d1.js'
import { NOT_INITIALISED, composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, clerkKit, openWorkerD1, spyD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

let w: WorkerD1
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  kit.fetch.reset()
  kit.profiles.clear()
  kit.organizations.clear()
  kit.members.clear()
})

const BASE = 'https://w.test'
const get = (worker: { fetch(r: Request): Promise<Response> }, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(BASE + path, { headers }))
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const boot = (over: Partial<Parameters<typeof bootstrapD1>[1]> = {}) =>
  bootstrapD1(w.d1, { organizationName: 'Acme', email: 'owner@x.test', agentName: 'bot', authOrgId: 'org_acme', ...over }, { now: NOW, newId: () => uuidv7(NOW) })
const withClerk = (extra: Partial<D1WorkerEnv> = {}): D1WorkerEnv => ({ DB: w.d1, ...kit.env, ...extra })
const noAuth = (extra: Partial<D1WorkerEnv> = {}): D1WorkerEnv => ({ DB: w.d1, AUTH_PROVIDER: '', ...extra })
/** The harness has no `d1_migrations`, so a test database reports `unknown` ([[CORE61]] D10). */
const UNKNOWN_MIGRATIONS = { status: 'unknown', applied: 0, expected: MIGRATIONS.length, latest_applied: null, latest_expected: MIGRATIONS.at(-1)!.name }
const mutations = (sqls: string[]) => sqls.filter((s) => /^\s*(insert|update|delete)/i.test(s))

describe('before the deployment is initialised (D2, D3, D4)', () => {
  it('GET /health is 200 with initialised false', async () => {
    const res = await get(composeD1Worker(noAuth()), '/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', initialised: false, version: 'dev', migrations: UNKNOWN_MIGRATIONS })
  })

  it.each([
    ['GET /tasks with a key-shaped bearer', 'GET', '/tasks', { authorization: 'Bearer vk_anything' }],
    ['GET /tasks with a JWT-shaped bearer', 'GET', '/tasks', { authorization: 'Bearer a.b.c' }],
    ['GET /tasks with no credentials', 'GET', '/tasks', {}],
    ['POST /webhooks/clerk', 'POST', '/webhooks/clerk', {}],
  ])('%s is 503 not_initialised and no unit runs', async (_n, method, path, headers) => {
    const spy = spyD1(w.d1)
    const worker = composeD1Worker({ ...withClerk(), DB: spy.d1 }, { fetch: kit.fetch })
    const res = await worker.fetch(new Request(BASE + path, { method, headers, body: method === 'POST' ? '{}' : undefined }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(NOT_INITIALISED)
    expect(mutations(spy.log.statements)).toEqual([])
    expect(kit.fetch.calls).toEqual([])
  })

  it('GET /openapi.json is served', async () => {
    const res = await get(composeD1Worker(noAuth()), '/openapi.json')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { openapi: string }).openapi).toBe('3.1.0')
  })

  it('a marker written after an earlier 503 is picked up by the next request of the same isolate', async () => {
    const worker = composeD1Worker(noAuth())
    expect((await get(worker, '/tasks', bearer('vk_x'))).status).toBe(503)
    const r = await boot()
    expect((await get(worker, '/tasks', bearer(r.key))).status).toBe(200)
  })
})

describe('after bootstrap', () => {
  it('serves the app', async () => {
    const r = await boot()
    const res = await get(composeD1Worker(noAuth()), '/tasks', bearer(r.key))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [], next_cursor: null })
  })

  it('reads the marker once per isolate', async () => {
    const r = await boot()
    const spy = spyD1(w.d1)
    spy.log.clear()
    const worker = composeD1Worker({ DB: spy.d1, AUTH_PROVIDER: '' })
    await get(worker, '/tasks', bearer(r.key))
    await get(worker, '/tasks', bearer(r.key))
    expect(spy.log.statements.filter((s) => /from "?deployment"?/i.test(s))).toHaveLength(1)
  })

  it('GET /health is 200 with initialised true', async () => {
    await boot()
    expect(await (await get(composeD1Worker(noAuth()), '/health')).json()).toEqual({ status: 'ok', initialised: true, version: 'dev', migrations: UNKNOWN_MIGRATIONS })
  })

  it('GET /health is 503 unavailable when D1 cannot answer SELECT 1', async () => {
    await boot()
    let down = false
    const spy = spyD1(w.d1, { failSelectOne: () => down })
    const worker = composeD1Worker({ DB: spy.d1, AUTH_PROVIDER: '' })
    expect((await get(worker, '/health')).status).toBe(200)
    down = true
    const res = await get(worker, '/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable' })
  })

  it('with AUTH_PROVIDER empty a key works and a JWT-shaped token is 401', async () => {
    const r = await boot()
    const worker = composeD1Worker(noAuth())
    expect((await get(worker, '/tasks', bearer(r.key))).status).toBe(200)
    expect((await get(worker, '/tasks', bearer('a.b.c'))).status).toBe(401)
  })

  it('answers a CORS preflight for an allowed origin', async () => {
    await boot()
    const origin = 'https://pane.test.example'
    const worker = composeD1Worker(noAuth({ CORS_ALLOWED_ORIGINS: origin }))
    const res = await worker.fetch(new Request(BASE + '/tasks', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }))
    expect(res.headers.get('access-control-allow-origin')).toBe(origin)
  })

  it('mounts the Clerk webhook: a signed organization.updated renames the organisation', async () => {
    await boot({ authSubject: 'user_owner' })
    kit.organizations.set('org_acme', clerkOrganization({ id: 'org_acme', name: 'Acme Renamed' }))
    kit.members.set('org_acme', [clerkMembership({ organizationId: 'org_acme', userId: 'user_owner', role: 'org:admin' })])
    kit.profiles.set('user_owner', (await import('@vault/api/test/clerk')).clerkUser({ id: 'user_owner', email: 'owner@x.test' }))
    const worker = composeD1Worker(withClerk(), { fetch: kit.fetch })
    const signed = signClerkWebhook(clerkWebhook('organization.updated', { id: 'org_acme' }))
    const res = await worker.fetch(new Request(BASE + '/webhooks/clerk', { method: 'POST', headers: signed.headers, body: signed.body }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    const [org] = (await w.d1.prepare('select name from organizations').all()).results as Array<{ name: string }>
    expect(org!.name).toBe('Acme Renamed')
  })

  it('D19: a token claiming another organisation is 403 organization_forbidden with no fetch', async () => {
    await boot({ authSubject: 'user_owner' })
    const worker = composeD1Worker(withClerk(), { fetch: kit.fetch })
    const token = await mintClerkToken(kit.issuer, { sub: 'user_owner', extra: orgClaim('org_other') })
    const res = await get(worker, '/me', bearer(token))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('organization_forbidden')
    expect(kit.fetch.calls).toEqual([])
  })
})

describe('a misconfigured auth provider (D12)', () => {
  it('is 500 internal on every non-health route, logs one line naming the variable, and leaks no secret value', async () => {
    await boot()
    const SECRET = 'sk_test_THE_SECRET_VALUE'
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const env = withClerk({ CLERK_JWT_KEY: undefined, CLERK_SECRET_KEY: SECRET })
    const worker = composeD1Worker(env, { fetch: kit.fetch })
    for (const path of ['/tasks', '/openapi.json', '/me']) {
      const res = await get(worker, path, bearer('vk_x'))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal')
    }
    expect((await get(worker, '/health')).status).toBe(200)
    const calls = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
    const lines = calls.filter((c) => c.includes('[d1-worker] invalid auth configuration'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('CLERK_JWT_KEY')
    expect(calls.join('\n')).not.toContain(SECRET)
    spies.forEach((s) => s.mockRestore())
  })
})

describe('GET /health version (C1)', () => {
  it('reports VERSION', async () => {
    const res = await get(composeD1Worker(noAuth({ VERSION: 'abc123' })), '/health')
    expect(await res.json()).toEqual({ status: 'ok', initialised: false, version: 'abc123', migrations: UNKNOWN_MIGRATIONS })
  })

  it('an empty VERSION is dev', async () => {
    const res = await get(composeD1Worker(noAuth({ VERSION: '' })), '/health')
    expect(((await res.json()) as { version: string }).version).toBe('dev')
  })

  it('the 503 carries no version', async () => {
    const spy = spyD1(w.d1, { failSelectOne: () => true })
    const res = await get(composeD1Worker({ DB: spy.d1, AUTH_PROVIDER: '', VERSION: 'abc' }), '/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable' })
  })
})

describe('the none:smoked1 marker (OPS4 D18)', () => {
  const smoked = () => boot({ authProvider: 'none', authOrgId: 'smoked1', organizationName: 'smoked1', agentName: 'operator' })

  it('serves agents by key and nobody by JWT; the owner has no login', async () => {
    const r = await smoked()
    const worker = composeD1Worker(noAuth())
    const list = await get(worker, '/tasks', bearer(r.key))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ data: [], next_cursor: null })
    expect((await get(worker, '/tasks', bearer('a.b.c'))).status).toBe(401)
    expect((await get(worker, '/tasks')).status).toBe(401)
    const created = await worker.fetch(new Request(BASE + '/tasks', { method: 'POST', headers: { ...bearer(r.key), 'content-type': 'application/json' }, body: JSON.stringify({ title: 't' }) }))
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const del = await worker.fetch(new Request(BASE + `/tasks/${id}`, { method: 'DELETE', headers: bearer(r.key) }))
    expect(del.status).toBe(204)
    const [marker] = (await w.d1.prepare('select auth_provider, auth_org_id from deployment').all()).results as Array<Record<string, unknown>>
    expect(marker).toEqual({ auth_provider: 'none', auth_org_id: 'smoked1' })
    const [user] = (await w.d1.prepare('select auth_provider, auth_subject from users').all()).results as Array<Record<string, unknown>>
    expect(user).toEqual({ auth_provider: null, auth_subject: null })
  })

  it('a Clerk JWT claiming org smoked1 is not served, and nothing is written', async () => {
    await smoked()
    const before = (await w.d1.prepare('select count(*) c from users').first()) as { c: number }
    const worker = composeD1Worker(withClerk(), { fetch: kit.fetch })
    const token = await mintClerkToken(kit.issuer, { sub: 'user_x', extra: orgClaim('smoked1') })
    const res = await get(worker, '/me', bearer(token))
    expect(res.status).toBe(403)
    const after = (await w.d1.prepare('select count(*) c from users').first()) as { c: number }
    expect(after.c).toBe(before.c)
  })
})

describe('message content through BODIES (CORE58 P12)', () => {
  const seed = async () => {
    const r = await boot()
    const orgId = ((await w.d1.prepare('select organization_id as o from deployment').first()) as { o: string }).o
    const creator = ((await w.d1.prepare('select id from principals limit 1').first()) as { id: string }).id
    const insert = async (table: string, row: Record<string, unknown>) => {
      const full: Record<string, unknown> = { id: uuidv7(NOW), organization_id: orgId, created_by: creator, created_at: NOW.toISOString(), ...row }
      const cols = Object.keys(full)
      const vals = cols.map((c) => (typeof full[c] === 'boolean' ? (full[c] ? 1 : 0) : full[c] !== null && typeof full[c] === 'object' ? JSON.stringify(full[c]) : (full[c] ?? null)))
      await w.d1.prepare(`insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).bind(...vals).run()
      return full
    }
    return { key: r.key, c: await seedConversation(insert) }
  }

  it('BODIES serves content', async () => {
    const { key, c } = await seed()
    const bucket = fakeR2Bucket()
    await bucket.put(messageBodyKey(c.contentKey!, 1), '# Hello')
    const res = await get(composeD1Worker(noAuth({ BODIES: bucket })), `/messages/${c.messageId}/content`, bearer(key))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content_type: 'text/markdown', content: '# Hello', version: 1 })
    expect(bucket.gets).toEqual([messageBodyKey(c.contentKey!, 1)])
  })

  it('without BODIES the content route is 503 and the rest works', async () => {
    const { key, c } = await seed()
    const worker = composeD1Worker(noAuth())
    const res = await get(worker, `/messages/${c.messageId}/content`, bearer(key))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('objects_unavailable')
    expect((await get(worker, '/tasks', bearer(key))).status).toBe(200)
  })
})
