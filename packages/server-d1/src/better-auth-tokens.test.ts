import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry, scopesForRole } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { NOW, openWorkerPair, spyD1, type WorkerPair } from './test/kit.js'

// [[CORE244]] D7, D8, D9, D19, D20 (agent half), D23, P1, P2, P3 through the composition: the REAL Better Auth (test admission) mints the tokens on the control-plane database, the Worker
// under test (composeD1Worker, `better-auth`) verifies them in-process and resolves them against the vault's own rows.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let bootKey: string
let cliClient: string
let otherClient: string
const declared = createVibaseRegistry().declaredScopes()
const ALL_SCOPES = ['openid', 'offline_access', 'contacts:read', 'contacts:write', 'agents:write']
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) })
  orgId = r.organizationId
  bootUser = r.userId!
  bootKey = r.key
  kit = authKit(w.control, { scopes: declared })
  cliClient = await kit.registerClient('Vibase CLI')
  otherClient = await kit.registerClient('Claude Desktop')
})

const env = (over: Partial<D1WorkerEnv> = {}, control: D1WorkerEnv['CONTROL_DB'] = w.control): D1WorkerEnv => ({ DB: w.d1, CONTROL_DB: control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, AUTH_CLI_CLIENT_ID: cliClient, ...over })
const worker = (over: Partial<D1WorkerEnv> = {}) => composeD1Worker(env(over))
type Res = { status: number; json: any }
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, tok: string | null, body?: unknown, host = AUTH_BASE): Promise<Res> => {
  const res = await wk.fetch(new Request(host + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const me = (wk: ReturnType<typeof worker>, tok: string | null) => call(wk, 'GET', '/meta/v1/me', tok)
const rows = async (sqlText: string, ...binds: unknown[]) => (await w.d1.prepare(sqlText).bind(...binds).all()).results as Array<Record<string, any>>
const count = async (t: string) => Number(((await w.d1.prepare(`select count(*) n from "${t}"`).first()) as { n: number }).n)
const state = async () => ({ users: await count('users'), principals: await count('principals'), agents: await count('agents'), events: await count('events'), memberships: await count('memberships') })
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

type Subject = 'owner' | 'member' | 'no membership' | 'membership removed' | 'no users row' | 'agent account' | 'agent disabled' | 'agent with a membership'
/** A Better Auth account plus whatever the vault holds for it in `state`; the three credentials of that account. */
async function subject(state: Subject, email = `${state.replace(/ /g, '-')}@x.test`) {
  const { userId, cookie } = await kit.signUp(email)
  const link = { authProvider: 'better-auth', authSubject: userId }
  const human = async (role: 'owner' | 'member' | null, removed = false) => {
    const id = uuidv7(NOW)
    await seedPrincipal(w.d1, { id, kind: 'user', email, ...link })
    if (role) {
      const m = await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
      if (removed) await w.d1.prepare('update memberships set deleted_at = ? where id = ?').bind(NOW.toISOString(), m).run()
    }
    return id
  }
  const agent = async (disabled: boolean) => {
    const id = uuidv7(NOW)
    await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read', 'contacts:write'] })
    await w.d1.prepare('update agents set auth_provider = ?, auth_subject = ?, disabled_at = ? where id = ?').bind('better-auth', userId, disabled ? NOW.toISOString() : null, id).run()
    return id
  }
  let humanId: string | null = null
  let agentId: string | null = null
  if (state === 'owner' || state === 'member') humanId = await human(state)
  else if (state === 'no membership') humanId = await human(null)
  else if (state === 'membership removed') humanId = await human('member', true)
  else if (state === 'agent account') agentId = await agent(false)
  else if (state === 'agent disabled') agentId = await agent(true)
  else if (state === 'agent with a membership') (humanId = await human('member'), (agentId = await agent(false)))
  return {
    userId,
    cookie,
    humanId,
    agentId,
    session: () => kit.sessionJwt(cookie),
    oauth: async (client: string, scope = 'openid contacts:read contacts:write') => (await kit.deviceTokens(cookie, client, scope)).access_token,
  }
}

const OWNER_SCOPES = () => scopesForRole('owner', declared).toStrings()
const MEMBER_SCOPES = () => scopesForRole('member', declared).toStrings()
const WRITE_CONTACTS = ['contacts:read', 'contacts:request_approval', 'contacts:write']

type Cred = 'session' | 'cli' | 'other'
type Expect = { status: 200; kind: 'user'; role: 'owner' | 'member'; scopes: string[] } | { status: 200; kind: 'agent'; scopes: string[]; delegated?: boolean } | { status: 401 } | { status: 403; code: 'organization_forbidden' }
const matrix: Array<[Cred, Subject, Expect]> = [
  ['session', 'owner', { status: 200, kind: 'user', role: 'owner', scopes: [] }],
  ['session', 'member', { status: 200, kind: 'user', role: 'member', scopes: [] }],
  ['session', 'no membership', { status: 403, code: 'organization_forbidden' }],
  ['session', 'membership removed', { status: 403, code: 'organization_forbidden' }],
  ['session', 'no users row', { status: 403, code: 'organization_forbidden' }],
  ['session', 'agent account', { status: 200, kind: 'agent', scopes: WRITE_CONTACTS }],
  ['session', 'agent disabled', { status: 401 }],
  ['session', 'agent with a membership', { status: 403, code: 'organization_forbidden' }],
  ['cli', 'owner', { status: 200, kind: 'user', role: 'owner', scopes: WRITE_CONTACTS }],
  ['cli', 'member', { status: 200, kind: 'user', role: 'member', scopes: WRITE_CONTACTS }],
  ['cli', 'no membership', { status: 403, code: 'organization_forbidden' }],
  ['cli', 'no users row', { status: 403, code: 'organization_forbidden' }],
  ['cli', 'agent account', { status: 200, kind: 'agent', scopes: WRITE_CONTACTS }],
  ['other', 'owner', { status: 200, kind: 'agent', scopes: WRITE_CONTACTS, delegated: true }],
  ['other', 'member', { status: 200, kind: 'agent', scopes: WRITE_CONTACTS, delegated: true }],
  ['other', 'no membership', { status: 403, code: 'organization_forbidden' }],
  ['other', 'membership removed', { status: 403, code: 'organization_forbidden' }],
  ['other', 'no users row', { status: 403, code: 'organization_forbidden' }],
  ['other', 'agent account', { status: 200, kind: 'agent', scopes: WRITE_CONTACTS }],
  ['other', 'agent disabled', { status: 401 }],
  ['other', 'agent with a membership', { status: 403, code: 'organization_forbidden' }],
]

describe('the principal matrix: credential path x subject state (D7, D9, D20 agent half, P2, P3)', () => {
  it.each(matrix)('%s token, subject: %s', async (cred, which, want) => {
    const s = await subject(which)
    const tok = cred === 'session' ? await s.session() : await s.oauth(cred === 'cli' ? cliClient : otherClient)
    const before = await state()
    const res = await me(worker(), tok)
    expect(res.status, JSON.stringify(res.json)).toBe(want.status)
    if (want.status === 401) {
      expect(await state()).toEqual(before)
      return
    }
    if (want.status === 403) {
      expect(res.json.error.code).toBe(want.code)
      // P2: nothing is written for a subject the vault does not hold, or no longer admits
      expect(await state()).toEqual(before)
      return
    }
    expect(res.json.principal.kind).toBe(want.kind)
    if (want.kind === 'user') {
      expect(res.json.principal.id).toBe(s.humanId)
      expect(res.json.active_organization.role).toBe(want.role)
      expect(res.json.active_organization.scopes).toEqual(want.scopes.length > 0 ? want.scopes : want.role === 'owner' ? OWNER_SCOPES() : MEMBER_SCOPES())
      expect(res.json.client_id).toBe(cred === 'cli' ? cliClient : null)
      expect(await state()).toEqual(before)
    } else {
      expect(res.json.active_organization.scopes).toEqual(want.scopes)
      if (want.delegated) {
        expect(res.json.agent).toMatchObject({ delegated_by: s.humanId, auth_client_id: otherClient, auth_subject: null })
        // first sight: one agents row, its principal and its event, nothing else
        const after = await state()
        expect(after).toEqual({ ...before, agents: before.agents + 1, principals: before.principals + 1, events: before.events + 1 })
        expect(await rows("select type, actor_id from events where type = 'agent.created' and resource_id = ?", res.json.principal.id)).toEqual([{ type: 'agent.created', actor_id: s.humanId }])
        expect(res.json.agent.name).toBe(`Claude Desktop (${which}@x.test)`)
      } else {
        expect(res.json.principal.id).toBe(s.agentId)
        expect(await state()).toEqual(before)
      }
    }
  })

  it('a delegated agent is created once: a second token reuses it (no second row, no second event)', async () => {
    const s = await subject('member')
    const wk = worker()
    const a = await me(wk, await s.oauth(otherClient))
    const b = await me(wk, await s.oauth(otherClient, 'openid contacts:read'))
    expect(b.json.principal.id).toBe(a.json.principal.id)
    expect((await rows("select id from agents where auth_client_id = ?", otherClient)).length).toBe(1)
    expect((await rows("select id from events where type = 'agent.created'")).length).toBe(1)
  })

  it('P3: with AUTH_CLI_CLIENT_ID unset the first-party client id is vibase-cli', async () => {
    const s = await subject('owner')
    const now = new Date().toISOString()
    // the seeded vibase-cli client row is CORE283's; a row of that id is enough for the provider to mint for it here
    await w.control.prepare('insert into auth_oauth_clients (id, client_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scopes, created_at, updated_at, disabled, skip_consent) select ?, ?, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scopes, ?, ?, 0, skip_consent from auth_oauth_clients where client_id = ?').bind(uuidv7(), 'vibase-cli', now, now, cliClient).run()
    const tok = await s.oauth('vibase-cli')
    const res = await me(worker({ AUTH_CLI_CLIENT_ID: undefined }), tok)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.principal.kind).toBe('user')
    expect(res.json.client_id).toBe('vibase-cli')
  })
})

describe('the role is read on every request (D7)', () => {
  it('with the same token on a warm Worker: a role change changes the scopes, a soft delete refuses', async () => {
    const s = await subject('owner')
    const tok = await s.session()
    const wk = worker()
    expect((await call(wk, 'POST', '/meta/v1/agents', tok, { name: 'x' })).status).toBe(201)
    await w.d1.prepare("update memberships set role = 'member' where user_id = ?").bind(s.humanId).run()
    const demoted = await call(wk, 'POST', '/meta/v1/agents', tok, { name: 'y' })
    expect(demoted.status).toBe(403)
    expect(demoted.json.error.code).toBe('insufficient_scope')
    expect((await me(wk, tok)).json.active_organization.role).toBe('member')
    await w.d1.prepare('update memberships set deleted_at = ? where user_id = ?').bind(NOW.toISOString(), s.humanId).run()
    const removed = await me(wk, tok)
    expect(removed.status).toBe(403)
    expect(removed.json.error.code).toBe('organization_forbidden')
    // restoring a live membership (a new row) admits the same token again
    await seedMembership(w.d1, { organizationId: orgId, userId: s.humanId!, role: 'owner' })
    expect((await me(wk, tok)).json.active_organization.role).toBe('owner')
  })
})

describe('real tokens and the warm path (D8, D19, D23, P1)', () => {
  it('a session JWT lives 15 minutes and an access token 1 hour', async () => {
    const s = await subject('owner')
    const session = decode(await s.session())
    expect(session.exp - session.iat).toBe(15 * 60)
    const tokens = await kit.deviceTokens(s.cookie, cliClient, 'openid contacts:read')
    const access = decode(tokens.access_token)
    expect(access.exp - access.iat).toBe(60 * 60)
    expect(tokens.expires_in).toBe(3600)
  })

  it('an OIDC ID token minted by the same flow, from the same issuer, is refused', async () => {
    const s = await subject('owner')
    const tokens = await kit.deviceTokens(s.cookie, cliClient, 'openid contacts:read')
    expect(tokens.id_token).toBeTruthy()
    const wk = worker()
    expect((await me(wk, tokens.id_token!)).status).toBe(401)
    expect((await me(wk, tokens.access_token)).status).toBe(200)
  })

  it('a Better Auth cookie on /api, /meta or /mcp authenticates nothing (the API is Bearer-only)', async () => {
    const s = await subject('owner')
    const wk = worker()
    for (const path of ['/api/v1/contacts', '/meta/v1/me']) {
      const res = await wk.fetch(new Request(AUTH_BASE + path, { headers: { cookie: s.cookie } }))
      expect(res.status, path).toBe(401)
    }
    const mcp = await wk.fetch(new Request(AUTH_BASE + '/mcp', { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: '{}' }))
    expect(mcp.status).toBe(401)
  })

  it('the issuer is the configured one, never the request host (D23): a valid token is honoured on another host, and a token for another configured origin is not', async () => {
    const s = await subject('owner')
    const tok = await s.session()
    expect((await call(worker(), 'GET', '/meta/v1/me', tok, undefined, 'https://preview.workers.dev')).status).toBe(200)
    expect((await call(worker({ PUBLIC_BASE_URL: 'https://elsewhere.test' }), 'GET', '/meta/v1/me', tok)).status).toBe(401)
  })

  it('a warm request reads CONTROL_DB zero times; an unknown key id re-reads at most once in 30 seconds (P1)', async () => {
    const s = await subject('owner')
    const tok = await s.session()
    const spy = spyD1(w.control)
    let clock = NOW.getTime()
    const wk = composeD1Worker(env({}, spy.d1), { clock: () => new Date(clock), nowMs: () => clock })
    // the Better Auth tokens were minted at the real time: move the Worker's clock to it
    clock = Date.now()
    expect((await me(wk, tok)).status).toBe(200)
    spy.log.clear()
    for (let i = 0; i < 3; i++) expect((await me(wk, tok)).status).toBe(200)
    expect(spy.log.statements).toEqual([])
    // a forged key id: one re-read at most per 30 s
    const [header, payload, sig] = tok.split('.') as [string, string, string]
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(header, 'base64url').toString()), kid: 'forged' })).toString('base64url')}.${payload}.${sig}`
    clock += 31_000
    for (let i = 0; i < 5; i++) expect((await me(wk, forged)).status).toBe(401)
    expect(spy.log.statements.filter((q) => /auth_jwks/.test(q))).toHaveLength(1)
  })

  it('an empty auth_jwks is 401, never 500', async () => {
    const s = await subject('owner')
    const tok = await s.session()
    await w.control.prepare('delete from auth_jwks').run()
    const res = await me(worker(), tok)
    expect(res.status).toBe(401)
  })

  it('an API key still authenticates on better-auth, and a string that is neither key nor JWT is 401', async () => {
    const wk = worker()
    expect((await me(wk, bootKey)).status).toBe(200)
    expect((await me(wk, 'not-a-key-and-not-a-jwt')).status).toBe(401)
  })
})
