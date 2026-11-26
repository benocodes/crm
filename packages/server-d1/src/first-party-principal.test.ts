import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import {
  AuthFailure,
  createVibaseRegistry,
  createWorkspaceAuthenticator,
  grantableScopes,
  scopesForRole,
  type AuthAdapter,
  type Principal,
} from '@vibase/api'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[CORE639]] groups 1 to 3 at the authenticator: a first-party OAuth client's token is the signed-in person (D2), its scopes are role met with the app's live bound (D3), and the client is read
// through `fetchOAuthClient` with a 60 s per-isolate cache moved by the request's `env.now` (D5, D6, P1 to P4). The adapter is a fake, so each case controls what the client read answers and counts it.
let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const CLI = 'vibase-cli'
const APP = 'client_app'
const DCR = 'client_dcr'
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
const CUSTOM = ['projects__c:read', 'projects__c:request_approval', 'projects__c:write']
const T0 = new Date('2026-11-26T10:00:00.000Z')

type ClientAnswer = { firstParty: boolean; scopes: string[] | null } | null
type Token = { sub: string; client: string; scopes?: string[] }
const tokenKey = (t: Token) => JSON.stringify(t)

function fakeAdapter(clients: Map<string, ClientAnswer | 'throw'>, withMethod = true) {
  const reads: string[] = []
  const adapter: AuthAdapter & { reads: string[] } = {
    provider: 'better-auth',
    roleSource: 'membership',
    reads,
    verify: async (token) => {
      const t = JSON.parse(token) as Token
      return { ok: true, kind: 'oauth', subject: t.sub, clientId: t.client, scopes: t.scopes ?? [] }
    },
    fetchProfile: async () => ({ email: 'delegate@x.test', emailVerified: true, name: null }),
    fetchOAuthClientName: async () => null,
    fetchOrganization: async () => null,
    listMembers: async () => [],
    parseWebhook: async () => ({ ok: false, reason: 'signature' }),
  }
  if (withMethod)
    adapter.fetchOAuthClient = async (id: string) => {
      reads.push(id)
      const answer = clients.get(id)
      if (answer === 'throw') throw new Error('control database unavailable')
      return answer ?? null
    }
  return adapter
}

async function setup(
  over: {
    clients?: Map<string, ClientAnswer | 'throw'>
    withMethod?: boolean
    declaredScopes?: readonly string[]
  } = {},
) {
  const organizationId = uuidv7(NOW)
  await seedDeployment(w.d1, { organizationId, provider: 'better-auth', externalId: 'org_acme' })
  const link = { organizationId, authProvider: 'better-auth', authOrgId: 'org_acme' }
  const storage = d1Binding(w.d1, link)
  const clients = over.clients ?? new Map<string, ClientAnswer | 'throw'>()
  const adapter = fakeAdapter(clients, over.withMethod ?? true)
  const mk = (declaredScopes: readonly string[]) =>
    createWorkspaceAuthenticator({ adapter, declaredScopes, cliClientId: CLI })
  const authenticator = mk(over.declaredScopes ?? declared)
  let at = T0
  const authenticate = async (
    t: Token,
    opts: { auth?: ReturnType<typeof mk>; header?: string } = {},
  ): Promise<Principal> =>
    (opts.auth ?? authenticator).authenticate(tokenKey(t), {
      storage,
      organizationHeader: opts.header,
      env: { now: at, newId: () => uuidv7(at) } as never,
    })
  const person = async (sub: string, role: 'owner' | 'member', removed = false) => {
    const id = uuidv7(NOW)
    await seedPrincipal(w.d1, {
      id,
      kind: 'user',
      email: `${sub}@x.test`,
      authProvider: 'better-auth',
      authSubject: sub,
    })
    const m = await seedMembership(w.d1, { organizationId, userId: id, role })
    if (removed)
      await w.d1.prepare('update memberships set deleted_at = ? where id = ?').bind(NOW.toISOString(), m).run()
    return id
  }
  const agentAccount = async (sub: string, createdBy: string) => {
    const id = uuidv7(NOW)
    await seedAgent(w.d1, { id, organizationId, createdBy, scopes: ['contacts:read', 'contacts:write'] })
    await w.d1
      .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
      .bind('better-auth', sub, id)
      .run()
    return id
  }
  return {
    organizationId,
    clients,
    adapter,
    authenticator,
    mk,
    authenticate,
    person,
    agentAccount,
    advance: (ms: number) => void (at = new Date(at.getTime() + ms)),
    sync: (d: Date) => void (at = d),
  }
}

const count = async (t: string) =>
  Number(((await w.d1.prepare(`select count(*) n from "${t}"`).first()) as { n: number }).n)
