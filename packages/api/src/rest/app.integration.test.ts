import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, truncateAll } from '@vault/db/test'
import { Registry } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { parseScope } from '../scopes.js'
import { seedApiKey } from '../test/keys.js'
import { seedTenant, type Tenant } from '../test/tenant.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { createApp } from './app.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let A: Tenant
let B: Tenant
let key: string
let agentId: string

const empty = z.object({})
function testRegistry() {
  return new Registry()
    .registerResource(tasks)
    .register({
      kind: 'tenant',
      name: 'probe.echo',
      summary: 'Echo',
      method: 'post',
      path: '/probe/echo/{id}',
      scope: parseScope('tasks:write'),
      validation: 'adapter',
      request: {
        params: z.object({ id: z.uuid() }),
        query: z.strictObject({ n: z.coerce.number().int().optional() }),
        body: z.strictObject({ msg: z.string() }),
      },
      response: { status: 201, schema: z.object({ id: z.string(), n: z.number().optional(), msg: z.string(), org: z.string() }) },
      handler: async (ctx, input) => ({
        id: (input.params as { id: string }).id,
        n: (input.query as { n?: number }).n,
        msg: (input.body as { msg: string }).msg,
        org: ctx.organizationId,
      }),
    })
    .register({
      kind: 'tenant',
      name: 'probe.emit',
      summary: 'Emit',
      method: 'post',
      path: '/probe/emit',
      scope: parseScope('tasks:write'),
      response: { status: 200, schema: z.object({ ok: z.boolean() }) },
      handler: async (ctx) => {
        await ctx.emit({ type: 'probe.emitted', resourceType: 'probe', resourceId: ctx.actor.id, before: null, after: { x: 1 } })
        return { ok: true }
      },
    })
    .register({
      kind: 'tenant',
      name: 'probe.boom',
      summary: 'Boom',
      method: 'post',
      path: '/probe/boom',
      scope: parseScope('tasks:write'),
      response: { status: 200, schema: empty },
      handler: async () => {
        throw new Error('secret detail')
      },
    })
    .register({
      kind: 'account',
      name: 'account.whoami',
      summary: 'Who am I (account)',
      method: 'get',
      path: '/account/whoami',
      request: { query: z.object({ emit: z.string().optional() }) },
      validation: 'adapter',
      response: { status: 200, schema: z.object({ actor_id: z.string() }) },
      handler: async (ctx, input) => {
        const emit = (input.query as { emit?: string }).emit
        if (emit) {
          await ctx.emitFor(emit, { type: 'probe.emitted', resourceType: 'probe', resourceId: ctx.actor.id, before: null, after: null })
        }
        return { actor_id: ctx.actor.id }
      },
    })
}
const mkApp = (resolver: () => Kysely<Database> = () => db) =>
  createApp({ db: resolver, registry: testRegistry(), userAuthenticator: fakeUserAuthenticator() })
