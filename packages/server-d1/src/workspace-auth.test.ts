import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { createVibaseRegistry, scopesForRole } from '@vibase/api'
import { mintClerkToken, orgClaim } from '@vibase/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { initDeploymentOperation } from './init-deployment.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[CORE64]] cycle 1: workspace sign-in on D1. A Clerk session token's `vibase_role` claim is the only authority; the vault
// keeps no membership state and reads no organisation claim.

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
})

const BASE = 'https://w.test'
const declared = createVibaseRegistry().declaredScopes()
type Res = { status: number; json: any }

/** A workspace deployment written directly (marker and organisation), independent of the bootstrap CLI's code. */
async function initWorkspace(): Promise<{ organizationId: string }> {
  const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
  await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
  const at = NOW.toISOString()
  await w.d1
    .prepare('insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)')
    .bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId)
    .run()
  return link
}

const worker = (extra: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ...extra }, { fetch: kit.fetch })
const token = (sub: string, extra: Record<string, unknown> = {}, opts: Parameters<typeof mintClerkToken>[1] = {}) => mintClerkToken(kit.issuer, { sub, extra, ...opts })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, tok: string, body?: unknown): Promise<Res> => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const profile = (sub: string, email = `${sub}@x.test`) => kit.profiles.set(sub, clerkUser({ id: sub, email, verified: true }))
const count = async (t: string) => Number(((await w.d1.prepare(`select count(*) n from "${t}"`).first()) as { n: number }).n)
const state = async () => ({ users: await count('users'), principals: await count('principals'), events: await count('events'), memberships: await count('memberships') })
const meSchema = () => (createVibaseRegistry().operations().find((o) => o.name === 'me.get') as { response: { schema: { parse(v: unknown): unknown } } }).response.schema

describe('the role claim admits a user (D8, D9)', () => {
  it.each(['owner', 'member'] as const)('vibase_role %s resolves to a user of the deployment organisation with the role scopes', async (role) => {
    const org = await initWorkspace()
    profile('user_a')
    const wk = worker()
    const me = await call(wk, 'GET', '/meta/v1/me', await token('user_a', { vibase_role: role }))
    expect(me.status).toBe(200)
    expect(me.json.principal).toEqual({ id: me.json.user.id, kind: 'user' })
    expect(me.json.user).toMatchObject({ email: 'user_a@x.test', email_verified: true })
    expect(me.json.agent).toBeNull()
    expect(me.json.client_id).toBeNull()
    expect(me.json.memberships).toEqual([{ organization_id: org.organizationId, organization_name: 'Acme', role }])
    expect(me.json.active_organization).toEqual({ id: org.organizationId, role, scopes: scopesForRole(role, declared).toStrings() })
    expect(() => meSchema().parse(me.json)).not.toThrow()
    const list = await call(wk, 'GET', '/api/v1/contacts', await token('user_a', { vibase_role: role }))
    expect(list.status).toBe(200)
  })

  it('an owner writes a record and the event is attributed to that user', async () => {
    await initWorkspace()
    profile('user_a')
    const wk = worker()
    const created = await call(wk, 'POST', '/api/v1/contacts', await token('user_a', { vibase_role: 'owner' }), { name: 'Ada' })
    expect(created.status).toBe(201)
    const [ev] = (await w.d1.prepare("select actor_id from events where type = 'contact.created'").all()).results as Array<{ actor_id: string }>
    const user = (await w.d1.prepare("select id from users where auth_subject = 'user_a'").first()) as { id: string }
    expect(ev!.actor_id).toBe(user.id)
  })

  it('a member holds member scopes only: an owner-only operation is 403 insufficient_scope', async () => {
    await initWorkspace()
    profile('user_b')
    const wk = worker()
    const tok = await token('user_b', { vibase_role: 'member' })
    expect((await call(wk, 'POST', '/api/v1/contacts', tok, { name: 'Bo' })).status).toBe(201)
    const denied = await call(wk, 'POST', '/meta/v1/api-keys', tok, { agent_id: uuidv7(NOW) })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('insufficient_scope')
  })
})

