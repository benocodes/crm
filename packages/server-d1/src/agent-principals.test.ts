import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { SCOPE_POLICY, createVibaseRegistry, createWorkspaceAuthAdapter, createWorkspaceAuthenticator, grantableScopes, scopesForRole, type ScopePolicy } from '@vibase/api'
import { mintClerkToken, mintOAuthToken } from '@vibase/api/test/clerk'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { initDeploymentOperation } from './init-deployment.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, spyD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[CORE64]] cycle 2 ([[CORE77]]): agent principals from Clerk OAuth access tokens on D1 (D12-D18, D23). A fake Backend API, locally
// minted tokens, no network.

let w: WorkerD1
let kit: ClerkKit
let clock: Date
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  kit.fetch.reset()
  kit.profiles.clear()
  kit.clients.clear()
  clock = new Date()
})

const BASE = 'https://w.test'
const CLI = 'client_cli'
const DCR = 'client_dcr'
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
type Res = { status: number; json: any }

async function initWorkspace(): Promise<{ organizationId: string; authProvider: string; authOrgId: string }> {
  const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
  await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
  const at = NOW.toISOString()
  await w.d1
    .prepare('insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)')
    .bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId)
    .run()
  return link
}

const worker = (extra: Partial<D1WorkerEnv> = {}, db = w.d1) =>
  composeD1Worker({ DB: db, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI, ...extra }, { fetch: kit.fetch, clock: () => clock })
const session = (sub: string, role?: unknown) => mintClerkToken(kit.issuer, { sub, extra: role === undefined ? {} : { vibase_role: role }, now: clock })
const oauth = (sub: string, clientId: string, scope: string | string[]) => mintOAuthToken(kit.issuer, { sub, clientId, scope, now: clock })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, tok: string, body?: unknown): Promise<Res> => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const profile = (sub: string, role: unknown, extra: { email?: string | null; first?: string | null; last?: string | null } = {}) =>
  kit.profiles.set(sub, clerkUser({ id: sub, email: extra.email === undefined ? `${sub}@x.test` : extra.email, verified: true, role, first: extra.first, last: extra.last }))
const rows = async (sqlText: string, ...binds: unknown[]) => (await w.d1.prepare(sqlText).bind(...binds).all()).results as Array<Record<string, any>>
const count = async (t: string) => Number(((await w.d1.prepare(`select count(*) n from "${t}"`).first()) as { n: number }).n)
const state = async () => ({ users: await count('users'), principals: await count('principals'), agents: await count('agents'), events: await count('events') })
const userFetches = (sub: string) => kit.fetch.calls.filter((c) => c.url.endsWith(`/v1/users/${sub}`)).length
const meSchema = () => (createVibaseRegistry().operations().find((o) => o.name === 'me.get') as { response: { schema: { parse(v: unknown): unknown } } }).response.schema
const ALL = grantable.join(' ')

describe('the profile cache (D12)', () => {
  it('one Backend fetch per subject within 60 s, a fresh one after it', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    for (let i = 0; i < 3; i++) expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))).status).toBe(200)
    expect(userFetches('user_a')).toBe(1)
    clock = new Date(clock.getTime() + 59_000)
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))).status).toBe(200)
    expect(userFetches('user_a')).toBe(1)
    clock = new Date(clock.getTime() + 2_000)
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))).status).toBe(200)
    expect(userFetches('user_a')).toBe(2)
  })

  it('a role change in Clerk is seen after the cache life, not before', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    const tok = () => oauth('user_a', CLI, 'agents:write contacts:read')
    expect((await call(wk, 'POST', '/meta/v1/agents', await tok(), { name: 'x' })).status).toBe(201)
    profile('user_a', 'member')
    expect((await call(wk, 'POST', '/meta/v1/agents', await tok(), { name: 'y' })).status).toBe(201)
    clock = new Date(clock.getTime() + 61_000)
    const denied = await call(wk, 'POST', '/meta/v1/agents', await tok(), { name: 'z' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('insufficient_scope')
  })

  it('an unseen subject fetches: the cache starts empty', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    expect(userFetches('user_a')).toBe(0)
    await call(worker(), 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))
    expect(userFetches('user_a')).toBe(1)
  })

  it('a 404 is 403 organization_forbidden, cached as a refusal, and writes nothing', async () => {
    await initWorkspace()
    const wk = worker()
    const before = await state()
    for (let i = 0; i < 2; i++) {
      const res = await call(wk, 'GET', '/meta/v1/me', await oauth('user_gone', CLI, 'contacts:read'))
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('organization_forbidden')
    }
    expect(userFetches('user_gone')).toBe(1)
    expect(await state()).toEqual(before)
    clock = new Date(clock.getTime() + 61_000)
    await call(wk, 'GET', '/meta/v1/me', await oauth('user_gone', CLI, 'contacts:read'))
    expect(userFetches('user_gone')).toBe(2)
  })

  it('a Backend failure other than 404 is not cached and is not a refusal of the person', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    const failing = ((input: RequestInfo | URL) => Promise.resolve(new Response('{}', { status: 500, headers: { 'x-url': String(input) } }))) as typeof fetch
    const broken = composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI }, { fetch: failing, clock: () => clock })
    expect((await call(broken, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))).status).toBe(500)
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))).status).toBe(200)
  })
})