const agentHeaders = () => ({ authorization: `Bearer ${key}` })
const userHeaders = (t: Tenant, organizationId: string | null = t.organizationId) => ({
  authorization: `Bearer ${mintTestUserToken({ userId: t.userId, organizationId, scopes: ['tasks:read', 'tasks:write'] })}`,
})
const post = (app: ReturnType<typeof mkApp>, path: string, body?: unknown, headers: Record<string, string> = agentHeaders()) =>
  app.request(path, { method: 'POST', headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const UUID = '0190b2c4-0000-7000-8000-000000000001'

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
beforeEach(async () => {
  vi.restoreAllMocks()
  await truncateAll(owner)
  A = await seedTenant(db, 'A')
  B = await seedTenant(db, 'B')
  const agent = await seedAgent(db, { organizationId: A.organizationId, createdBy: A.userId, scopes: ['tasks:read', 'tasks:write'] })
  agentId = agent.id
  key = (await seedApiKey(db, { organizationId: A.organizationId, agentId: agent.id, createdBy: A.userId })).key
})

describe('adapter validation', () => {
  it('parses params, query and body', async () => {
    const res = await post(mkApp(), `/probe/echo/${UUID}?n=3`, { msg: 'hi' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: UUID, n: 3, msg: 'hi', org: A.organizationId })
  })
  it.each([
    ['bad uuid', '/probe/echo/nope', { msg: 'hi' }],
    ['unknown query', `/probe/echo/${UUID}?zz=1`, { msg: 'hi' }],
    ['bad body type', `/probe/echo/${UUID}`, { msg: 1 }],
    ['unknown body key', `/probe/echo/${UUID}`, { msg: 'a', x: 1 }],
  ])('refuses %s', async (_n, path, body) => {
    const res = await post(mkApp(), path, body)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })
})

describe('bodies', () => {
  it('invalid JSON is 400', async () => {
    const res = await post(mkApp(), '/tasks', '{not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'validation_error', message: 'request body is not valid JSON' } })
  })
  it('an empty body is 400', async () => {
    const res = await post(mkApp(), '/tasks')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })
  it('needs no Content-Type', async () => {
    const res = await post(mkApp(), '/tasks', { title: 'a' })
    expect(res.status).toBe(201)
  })
  it('generic validation comes from the handler', async () => {
    const res = await post(mkApp(), '/tasks', { title: 'a', zz: 1 })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })
})

describe('generic routes', () => {
  it('a non-UUID id is 404', async () => {
    const res = await mkApp().request('/tasks/abc', { headers: agentHeaders() })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'task not found' } })
  })
  it('lists with a cursor and filters', async () => {
    const app = mkApp()
    for (const t of ['a', 'b', 'c']) await post(app, '/tasks', { title: t, status: t === 'c' ? 'done' : 'open' })
    const p1 = await (await app.request('/tasks?limit=2', { headers: agentHeaders() })).json()
    expect(p1.data).toHaveLength(2)
    const p2 = await (await app.request(`/tasks?after=${p1.next_cursor}`, { headers: agentHeaders() })).json()
    expect(p2.data).toHaveLength(1)
    expect(p2.next_cursor).toBeNull()
    const done = await (await app.request('/tasks?status=done', { headers: agentHeaders() })).json()
    expect(done.data.map((r: { title: string }) => r.title)).toEqual(['c'])
    expect((await app.request('/tasks?limit=0', { headers: agentHeaders() })).status).toBe(400)
    expect((await app.request('/tasks?title=x', { headers: agentHeaders() })).status).toBe(400)
  })
  it('delete renders 204 with an empty body', async () => {
    const app = mkApp()
    const created = await (await post(app, '/tasks', { title: 'a' })).json()
    const res = await app.request(`/tasks/${created.id}`, { method: 'DELETE', headers: agentHeaders() })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})

describe('context', () => {
  it('events through REST carry the agent and organisation', async () => {
    const res = await post(mkApp(), '/probe/emit')
    expect(res.status).toBe(200)
    const ev = await owner.selectFrom('events').selectAll().execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ organization_id: A.organizationId, type: 'probe.emitted' })
    expect(ev[0]!.actor_id).toBe(agentId)
  })
  it('an account op works for a user with no organisation', async () => {
    const res = await mkApp().request('/account/whoami', { headers: userHeaders(A, null) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ actor_id: A.userId })
  })
  it('an account op refuses agents', async () => {
    const res = await mkApp().request('/account/whoami', { headers: agentHeaders() })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'user_required', message: 'this operation requires a signed-in user' } })
  })
  it('an account op emits with an explicit organisation', async () => {
    const res = await mkApp().request(`/account/whoami?emit=${B.organizationId}`, { headers: userHeaders(A, null) })
    expect(res.status).toBe(200)
    const ev = await owner.selectFrom('events').selectAll().execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ organization_id: B.organizationId, actor_id: A.userId })
  })
  it('a tenant op needs an organisation', async () => {
    const res = await mkApp().request('/tasks', { headers: userHeaders(A, null) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { code: 'organization_required', message: 'an organisation is required (sign in with an active organisation)' },
    })
  })
})

