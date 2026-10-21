import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { Registry } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { createApp } from '../rest/app.js'
import { ScopeSet, parseScope } from '../scopes.js'
import { seedApiKey } from '../test/keys.js'
import { seedTenant, type Tenant } from '../test/tenant.js'
import { AuthFailure } from './adapter.js'
import type { Principal, UserAuthenticator } from './types.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let A: Tenant
let B: Tenant
let agentA: { id: string; key: string; keyId: string }
const authenticate = vi.fn<UserAuthenticator['authenticate']>()

const whoamiRegistry = () =>
  new Registry().registerResource(tasks).register({
    kind: 'tenant',
    name: 'probe.whoami',
    summary: 'Who am I',
    method: 'get',
    path: '/probe/whoami',
    scope: parseScope('tasks:read'),
    response: { status: 200, schema: z.object({ actor_id: z.string(), kind: z.string(), organization_id: z.string() }) },
    handler: async (ctx) => ({ actor_id: ctx.actor.id, kind: ctx.actor.kind, organization_id: ctx.organizationId }),
  })

const mkApp = (withAuth = true) =>
  createApp({ db: () => db, registry: whoamiRegistry(), userAuthenticator: withAuth ? { authenticate } : undefined })
const get = (app: ReturnType<typeof mkApp>, path: string, headers: Record<string, string> = {}) => app.request(path, { headers })
const bearer = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra })

async function newAgentKey(t: Tenant, scopes: string[], opts: { expiresAt?: Date; revoked?: boolean } = {}) {
  const agent = await seedAgent(db, { organizationId: t.organizationId, createdBy: t.userId, scopes })
  const k = await seedApiKey(db, { organizationId: t.organizationId, agentId: agent.id, createdBy: t.userId, ...opts })
  return { id: agent.id, key: k.key, keyId: k.id }
}

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
  authenticate.mockReset()
  await truncateAll(owner)
  A = await seedTenant(db, 'A')
  B = await seedTenant(db, 'B')
  agentA = await newAgentKey(A, ['tasks:read', 'tasks:write'])
})

describe('api key auth', () => {
  it('a valid key resolves the agent', async () => {
    const res = await get(mkApp(), '/probe/whoami', bearer(agentA.key))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ actor_id: agentA.id, kind: 'agent', organization_id: A.organizationId })
  })

  it.each([
    ['no header', {}],
    ['wrong scheme', { authorization: 'Basic x' }],
    ['empty token', { authorization: 'Bearer ' }],
  ])('%s is 401', async (_n, headers) => {
    const res = await get(mkApp(), '/tasks', headers)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthenticated')
  })

  it('an unknown key is 401 with the shared message', async () => {
    const res = await get(mkApp(), '/tasks', bearer('vk_' + randomBytes(32).toString('base64url')))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'invalid or expired credentials' } })
  })

  it('a revoked key is 401', async () => {
    const k = await newAgentKey(A, ['tasks:read'], { revoked: true })
    expect((await get(mkApp(), '/tasks', bearer(k.key))).status).toBe(401)
  })

  it('expired is 401, future expiry is 200', async () => {
    const past = await newAgentKey(A, ['tasks:read'], { expiresAt: new Date(Date.now() - 1000) })
    const future = await newAgentKey(A, ['tasks:read'], { expiresAt: new Date(Date.now() + 3_600_000) })
    expect((await get(mkApp(), '/tasks', bearer(past.key))).status).toBe(401)
    expect((await get(mkApp(), '/tasks', bearer(future.key))).status).toBe(200)
  })

  it('a disabled agent is 401', async () => {
    await withServiceRole(db, (trx) => trx.updateTable('agents').set({ disabled_at: new Date() }).where('id', '=', agentA.id).execute())
    expect((await get(mkApp(), '/tasks', bearer(agentA.key))).status).toBe(401)
  })

  it('scopes come from the agent', async () => {
    const k = await newAgentKey(A, ['tasks:read'])
    const app = mkApp()
    const post = await app.request('/tasks', { method: 'POST', headers: bearer(k.key), body: JSON.stringify({ title: 'x' }) })
    expect(post.status).toBe(403)
    expect(await post.json()).toEqual({ error: { code: 'insufficient_scope', message: 'requires tasks:write' } })
    expect((await get(app, '/tasks', bearer(k.key))).status).toBe(200)
  })

  it('last_used_at is set once a minute', async () => {
    const read = async () => (await owner.selectFrom('api_keys').select('last_used_at').where('id', '=', agentA.keyId).executeTakeFirstOrThrow()).last_used_at
    expect(await read()).toBeNull()
    const app = mkApp()
    await get(app, '/tasks', bearer(agentA.key))
    const first = await read()
    expect(first).not.toBeNull()
    await get(app, '/tasks', bearer(agentA.key))
    expect((await read())!.getTime()).toBe(first!.getTime())
  })

  it('checks the agent X-Organization-Id header', async () => {
    const app = mkApp()
    expect((await get(app, '/tasks', bearer(agentA.key, { 'x-organization-id': A.organizationId }))).status).toBe(200)
    for (const v of [B.organizationId, 'not-a-uuid']) {
      const res = await get(app, '/tasks', bearer(agentA.key, { 'x-organization-id': v }))
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('organization_forbidden')
    }
  })
})