describe('a token without an admissible role admits nothing (D9)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no role', {}],
    ['an unknown role', { vibase_role: 'admin' }],
    ['a non-string role', { vibase_role: 7 }],
  ]
  it.each(cases)('%s is 403 organization_forbidden on an /api/v1 operation and on /meta/v1/me, and writes nothing', async (_n, extra) => {
    await initWorkspace()
    profile('user_c')
    const wk = worker()
    const before = await state()
    for (const path of ['/api/v1/contacts', '/meta/v1/me']) {
      const res = await call(wk, 'GET', path, await token('user_c', extra))
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('organization_forbidden')
    }
    expect(await state()).toEqual(before)
    expect(kit.fetch.calls).toEqual([])
  })

  it('logs the refusal once per request and never the claim value', async () => {
    await initWorkspace()
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    await call(worker(), 'GET', '/meta/v1/me', await token('user_c', { vibase_role: 'SECRET_ROLE_VALUE' }))
    const lines = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
    spies.forEach((s) => s.mockRestore())
    expect(lines.filter((l) => l.includes('[auth]'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('SECRET_ROLE_VALUE')
  })
})

describe('the role is read on every request (D10)', () => {
  it('the same subject is owner, then member, then refused: no stored role survives', async () => {
    await initWorkspace()
    profile('user_a')
    const wk = worker()
    const ownerOnly = (tok: string) => call(wk, 'POST', '/meta/v1/api-keys', tok, { agent_id: uuidv7(NOW) })
    const asOwner = await ownerOnly(await token('user_a', { vibase_role: 'owner' }))
    expect(asOwner.status).not.toBe(403) // admitted: the unknown agent is a 400, not a scope refusal
    const asMember = await ownerOnly(await token('user_a', { vibase_role: 'member' }))
    expect(asMember.status).toBe(403)
    expect(asMember.json.error.code).toBe('insufficient_scope')
    const none = await call(wk, 'GET', '/api/v1/contacts', await token('user_a'))
    expect(none.status).toBe(403)
    expect(none.json.error.code).toBe('organization_forbidden')
    // a known subject after refusal and a fresh role is admitted again
    expect((await call(wk, 'GET', '/api/v1/contacts', await token('user_a', { vibase_role: 'member' }))).status).toBe(200)
  })

  it('the vault holds no membership state: no rows, no membership event', async () => {
    await initWorkspace()
    profile('user_a')
    profile('user_b')
    const wk = worker()
    await call(wk, 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))
    await call(wk, 'GET', '/meta/v1/me', await token('user_b', { vibase_role: 'member' }))
    expect(await count('memberships')).toBe(0)
    expect(await count('users')).toBe(2)
    const kinds = (await w.d1.prepare("select type from events where type like 'membership%' or resource_type = 'membership'").all()).results
    expect(kinds).toEqual([])
    expect(await count('events')).toBe(0)
  })
})

describe('AUTH_ROLE_CLAIM (D8)', () => {
  it('reads the configured claim and ignores the default claim', async () => {
    await initWorkspace()
    profile('user_a')
    const wk = worker({ AUTH_ROLE_CLAIM: 'acme_role' })
    const custom = await call(wk, 'GET', '/meta/v1/me', await token('user_a', { acme_role: 'member' }))
    expect(custom.status).toBe(200)
    expect(custom.json.active_organization.role).toBe('member')
    const ignored = await call(wk, 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))
    expect(ignored.status).toBe(403)
  })

  it('an empty value fails closed: 500 internal, the variable named in the log', async () => {
    await initWorkspace()
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const res = await call(worker({ AUTH_ROLE_CLAIM: '  ' }), 'GET', '/api/v1/contacts', 'vk_x')
    const lines = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
    spies.forEach((s) => s.mockRestore())
    expect(res.status).toBe(500)
    expect(lines.filter((l) => l.includes('AUTH_ROLE_CLAIM'))).toHaveLength(1)
  })
})

describe('the organisation claim and the authorised party (D24, CORE3)', () => {
  it('an o claim naming another organisation is accepted and ignored', async () => {
    const org = await initWorkspace()
    profile('user_a')
    const res = await call(worker(), 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner', ...orgClaim('org_elsewhere', 'member') }))
    expect(res.status).toBe(200)
    expect(res.json.active_organization).toMatchObject({ id: org.organizationId, role: 'owner' })
  })

  it('a foreign azp is still 401', async () => {
    await initWorkspace()
    profile('user_a')
    const res = await call(worker(), 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }, { azp: 'https://evil.example' }))
    expect(res.status).toBe(401)
    expect(await count('users')).toBe(0)
  })
})

describe('CLERK_AUTHORIZED_PARTIES is optional on D1 (D8)', () => {
  it('unset: composes, a token without azp is admitted and a token with any azp is 401', async () => {
    await initWorkspace()
    profile('user_a')
    const wk = worker({ CLERK_AUTHORIZED_PARTIES: undefined })
    const noAzp = await token('user_a', { vibase_role: 'owner' }, { azp: undefined })
    expect((await call(wk, 'GET', '/meta/v1/me', noAzp)).status).toBe(200)
    expect((await call(wk, 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))).status).toBe(401)
  })
})