const state = async () => ({
  users: await count('users'),
  principals: await count('principals'),
  agents: await count('agents'),
  events: await count('events'),
  memberships: await count('memberships'),
})
const meet = (a: readonly string[], b: readonly string[]) => a.filter((s) => b.includes(s)).sort()
const ownerScopes = (d = declared) => scopesForRole('owner', d).toStrings()
const memberScopes = (d = declared) => scopesForRole('member', d).toStrings()
const FIRST = (scopes: string[] | null = null): ClientAnswer => ({ firstParty: true, scopes })

describe('group 1: the principal by client class (D2, D6, P3, P4)', () => {
  it('a first-party client: the person as a user principal with role and clientId, no agent row, no agent event, nothing written', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    const id = await t.person('sub_owner', 'owner')
    const before = await state()
    const p = await t.authenticate({ sub: 'sub_owner', client: APP })
    expect(p.actor).toEqual({ id, kind: 'user' })
    expect(p.role).toBe('owner')
    expect(p.clientId).toBe(APP)
    expect(p.organizationId).toBe(t.organizationId)
    expect(await state()).toEqual(before)
    expect(await count('agents')).toBe(0)
  })

  it('the organisation header is cross-checked as for the CLI', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_owner', 'owner')
    const p = await t.authenticate({ sub: 'sub_owner', client: APP }, { header: uuidv7(NOW) })
    expect(p.organizationForbidden).toBe(true)
    expect(p.organizationId).toBeNull()
  })

  it('vibase-cli: a limited login (the marker) is role ∩ token as before, and its client is never read', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    const id = await t.person('sub_owner', 'owner')
    const p = await t.authenticate({ sub: 'sub_owner', client: CLI, scopes: ['contacts:read', 'limited_login'] })
    expect(p.actor).toEqual({ id, kind: 'user' })
    expect(p.scopes.toStrings()).toEqual(['contacts:read'])
    expect(t.adapter.reads).toEqual([])
  })

  it('a client that is not first-party is the delegated agent as today (one row, one event), with the token as bound', async () => {
    const t = await setup({ clients: new Map([[DCR, { firstParty: false, scopes: null }]]) })
    const id = await t.person('sub_member', 'member')
    const before = await state()
    const p = await t.authenticate({ sub: 'sub_member', client: DCR, scopes: ['contacts:read', 'contacts:write'] })
    expect(p.actor.kind).toBe('agent')
    expect(p.actor.id).not.toBe(id)
    expect(p.scopes.toStrings()).toEqual(['contacts:read', 'contacts:request_approval', 'contacts:write'])
    expect(await state()).toEqual({
      ...before,
      agents: before.agents + 1,
      principals: before.principals + 1,
      events: before.events + 1,
    })
  })

  it('an agent-account subject stays that agent through a first-party client', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    const human = await t.person('sub_admin', 'owner')
    const account = await t.agentAccount('sub_agent', human)
    const p = await t.authenticate({ sub: 'sub_agent', client: APP, scopes: ['contacts:read', 'contacts:write'] })
    expect(p.actor).toEqual({ id: account, kind: 'agent' })
  })

  it('a member removed after the token was issued is 403 organization_forbidden and nothing is written', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_gone', 'member', true)
    const before = await state()
    await expect(t.authenticate({ sub: 'sub_gone', client: APP })).rejects.toMatchObject({
      status: 403,
      code: 'organization_forbidden',
    })
    await expect(t.authenticate({ sub: 'sub_unknown', client: APP })).rejects.toMatchObject({
      status: 403,
      code: 'organization_forbidden',
    })
    expect(await state()).toEqual(before)
  })

  it('an adapter without fetchOAuthClient keeps today: every non-CLI client is delegated', async () => {
    const t = await setup({ withMethod: false, clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_owner', 'owner')
    const p = await t.authenticate({ sub: 'sub_owner', client: APP, scopes: ['contacts:read'] })
    expect(p.actor.kind).toBe('agent')
    expect(await count('agents')).toBe(1)
  })

  it('an unknown client is 401 unauthenticated before any agent lookup: no agents row, no event (D6, P3)', async () => {
    const t = await setup({ clients: new Map() })
    await t.person('sub_owner', 'owner')
    const before = await state()
    const err = await t
      .authenticate({ sub: 'sub_owner', client: 'client_unknown', scopes: ['contacts:read'] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(AuthFailure)
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(await state()).toEqual(before)
  })
})

describe('group 2: scopes are role met with the live bound and the ceiling (D3)', () => {
  it("an owner's app on a NULL client holds the grantable ceiling: a vault scope not in the token's claim is held, a human-only scope in the claim is not", async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_owner', 'owner')
    const p = await t.authenticate({
      sub: 'sub_owner',
      client: APP,
      scopes: ['contacts:read', 'oauth_clients:write', 'members:write'],
    })
    expect(p.scopes.toStrings()).toEqual(meet(grantable, ownerScopes()))
    expect(p.scopes.toStrings()).toContain('deals:write')
    for (const human of ['oauth_clients:write', 'members:write']) expect(p.scopes.toStrings()).not.toContain(human)
  })

  it("a member's app holds member scopes only", async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_member', 'member')
    const p = await t.authenticate({ sub: 'sub_member', client: APP })
    expect(p.scopes.toStrings()).toEqual(meet(grantable, memberScopes()))
    expect(p.role).toBe('member')
  })

  it('a list client holds role met with the list, closed under write => request_approval; the token claim does not widen or narrow it', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST(['contacts:write', 'deals:read'])]]) })
    await t.person('sub_owner', 'owner')
    const wide = await t.authenticate({ sub: 'sub_owner', client: APP, scopes: grantable })
    expect(wide.scopes.toStrings()).toEqual(['contacts:request_approval', 'contacts:write', 'deals:read'])
    const none = await t.authenticate({ sub: 'sub_owner', client: APP, scopes: [] })
    expect(none.scopes.toStrings()).toEqual(['contacts:request_approval', 'contacts:write', 'deals:read'])
  })

  it('a list naming a scope the role lacks holds only the role part', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST(['contacts:read', 'members:write'])]]) })
    await t.person('sub_member', 'member')
    const p = await t.authenticate({ sub: 'sub_member', client: APP })
    expect(p.scopes.toStrings()).toEqual(['contacts:read'])
  })

  it('a scope declared after issue is held with the same token: a second authenticator with an extra declared custom-object scope', async () => {
    const extended = [...declared, ...CUSTOM].sort()
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_member', 'member')
    const token = { sub: 'sub_member', client: APP, scopes: ['contacts:read'] }
    const before = await t.authenticate(token)
    for (const s of CUSTOM) expect(before.scopes.toStrings()).not.toContain(s)
    const after = await t.authenticate(token, { auth: t.mk(extended) })
    for (const s of CUSTOM) expect(after.scopes.toStrings()).toContain(s)
  })
})