describe('credential dispatch', () => {
  it('a JWT-shaped token goes to the user authenticator', async () => {
    const principal: Principal = {
      actor: { id: A.userId, kind: 'user' },
      organizationId: A.organizationId,
      scopes: ScopeSet.parse(['tasks:read']),
    }
    authenticate.mockResolvedValue(principal)
    const res = await get(mkApp(), '/probe/whoami', bearer('a.b.c', { 'x-organization-id': A.organizationId }))
    expect(res.status).toBe(200)
    expect((await res.json()).kind).toBe('user')
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(authenticate).toHaveBeenCalledWith('a.b.c', { db, organizationHeader: A.organizationId })
  })

  it('a key-shaped token never reaches the authenticator', async () => {
    await get(mkApp(), '/tasks', bearer(agentA.key))
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('without an authenticator a JWT-shaped token is 401', async () => {
    const res = await get(mkApp(false), '/tasks', bearer('a.b.c'))
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthenticated')
  })

  it('authenticator errors pass through', async () => {
    authenticate.mockRejectedValue(new ApiError(409, 'account_conflict', 'x'))
    const res = await get(mkApp(), '/tasks', bearer('a.b.c'))
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('account_conflict')
  })
})

describe('logging and plain routes', () => {
  it('never logs the key', async () => {
    const k = await newAgentKey(A, ['tasks:read'], { revoked: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await get(mkApp(), '/tasks', bearer(k.key))
    expect(warn).toHaveBeenCalledTimes(1)
    const args = warn.mock.calls[0]!
    expect(JSON.stringify(args)).not.toContain(k.key)
    expect((args[3] as { prefix: string }).prefix.length).toBeLessThanOrEqual(8)
  })

  it('plain routes skip auth', async () => {
    const app = mkApp()
    app.get('/plain', (c) => c.text('ok'))
    const res = await get(app, '/plain')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('bearer scheme ([[CORE3]] C11)', () => {
  it.each([['bearer'], ['BEARER'], ['Bearer  ']])('scheme %j is accepted', async (scheme) => {
    const res = await get(mkApp(), '/tasks', { authorization: `${scheme}${scheme.endsWith(' ') ? '' : ' '}${agentA.key}` })
    expect(res.status).toBe(200)
  })

  it('accepts several spaces', async () => {
    expect((await get(mkApp(), '/tasks', { authorization: `BEARER   ${agentA.key}` })).status).toBe(200)
  })

  it.each([['Basic x'], ['KEYALONE'], ['Bearer']])('%j is missing credentials', async (value) => {
    const res = await get(mkApp(), '/tasks', { authorization: value })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toBe('missing bearer credentials')
  })

  it('an agent X-Organization-Id compares case-insensitively', async () => {
    const res = await get(mkApp(), '/tasks', bearer(agentA.key, { 'x-organization-id': A.organizationId.toUpperCase() }))
    expect(res.status).toBe(200)
  })
})

describe('user authenticator failures ([[CORE3]] C11)', () => {
  it('a 401 is logged once with prefix and reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    authenticate.mockRejectedValue(new AuthFailure('expired'))
    const token = 'aaaaaaaaaaaa.b.c'
    const res = await get(mkApp(), '/tasks', bearer(token))
    expect(res.status).toBe(401)
    expect(warn).toHaveBeenCalledTimes(1)
    const args = warn.mock.calls[0]!
    expect(args[0]).toBe('[auth] 401')
    expect(args[3]).toEqual({ credentials: true, prefix: 'aaaaaaaa', reason: 'expired' })
    expect(JSON.stringify(args)).not.toContain(token)
  })

  it('a 409 is not logged by the middleware', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    authenticate.mockRejectedValue(new ApiError(409, 'account_conflict', 'x'))
    const res = await get(mkApp(), '/tasks', bearer('a.b.c'))
    expect(res.status).toBe(409)
    expect(warn).not.toHaveBeenCalled()
  })

  const forbidden: Principal = { actor: { id: '', kind: 'user' }, organizationId: null, scopes: ScopeSet.parse([]), organizationForbidden: true }

  it('the forbidden flag is 403 on a tenant route', async () => {
    authenticate.mockResolvedValue({ ...forbidden, actor: { id: A.userId, kind: 'user' } })
    const res = await get(mkApp(), '/tasks', bearer('a.b.c'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'organization_forbidden', message: 'not a member of that organisation' } })
  })

  it('the forbidden flag is ignored on an account route', async () => {
    authenticate.mockResolvedValue({ ...forbidden, actor: { id: A.userId, kind: 'user' } })
    const registry = new Registry().register({
      kind: 'account',
      name: 'probe.acct',
      summary: 'Account probe',
      method: 'get',
      path: '/probe/acct',
      response: { status: 200, schema: z.object({ ok: z.boolean() }) },
      handler: async () => ({ ok: true }),
    })
    const app = createApp({ db: () => db, registry, userAuthenticator: { authenticate } })
    expect((await get(app, '/probe/acct', bearer('a.b.c'))).status).toBe(200)
  })
})