describe('composition (D24)', () => {
  it('composes with AUTH_PROVIDER=clerk and no CLERK_WEBHOOK_SECRET, and /webhooks/clerk is 404', async () => {
    await initWorkspace()
    profile('user_a')
    const wk = worker()
    expect((await call(wk, 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))).status).toBe(200)
    const hook = await wk.fetch(new Request(BASE + '/webhooks/clerk', { method: 'POST', body: '{}' }))
    expect(hook.status).toBe(404)
  })

  it('a webhook secret that is set is not read: /webhooks/clerk stays 404', async () => {
    await initWorkspace()
    const hook = await worker({ CLERK_WEBHOOK_SECRET: 'not-a-whsec' }).fetch(new Request(BASE + '/webhooks/clerk', { method: 'POST', body: '{}' }))
    expect(hook.status).toBe(404)
  })

  it('a missing CLERK_JWT_KEY still fails closed: 500, the variable named, no value logged', async () => {
    await initWorkspace()
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const res = await call(worker({ CLERK_JWT_KEY: undefined, CLERK_SECRET_KEY: 'sk_test_THE_SECRET_VALUE' }), 'GET', '/meta/v1/me', 'vk_x')
    const lines = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
    spies.forEach((s) => s.mockRestore())
    expect(res.status).toBe(500)
    expect(lines.filter((l) => l.includes('CLERK_JWT_KEY'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('sk_test_THE_SECRET_VALUE')
  })

  it.each([
    ['literal \\n escapes', (pem: string) => pem.replace(/\n/g, '\\n')],
    ['surrounding double quotes', (pem: string) => `"${pem.replace(/\n/g, '\\n')}"`],
  ])('CLERK_JWT_KEY as a single-line PEM with %s verifies', async (_n, shape) => {
    await initWorkspace()
    profile('user_a')
    const res = await call(worker({ CLERK_JWT_KEY: shape(kit.issuer.pem) }), 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))
    expect(res.status).toBe(200)
  })
})

describe('me.get for an API-key agent (spec me.get)', () => {
  it('answers with the agent, no user, no memberships and no role', async () => {
    const org = await initWorkspace()
    const at = NOW.toISOString()
    const agentId = uuidv7(NOW)
    const sys = uuidv7(NOW)
    await w.d1.prepare("insert into principals (id, kind, created_at) values (?, 'system', ?)").bind(sys, at).run()
    await w.d1.prepare("insert into principals (id, kind, created_at) values (?, 'agent', ?)").bind(agentId, at).run()
    await w.d1
      .prepare('insert into agents (id, created_at, updated_at, organization_id, name, scopes, created_by) values (?, ?, ?, ?, ?, ?, ?)')
      .bind(agentId, at, at, org.organizationId, 'operator', JSON.stringify(['tasks:read']), sys)
      .run()
    const { generateApiKey } = await import('@vibase/api')
    const secret = await generateApiKey((n) => crypto.getRandomValues(new Uint8Array(n)))
    await w.d1
      .prepare('insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uuidv7(NOW), at, at, org.organizationId, agentId, secret.hash, secret.prefix, sys)
      .run()
    const res = await call(worker({ AUTH_PROVIDER: '' }), 'GET', '/meta/v1/me', secret.key)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      principal: { id: agentId, kind: 'agent' },
      user: null,
      agent: { id: agentId, name: 'operator', delegated_by: null, auth_client_id: null, auth_subject: null },
      client_id: null,
      memberships: [],
      active_organization: { id: org.organizationId, role: null, scopes: ['tasks:read'] },
    })
    expect(() => meSchema().parse(res.json)).not.toThrow()
  })
})