describe('the first-party CLI is the human (D14, D16)', () => {
  it.each(['owner', 'member'] as const)('%s: a user principal with role scopes intersected with the token scopes, client_id set', async (role) => {
    await initWorkspace()
    profile('user_a', role)
    const wk = worker()
    const me = await call(wk, 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read contacts:write agents:read agents:write'))
    expect(me.status).toBe(200)
    expect(me.json.principal.kind).toBe('user')
    expect(me.json.client_id).toBe(CLI)
    // [[AGT8]] D31: the effective set is closed under write => request_approval, so contacts:write brings contacts:request_approval (agents has none).
    const want = scopesForRole(role, declared)
      .toStrings()
      .filter((s) => ['contacts:read', 'contacts:write', 'contacts:request_approval', 'agents:read', 'agents:write'].includes(s))
    expect(me.json.active_organization).toMatchObject({ role, scopes: want.sort() })
    expect(await count('agents')).toBe(0)
    expect(() => meSchema().parse(me.json)).not.toThrow()
  })

  it('a scope the role holds but the token lacks is 403 insufficient_scope; a scope in both is admitted', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    const tok = await oauth('user_a', CLI, 'contacts:read contacts:write')
    const ok = await call(wk, 'POST', '/api/v1/contacts', tok, { name: 'Ada' })
    expect(ok.status).toBe(201)
    const [ev] = await rows("select actor_id from events where type = 'contact.created'")
    expect(ev!.actor_id).toBe((await rows("select id from users where auth_subject = 'user_a'"))[0]!.id)
    const denied = await call(wk, 'POST', '/api/v1/companies', tok, { name: 'Co' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('insufficient_scope')
  })

  it('the token never widens the role: a member asking for an owner-only scope does not get it', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    const res = await call(worker(), 'POST', '/meta/v1/agents', await oauth('user_b', CLI, 'agents:write'), { name: 'x' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('insufficient_scope')
  })

  it('token scopes pass through fromProviderScope: Clerk\'s own and undeclared strings are dropped (D18)', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const me = await call(worker(), 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'openid offline_access public_metadata profile contacts:read not:declared'))
    expect(me.json.active_organization.scopes).toEqual(['contacts:read'])
  })
})

describe('a delegated agent on first sight (D15)', () => {
  it('creates one agent for (client, human) in one unit, attributed to the human', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    kit.clients.set(DCR, 'Claude Desktop')
    const wk = worker()
    expect(await state()).toEqual({ users: 0, principals: 0, agents: 0, events: 0 })
    const me = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read contacts:write agents:read'))
    expect(me.status).toBe(200)
    const human = (await rows("select id from users where auth_subject = 'user_b'"))[0]!.id
    expect(me.json.principal.kind).toBe('agent')
    expect(me.json.user).toBeNull()
    expect(me.json.client_id).toBe(DCR)
    expect(me.json.agent).toEqual({ id: me.json.principal.id, name: 'Claude Desktop (user_b@x.test)', delegated_by: human, auth_client_id: DCR, auth_subject: null })
    expect(me.json.active_organization).toEqual({ id: expect.any(String), role: null, scopes: ['contacts:read', 'contacts:request_approval', 'contacts:write'] })
    expect(() => meSchema().parse(me.json)).not.toThrow()
    const [agent] = await rows('select * from agents')
    expect(agent).toMatchObject({ id: me.json.principal.id, auth_provider: 'clerk', auth_client_id: DCR, auth_subject: null, delegated_by: human, created_by: human, disabled_at: null })
    expect(JSON.parse(agent!.scopes)).toEqual(grantable)
    const events = await rows("select actor_id, resource_id, type from events where type = 'agent.created'")
    expect(events).toEqual([{ actor_id: human, resource_id: agent!.id, type: 'agent.created' }])
    expect(await rows("select kind from principals where id = ?", agent!.id)).toEqual([{ kind: 'agent' }])
    expect(await count('memberships')).toBe(0)
  })

  it('a second token for the same client and human reuses the agent; another human or client makes another', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    profile('user_c', 'member')
    kit.clients.set(DCR, 'Claude Desktop')
    const wk = worker()
    const first = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))
    const second = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:write'))
    expect(second.json.principal.id).toBe(first.json.principal.id)
    expect(await count('agents')).toBe(1)
    expect(await count('events')).toBe(1 /* agent.created only: first sight of a human writes no event */)
    const other = await call(wk, 'GET', '/meta/v1/me', await oauth('user_c', DCR, 'contacts:read'))
    expect(other.json.principal.id).not.toBe(first.json.principal.id)
    const elsewhere = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', 'client_other', 'contacts:read'))
    expect(elsewhere.json.principal.id).not.toBe(first.json.principal.id)
    expect(await count('agents')).toBe(3)
  })

  it('names the agent by the client id when the client is unknown or its fetch fails: never a refusal', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    const wk = worker()
    const unknown = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', 'client_unknown', 'contacts:read'))
    expect(unknown.status).toBe(200)
    expect(unknown.json.agent.name).toBe('client_unknown (user_b@x.test)')
    kit.clients.set('client_down', 'Down')
    kit.fetch.fail.clients = 500
    const down = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', 'client_down', 'contacts:read'))
    expect(down.status).toBe(200)
    expect(down.json.agent.name).toBe('client_down (user_b@x.test)')
  })

  it('two concurrent first sights make one row (ON CONFLICT, invariant 3)', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    kit.clients.set(DCR, 'Claude Desktop')
    const spy = spyD1(w.d1)
    const wk = worker({}, spy.d1)
    // the human's own first sight first, so the race is over the agent only
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', CLI, 'contacts:read'))).status).toBe(200)
    let other: Res | undefined
    spy.betweenPlanAndCommit(async () => {
      other = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))
    })
    const mine = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))
    expect(other).toBeDefined()
    expect([mine.status, other!.status]).toEqual([200, 200])
    expect(mine.json.principal.id).toBe(other!.json.principal.id)
    expect(await count('agents')).toBe(1)
    expect(await rows("select type from events where type = 'agent.created'")).toHaveLength(1)
    expect(await rows("select id from principals where kind = 'agent'")).toHaveLength(1)
  })

  it('the agents read record carries the four fields (D23)', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    profile('user_b', 'member')
    const wk = worker()
    const delegated = (await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))).json.principal.id
    const human = (await rows("select id from users where auth_subject = 'user_b'"))[0]!.id
    const rec = await call(wk, 'GET', `/meta/v1/agents/${delegated}`, await session('user_a', 'owner'))
    expect(rec.status).toBe(200)
    expect(rec.json).toMatchObject({ auth_provider: 'clerk', auth_client_id: DCR, auth_subject: null, delegated_by: human })
    const listed = await call(wk, 'GET', '/meta/v1/agents', await session('user_a', 'owner'))
    expect(listed.json.data[0]).toHaveProperty('auth_provider')
  })
})