describe('group 3: the client read and its cache (D5, D6, P1, P2)', () => {
  it('a scopes edit reaches a live token after the cache minute: the old bound at +59 s, the new one at +61 s; one read in the window', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST(['contacts:read', 'deals:read'])]]) })
    await t.person('sub_owner', 'owner')
    const token = { sub: 'sub_owner', client: APP }
    expect((await t.authenticate(token)).scopes.toStrings()).toEqual(['contacts:read', 'deals:read'])
    t.clients.set(APP, FIRST(['contacts:read']))
    t.advance(59_000)
    expect((await t.authenticate(token)).scopes.toStrings()).toEqual(['contacts:read', 'deals:read'])
    expect(t.adapter.reads).toEqual([APP])
    t.advance(2_000)
    expect((await t.authenticate(token)).scopes.toStrings()).toEqual(['contacts:read'])
    expect(t.adapter.reads).toEqual([APP, APP])
  })

  it('a delete reaches a live token after the minute: it works at +59 s and is 401 unauthenticated at +61 s, nothing written; the null is cached too', async () => {
    const t = await setup({ clients: new Map([[APP, FIRST()]]) })
    await t.person('sub_owner', 'owner')
    const token = { sub: 'sub_owner', client: APP }
    expect((await t.authenticate(token)).actor.kind).toBe('user')
    t.clients.delete(APP)
    t.advance(59_000)
    expect((await t.authenticate(token)).actor.kind).toBe('user')
    t.advance(2_000)
    const before = await state()
    for (let i = 0; i < 3; i++)
      await expect(t.authenticate(token)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(await state()).toEqual(before)
    expect(t.adapter.reads).toEqual([APP, APP])
  })

  it('a read that throws is not cached and is not an AuthFailure: the next request reads again', async () => {
    const t = await setup({ clients: new Map([[APP, 'throw']]) })
    await t.person('sub_owner', 'owner')
    const before = await state()
    const err = await t.authenticate({ sub: 'sub_owner', client: APP }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AuthFailure)
    t.clients.set(APP, FIRST())
    expect((await t.authenticate({ sub: 'sub_owner', client: APP })).actor.kind).toBe('user')
    expect(t.adapter.reads).toEqual([APP, APP])
    expect(await state()).toEqual(before)
  })

  it('one read per client id within the window, whoever the subject; another client reads separately', async () => {
    const t = await setup({
      clients: new Map<string, ClientAnswer>([
        [APP, FIRST()],
        ['client_two', FIRST(['contacts:read'])],
      ]),
    })
    await t.person('sub_a', 'owner')
    await t.person('sub_b', 'member')
    for (const sub of ['sub_a', 'sub_b', 'sub_a']) await t.authenticate({ sub, client: APP })
    await t.authenticate({ sub: 'sub_a', client: 'client_two' })
    expect(t.adapter.reads).toEqual([APP, 'client_two'])
  })
})