describe('bootstrap on a Clerk-backed D1 (D11)', () => {
  const env = () => ({ now: NOW, newId: () => uuidv7(NOW) })
  const rows = async (t: string) => (await w.d1.prepare(`select * from "${t}"`).all()).results as Array<Record<string, any>>
  const opts = { organizationName: 'Acme', agentName: 'operator', authOrgId: 'https://clerk.test.example' }

  it('writes the marker, the organisation and the agent with its key, and no human', async () => {
    const r = await bootstrapD1(w.d1, opts, env())
    expect(r).toMatchObject({ deployment: 'created', userId: null })
    expect(r.key).toMatch(/^vk_/)
    expect(await rows('deployment')).toMatchObject([{ organization_id: r.organizationId, auth_provider: 'clerk', auth_org_id: opts.authOrgId }])
    expect(await rows('organizations')).toMatchObject([{ id: r.organizationId, name: 'Acme', auth_provider: 'clerk', auth_org_id: opts.authOrgId }])
    expect(await rows('users')).toEqual([])
    expect(await rows('memberships')).toEqual([])
    expect(await rows('events')).toEqual([])
    const [system] = await rows('principals').then((p) => p.filter((x) => x.kind === 'system'))
    expect(system).toBeDefined()
    expect(await rows('agents')).toMatchObject([{ id: r.agentId, created_by: system!.id }])
    expect(await rows('api_keys')).toMatchObject([{ id: r.apiKeyId, agent_id: r.agentId, created_by: system!.id }])
  })

  it('the agent is optional: without one only the marker and the organisation are written', async () => {
    const r = await bootstrapD1(w.d1, { organizationName: 'Acme', authOrgId: opts.authOrgId }, env())
    expect(r).toMatchObject({ userId: null, agentId: null, apiKeyId: null, key: null })
    expect(await rows('organizations')).toHaveLength(1)
    expect(await rows('agents')).toEqual([])
    expect(await rows('api_keys')).toEqual([])
  })

  it('a user who signs in afterwards with owner is admitted', async () => {
    await bootstrapD1(w.d1, { ...opts, authOrgId: kit.issuer.issuer }, env())
    profile('user_a')
    const res = await call(worker(), 'GET', '/meta/v1/me', await token('user_a', { vibase_role: 'owner' }))
    expect(res.status).toBe(200)
    expect(res.json.memberships[0]).toMatchObject({ organization_name: 'Acme', role: 'owner' })
  })

  it('running again on an initialised organisation is refused and writes nothing', async () => {
    const first = await bootstrapD1(w.d1, opts, env())
    const before = { orgs: (await rows('organizations')).length, agents: (await rows('agents')).length, keys: (await rows('api_keys')).length }
    const again = await bootstrapD1(w.d1, opts, env()).catch((e: Error) => e)
    expect(again).toBeInstanceOf(Error)
    expect((again as Error).message).toContain(`organization ${first.organizationId} is already initialised`)
    expect({ orgs: (await rows('organizations')).length, agents: (await rows('agents')).length, keys: (await rows('api_keys')).length }).toEqual(before)
  })

  it('a Clerk-path marker-only crash resumes: the organisation and agent are written, no human', async () => {
    const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: opts.authOrgId }
    await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const r = await bootstrapD1(w.d1, opts, env())
    expect(r.deployment).toBe('existing')
    expect(r.organizationId).toBe(link.organizationId)
    expect(await rows('organizations')).toHaveLength(1)
    expect(await rows('agents')).toHaveLength(1)
    expect(await rows('users')).toEqual([])
  })

  it.each([
    ['a none marker and the Clerk path (the path check)', 'none', {} as Record<string, unknown>, /the marker's provider is none/],
    ['a clerk marker and an explicit none path (the existing link check)', 'clerk', { authProvider: 'none', email: 'o@x.test' }, /deployment is already initialised/],
  ])('%s: refused, rows unchanged', async (_n, markerProvider, over, message) => {
    const link = { organizationId: uuidv7(NOW), authProvider: markerProvider, authOrgId: opts.authOrgId }
    await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const tables = ['deployment', 'organizations', 'users', 'principals', 'agents', 'api_keys', 'events']
    const counts = async () => Promise.all(tables.map(async (t) => (await rows(t)).length))
    const before = await counts()
    await expect(bootstrapD1(w.d1, { ...opts, ...over }, env())).rejects.toThrow(message)
    expect(await counts()).toEqual(before)
  })

  it('refuses a human on the Clerk path', async () => {
    await expect(bootstrapD1(w.d1, { ...opts, email: 'o@x.test' }, env())).rejects.toThrow(/creates no human/)
    await expect(bootstrapD1(w.d1, { ...opts, authSubject: 'user_x' }, env())).rejects.toThrow(/creates no human/)
    expect(await rows('deployment')).toEqual([])
  })

  it('the none path still creates its user and owner membership', async () => {
    const r = await bootstrapD1(w.d1, { organizationName: 'smoked1', email: 'op@x.test', agentName: 'operator', authProvider: 'none', authOrgId: 'smoked1' }, env())
    expect(await rows('users')).toMatchObject([{ id: r.userId, email: 'op@x.test' }])
    expect(await rows('memberships')).toMatchObject([{ user_id: r.userId, role: 'owner' }])
  })
})