describe('delegated scopes are a four-way intersection (D15)', () => {
  const delegate = async (wk: ReturnType<typeof worker>, human: string, scope: string) => (await call(wk, 'GET', '/meta/v1/me', await oauth(human, DCR, scope))).json

  it('the token term: a scope the token lacks is not effective', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const me = await delegate(worker(), 'user_a', 'contacts:read')
    expect(me.active_organization.scopes).toEqual(['contacts:read'])
  })

  it('the cap term: an owner narrows the agent and a wider token does not undo it', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    const id = (await delegate(wk, 'user_a', 'contacts:read contacts:write')).principal.id
    const patched = await call(wk, 'PATCH', `/meta/v1/agents/${id}`, await session('user_a', 'owner'), { scopes: ['contacts:read'] })
    expect(patched.status).toBe(200)
    const again = await delegate(wk, 'user_a', 'contacts:read contacts:write')
    expect(again.principal.id).toBe(id)
    expect(again.active_organization.scopes).toEqual(['contacts:read'])
    expect((await call(wk, 'POST', '/api/v1/contacts', await oauth('user_a', DCR, 'contacts:read contacts:write'), { name: 'x' })).status).toBe(403)
  })

  it('the grantable term: a human-only scope in the stored cap is never effective', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const wk = worker()
    const id = (await delegate(wk, 'user_a', 'contacts:read')).principal.id
    await w.d1.prepare('update agents set scopes = ? where id = ?').bind(JSON.stringify(['contacts:read', 'agents:write', 'members:read']), id).run()
    const me = await delegate(wk, 'user_a', 'contacts:read agents:write members:read agents:read')
    expect(me.active_organization.scopes).toEqual(['contacts:read'])
    expect((await call(wk, 'POST', '/meta/v1/agents', await oauth('user_a', DCR, 'agents:write'), { name: 'x' })).status).toBe(403)
  })

  it('the role term: a member never delegates a scope the member role lacks (a policy where an agent-grantable scope is owner-only)', async () => {
    await initWorkspace()
    const policy: ScopePolicy = { ...SCOPE_POLICY, 'tasks:write': { member: false, agentGrantable: true } }
    const adapter = createWorkspaceAuthAdapter({ ...kit.env, CLERK_WEBHOOK_SECRET: undefined } as unknown as Record<string, string | undefined>, { fetch: kit.fetch, now: () => clock })!
    const authenticator = createWorkspaceAuthenticator({ adapter, declaredScopes: declared, cliClientId: CLI, policy })
    const link = { organizationId: (await rows('select id from organizations'))[0]!.id as string, authProvider: 'clerk', authOrgId: kit.issuer.issuer }
    const storage = d1Binding(w.d1, link)
    const env = { now: clock, newId: () => uuidv7(clock) }
    profile('user_a', 'owner')
    profile('user_b', 'member')
    const as = async (sub: string) => (await authenticator.authenticate(await oauth(sub, DCR, 'tasks:write contacts:read'), { storage, organizationHeader: undefined, env })).scopes.toStrings()
    expect(await as('user_a')).toEqual(['contacts:read', 'tasks:request_approval', 'tasks:write'])
    // The policy denies a member tasks:write but not tasks:request_approval (D30: each row is its own): the member's delegate may propose, not write.
    expect(await as('user_b')).toEqual(['contacts:read', 'tasks:request_approval'])
  })

  it('a member never delegates an owner-only scope', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    const wk = worker()
    const me = await delegate(wk, 'user_b', 'contacts:read agents:write members:read')
    expect(me.active_organization.scopes).toEqual(['contacts:read'])
    const res = await call(wk, 'POST', '/meta/v1/agents', await oauth('user_b', DCR, 'agents:write'), { name: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('an agent account, role agent (D17)', () => {
  it('first sight writes one agent with auth_subject, attributed to system, with an event and no scopes', async () => {
    await initWorkspace()
    profile('user_g', 'agent', { first: 'Robo', last: 'Tron' })
    const wk = worker()
    const before = await state()
    expect(before).toEqual({ users: 0, principals: 0, agents: 0, events: 0 })
    const me = await call(wk, 'GET', '/meta/v1/me', await oauth('user_g', CLI, 'contacts:read contacts:write'))
    expect(me.status).toBe(200)
    expect(me.json.principal.kind).toBe('agent')
    expect(me.json.agent).toEqual({ id: me.json.principal.id, name: 'Robo Tron', delegated_by: null, auth_client_id: null, auth_subject: 'user_g' })
    expect(me.json.client_id).toBe(CLI)
    expect(me.json.active_organization).toMatchObject({ role: null, scopes: [] })
    expect(me.json.memberships).toEqual([])
    expect(() => meSchema().parse(me.json)).not.toThrow()
    const [system] = await rows("select id from principals where kind = 'system'")
    const [agent] = await rows('select * from agents')
    expect(agent).toMatchObject({ auth_provider: 'clerk', auth_subject: 'user_g', auth_client_id: null, delegated_by: null, created_by: system!.id })
    expect(JSON.parse(agent!.scopes)).toEqual([])
    expect(await rows("select actor_id, type from events")).toEqual([{ actor_id: system!.id, type: 'agent.created' }])
    expect(await count('users')).toBe(0)
    // zero scopes: every operation is 403
    for (const path of ['/api/v1/contacts', '/meta/v1/agents', '/meta/v1/users']) {
      const res = await call(wk, 'GET', path, await oauth('user_g', CLI, ALL))
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('insufficient_scope')
    }
  })

  it('the name falls back to the email, then to the subject, when the profile has no name', async () => {
    await initWorkspace()
    profile('user_g1', 'agent', { first: null, last: null })
    profile('user_g2', 'agent', { first: null, last: null, email: null })
    const wk = worker()
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_g1', CLI, 'contacts:read'))).json.agent.name).toBe('user_g1@x.test')
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_g2', CLI, 'contacts:read'))).json.agent.name).toBe('user_g2')
  })

  it('after agents.update grants scopes: OAuth is grants ∩ token, a session token is the grants; human-only scopes never appear', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    profile('user_g', 'agent')
    const wk = worker()
    const id = (await call(wk, 'GET', '/meta/v1/me', await oauth('user_g', CLI, 'contacts:read'))).json.principal.id
    expect((await call(wk, 'POST', '/api/v1/contacts', await oauth('user_g', CLI, 'contacts:read contacts:write'), { name: 'x' })).status).toBe(403)
    const granted = await call(wk, 'PATCH', `/meta/v1/agents/${id}`, await session('user_a', 'owner'), { scopes: ['contacts:read', 'contacts:write'] })
    expect(granted.status).toBe(200)
    // the same OAuth token now writes; a token naming only the read scope does not
    expect((await call(wk, 'POST', '/api/v1/contacts', await oauth('user_g', CLI, 'contacts:read contacts:write'), { name: 'x' })).status).toBe(201)
    expect((await call(wk, 'POST', '/api/v1/contacts', await oauth('user_g', CLI, 'contacts:read'), { name: 'y' })).status).toBe(403)
    // a session token for the same account resolves to the same agent with the grants
    const sessionMe = await call(wk, 'GET', '/meta/v1/me', await session('user_g', 'agent'))
    expect(sessionMe.json.principal.id).toBe(id)
    expect(sessionMe.json.client_id).toBeNull()
    expect(sessionMe.json.active_organization.scopes).toEqual(['contacts:read', 'contacts:request_approval', 'contacts:write'])
    expect((await call(wk, 'POST', '/api/v1/contacts', await session('user_g', 'agent'), { name: 'z' })).status).toBe(201)
    // human-only scopes in the stored grants are never effective
    await w.d1.prepare('update agents set scopes = ? where id = ?').bind(JSON.stringify(['contacts:read', 'agents:write']), id).run()
    const me = await call(wk, 'GET', '/meta/v1/me', await oauth('user_g', CLI, ALL + ' agents:write members:read'))
    expect(me.json.active_organization.scopes).toEqual(['contacts:read'])
    expect(await count('agents')).toBe(1)
    expect(await count('users')).toBe(1)
  })

  it('a session token for an agent account with no row creates the same agent (replaces the cycle 1 refusal)', async () => {
    await initWorkspace()
    profile('user_g', 'agent')
    const me = await call(worker(), 'GET', '/meta/v1/me', await session('user_g', 'agent'))
    expect(me.status).toBe(200)
    expect(me.json.principal.kind).toBe('agent')
    expect(await count('agents')).toBe(1)
  })

  it('OAuth through the CLI client is still the agent, never a user', async () => {
    await initWorkspace()
    profile('user_g', 'agent')
    const me = await call(worker(), 'GET', '/meta/v1/me', await oauth('user_g', CLI, 'contacts:read'))
    expect(me.json.user).toBeNull()
    expect(me.json.principal.kind).toBe('agent')
  })
})

describe('kinds never convert (D14)', () => {
  it.each([
    ['a session token with role agent', (s: string) => session(s, 'agent')],
    ['an OAuth token, role agent from the profile', (s: string) => oauth(s, DCR, 'contacts:read')],
  ])('a subject with a users row and role agent: %s is 403 organization_forbidden, writing nothing', async (_n, mint) => {
    await initWorkspace()
    profile('user_a', 'owner')
    await call(worker(), 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))
    expect(await count('users')).toBe(1)
    profile('user_a', 'agent')
    clock = new Date(clock.getTime() + 61_000)
    const before = await state()
    const res = await call(worker(), 'GET', '/meta/v1/me', await mint('user_a'))
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('organization_forbidden')
    expect(await state()).toEqual(before)
  })

  it.each(['owner', 'member'] as const)('a subject linked to an agent with role %s is 403 organization_forbidden, writing nothing', async (role) => {
    await initWorkspace()
    profile('user_g', 'agent')
    const wk = worker()
    await call(wk, 'GET', '/meta/v1/me', await oauth('user_g', CLI, 'contacts:read'))
    expect(await count('agents')).toBe(1)
    profile('user_g', role)
    clock = new Date(clock.getTime() + 61_000)
    const before = await state()
    for (const tok of [await oauth('user_g', CLI, 'contacts:read'), await oauth('user_g', DCR, 'contacts:read'), await session('user_g', role)]) {
      const res = await call(wk, 'GET', '/meta/v1/me', tok)
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('organization_forbidden')
    }
    expect(await state()).toEqual(before)
  })
})

describe('refusals write nothing', () => {
  it.each([
    ['an unknown role', 'admin'],
    ['no role', undefined],
    ['a non-string role', 7],
  ])('%s from the profile (OAuth) is 403 and leaves users, agents and events unchanged', async (_n, role) => {
    await initWorkspace()
    profile('user_x', role)
    const before = await state()
    const res = await call(worker(), 'GET', '/meta/v1/me', await oauth('user_x', DCR, 'contacts:read'))
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('organization_forbidden')
    expect(await state()).toEqual(before)
  })

  it('a disabled delegated agent is 401, and a disabled agent account is 401 for both token kinds', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    profile('user_b', 'member')
    profile('user_g', 'agent')
    const wk = worker()
    const delegated = (await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))).json.principal.id
    const account = (await call(wk, 'GET', '/meta/v1/me', await oauth('user_g', CLI, 'contacts:read'))).json.principal.id
    const owner = await session('user_a', 'owner')
    for (const id of [delegated, account]) expect((await call(wk, 'PATCH', `/meta/v1/agents/${id}`, owner, { disabled: true })).status).toBe(200)
    const before = await state()
    for (const tok of [await oauth('user_b', DCR, 'contacts:read'), await oauth('user_g', CLI, 'contacts:read'), await session('user_g', 'agent')]) {
      const res = await call(wk, 'GET', '/meta/v1/me', tok)
      expect(res.status).toBe(401)
      expect(res.json.error.code).toBe('unauthenticated')
    }
    expect(await state()).toEqual(before)
    // re-enabling restores it
    expect((await call(wk, 'PATCH', `/meta/v1/agents/${delegated}`, owner, { disabled: false })).status).toBe(200)
    expect((await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'contacts:read'))).status).toBe(200)
  })

  it('a garbled OAuth token is 401', async () => {
    await initWorkspace()
    const tok = await oauth('user_a', DCR, 'contacts:read')
    const garbled = tok.slice(0, -6) + (tok.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA')
    expect((await call(worker(), 'GET', '/meta/v1/me', garbled)).status).toBe(401)
    expect(await count('agents')).toBe(0)
  })
})

describe('AUTH_CLI_CLIENT_ID', () => {
  it('unset: no client is the CLI, so every OAuth client of a human is a delegated agent', async () => {
    await initWorkspace()
    profile('user_a', 'owner')
    const me = await call(worker({ AUTH_CLI_CLIENT_ID: undefined }), 'GET', '/meta/v1/me', await oauth('user_a', CLI, 'contacts:read'))
    expect(me.json.principal.kind).toBe('agent')
  })

  it('blank fails closed: 500 internal', async () => {
    await initWorkspace()
    const res = await call(worker({ AUTH_CLI_CLIENT_ID: '  ' }), 'GET', '/api/v1/contacts', 'vk_x')
    expect(res.status).toBe(500)
  })
})