describe('errors', () => {
  it('masks unexpected errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(mkApp(), '/probe/boom')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } })
    expect(text).not.toContain('secret detail')
    expect(err).toHaveBeenCalled()
    expect(err.mock.calls[0]!.some((a) => a instanceof Error && a.message === 'secret detail')).toBe(true)
  })
  it('unknown routes are 404', async () => {
    const app = mkApp()
    for (const [m, p] of [['GET', '/nope'], ['PUT', '/tasks']]) {
      const res = await app.request(p!, { method: m, headers: agentHeaders() })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'no such route' } })
    }
  })
})

describe('per-request database', () => {
  it('resolves the db on every request, not at construction', async () => {
    const resolver = vi.fn(() => db)
    const app = mkApp(resolver)
    expect(resolver).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) await app.request('/tasks', { headers: agentHeaders() })
    expect(resolver).toHaveBeenCalledTimes(3)
  })
  it('two apps use their own databases', async () => {
    const other = createTestDb()
    try {
      const rx = vi.fn(() => db)
      const ry = vi.fn(() => other)
      await mkApp(rx).request('/tasks', { headers: agentHeaders() })
      await mkApp(ry).request('/tasks', { headers: agentHeaders() })
      expect(rx).toHaveBeenCalledTimes(1)
      expect(ry).toHaveBeenCalledTimes(1)
    } finally {
      await other.destroy()
    }
  })
})

describe('CORS ([[CORE3]] C4)', () => {
  const ORIGIN = 'https://pane.test.example'
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const preflight = (app: ReturnType<typeof createApp>, origin: string) =>
    app.request('/tasks', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-organization-id',
      },
    })

  it('sends no CORS headers by default', async () => {
    const res = await createApp({ db: () => db }).request('/openapi.json', { headers: { origin: ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers an allowed preflight', async () => {
    const res = await preflight(createApp({ db: () => db, corsOrigins: [ORIGIN] }), ORIGIN)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('x-organization-id')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('does not allow another origin', async () => {
    const res = await preflight(createApp({ db: () => db, corsOrigins: [ORIGIN] }), 'https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows an extension origin', async () => {
    const res = await preflight(createApp({ db: () => db, corsOrigins: [EXT] }), EXT)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT)
  })
})

describe('auth options and the account context ([[CORE3]])', () => {
  it('refuses both userAuthenticator and authAdapter', () => {
    expect(() =>
      createApp({
        db: () => db,
        userAuthenticator: fakeUserAuthenticator(),
        authAdapter: {
          provider: 'x',
          verify: async () => ({ ok: false, reason: 'malformed' }),
          fetchProfile: async () => ({ email: null, emailVerified: false, name: null }),
          fetchOrganization: async () => null,
          listMembers: async () => [],
          parseWebhook: async () => ({ ok: false, reason: 'headers' }),
        },
      }),
    ).toThrow()
  })

  it('an account operation sees the resolved organisation and scopes', async () => {
    const registry = new Registry().register({
      kind: 'account',
      name: 'probe.ctx',
      summary: 'Context',
      method: 'get',
      path: '/probe/ctx',
      response: { status: 200, schema: z.object({ org: z.string().nullable(), scopes: z.array(z.string()) }) },
      handler: async (ctx) => ({ org: ctx.organizationId, scopes: ctx.scopes.toStrings() }),
    })
    const app = createApp({ db: () => db, registry, userAuthenticator: fakeUserAuthenticator() })
    const withOrg = await app.request('/probe/ctx', { headers: userHeaders(A) })
    expect(await withOrg.json()).toEqual({ org: A.organizationId, scopes: ['tasks:read', 'tasks:write'] })
    const without = await app.request('/probe/ctx', { headers: userHeaders(A, null) })
    expect(await without.json()).toEqual({ org: null, scopes: [] })
  })
})
