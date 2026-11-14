import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb, type D1Like } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { SCOPE_POLICY, assertAgentGrantable, createVibaseRegistry, grantableScopes, scopesForRole } from '@vibase/api'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { NOW, clerkKit, clerkUser, faultD1, openWorkerD1, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[CORE288]] through the composition: the REAL Better Auth on the control-plane database, the Worker (composeD1Worker, `better-auth`) serving `memberships.update|delete` and `users.issue_reset_link`
// on REST and MCP. The CRM unit is the commit point of a removal; the control batch that revokes the subject's sessions and OAuth tokens follows it.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let bootKey: string
let otherClient: string
const declared = createVibaseRegistry().declaredScopes()
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
  otherClient = await kit.registerClient('Claude Desktop')
})
afterEach(() => vi.useRealTimers())

const worker = (over: { crm?: D1Like; control?: D1WorkerEnv['CONTROL_DB'] } = {}) => composeD1Worker({ DB: over.crm ?? w.d1, CONTROL_DB: over.control ?? w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE })
type Res = { status: number; json: any }
let ip = 0
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, tok: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
  const res = await wk.fetch(new Request(AUTH_BASE + path, { method, headers: { 'cf-connecting-ip': `198.51.100.${(ip++ % 200) + 1}`, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) => ((await d1.prepare(text).bind(...binds).all()).results ?? []) as Array<Record<string, any>>
const dump = async (d1: D1Like) => {
  const tables = (await rows(d1, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'")).map((r) => r.name as string)
  const all: Record<string, unknown[]> = {}
  for (const t of tables) all[t] = await rows(d1, `select * from "${t}"`)
  return all
}

type Human = { id: string; subject: string; email: string; cookie: string; session(): Promise<string>; tokens(client?: string, scope?: string): Promise<{ access_token: string; refresh_token?: string }> }
async function human(role: 'owner' | 'member', email = `${role}@x.test`): Promise<Human> {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return { id, subject: userId, email, cookie, session: () => kit.sessionJwt(cookie), tokens: (client = otherClient, scope = 'openid offline_access contacts:read') => kit.deviceTokens(cookie, client, scope) }
}
async function agentAccount() {
  const { userId, cookie } = await kit.signUp('agent-account@x.test')
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read', 'contacts:write'] })
  await w.d1.prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?').bind('better-auth', userId, id).run()
  return { id, session: () => kit.sessionJwt(cookie) }
}
/** The membership row of a user principal, live or not. */
const membership = async (userId: string) => (await rows(w.d1, 'select * from memberships where user_id = ?', userId))[0]!
const events = (like = 'membership.%') => rows(w.d1, 'select id, type, resource_id, actor_id, "before", "after" from events where type like ? order by id', like)
const audit = (action?: string) => rows(w.control, `select * from control_audit ${action ? 'where action = ?' : ''} order by id`, ...(action ? [action] : []))
const authRows = async (subject: string) => ({
  sessions: (await rows(w.control, 'select id from auth_sessions where user_id = ?', subject)).length,
  access: (await rows(w.control, 'select id from auth_oauth_access_tokens where user_id = ?', subject)).length,
  refresh: (await rows(w.control, 'select id from auth_oauth_refresh_tokens where user_id = ?', subject)).length,
  consents: (await rows(w.control, 'select id from auth_oauth_consents where user_id = ?', subject)).length,
})
/** Removes the bootstrap owner's membership directly (no event): the human owner then is the only live owner. */
const soleOwner = () => w.d1.prepare("update memberships set deleted_at = '2026-10-27T10:00:00.000Z' where user_id = ?").bind(bootUser).run()

const PATH = '/meta/v1/memberships'
const RESET = '/meta/v1/users/reset-link'
const patch = (wk: ReturnType<typeof worker>, tok: string, id: string, body: unknown) => call(wk, 'PATCH', `${PATH}/${id}`, tok, body)
const del = (wk: ReturnType<typeof worker>, tok: string, id: string) => call(wk, 'DELETE', `${PATH}/${id}`, tok)
const reset = (wk: ReturnType<typeof worker>, tok: string, userId: string) => call(wk, 'POST', RESET, tok, { user_id: userId })

describe('role change (memberships.update)', () => {
  it('member to owner and back: the whole row is compared, updated_at moves, one membership.updated per change carries before, and the next request carries the new role', async () => {
    const owner = await human('owner')
    const member = await human('member', 'm@x.test')
    const wk = worker()
    const mid = (await membership(member.id)).id as string
    const asMember = async () => call(wk, 'GET', '/meta/v1/invitations', await member.session())
    expect((await asMember()).status).toBe(403)
    const before = await membership(member.id)
    const up = await patch(wk, await owner.session(), mid, { role: 'owner' })
    expect(up.status, JSON.stringify(up.json)).toBe(200)
    const after = await membership(member.id)
    expect(after).toEqual({ ...before, role: 'owner', updated_at: after.updated_at })
    expect(after.updated_at > before.updated_at).toBe(true)
    expect(up.json).toEqual({ id: mid, organization_id: orgId, user_id: member.id, role: 'owner', created_by: before.created_by, created_at: before.created_at, updated_at: after.updated_at })
    expect((await asMember()).status).toBe(200)
    const down = await patch(wk, await owner.session(), mid, { role: 'member' })
    expect(down.status).toBe(200)
    expect((await asMember()).status).toBe(403)
    const evs = await events()
    expect(evs.map((e) => e.type)).toEqual(['membership.updated', 'membership.updated'])
    expect(evs[0]).toMatchObject({ resource_id: mid, actor_id: owner.id })
    expect(JSON.parse(evs[0]!.before)).toMatchObject({ id: mid, role: 'member', updated_at: before.updated_at })
    expect(JSON.parse(evs[0]!.after)).toMatchObject({ id: mid, role: 'owner', updated_at: after.updated_at })
    expect(JSON.parse(evs[1]!.before)).toMatchObject({ role: 'owner' })
    expect(JSON.parse(evs[1]!.after)).toMatchObject({ role: 'member' })
  })

  it('a role equal to the current one is a real update (the generic rule): updated_at moves and an event is written', async () => {
    const owner = await human('owner')
    const member = await human('member', 'same@x.test')
    const mid = (await membership(member.id)).id as string
    const before = await membership(member.id)
    const res = await patch(worker(), await owner.session(), mid, { role: 'member' })
    expect(res.status).toBe(200)
    expect((await membership(member.id)).updated_at > before.updated_at).toBe(true)
    expect((await events()).map((e) => e.type)).toEqual(['membership.updated'])
  })

  it('validates the body and the id: an unknown role or field is 400, an unknown or malformed id is 404; nothing is written', async () => {
    const owner = await human('owner')
    const member = await human('member', 'v@x.test')
    const mid = (await membership(member.id)).id as string
    const wk = worker()
    const tok = await owner.session()
    for (const bad of [{ role: 'admin' }, {}, { role: 'owner', extra: 1 }, { role: 5 }]) expect((await patch(wk, tok, mid, bad)).status, JSON.stringify(bad)).toBe(400)
    expect((await patch(wk, tok, uuidv7(NOW), { role: 'owner' })).status).toBe(404)
    expect((await patch(wk, tok, 'nope', { role: 'owner' })).status).toBe(404)
    expect(await events()).toEqual([])
  })

  it('a removed membership cannot be updated (404)', async () => {
    const owner = await human('owner')
    const member = await human('member', 'gone@x.test')
    const mid = (await membership(member.id)).id as string
    const wk = worker()
    expect((await del(wk, await owner.session(), mid)).status).toBe(200)
    expect((await patch(wk, await owner.session(), mid, { role: 'owner' })).status).toBe(404)
  })
})

describe('removal denies on every credential path (the matrix)', () => {
  it('after memberships.delete the removed person\'s session JWT, OAuth access token and refresh are refused; another member still works; the row is kept and one event written; a second delete is 404', async () => {
    const owner = await human('owner')
    const gone = await human('member', 'gone@x.test')
    const stays = await human('member', 'stays@x.test')
    const wk = worker()
    const jwt = await gone.session()
    const { access_token, refresh_token } = await gone.tokens()
    expect(refresh_token).toBeTruthy()
    const stayTok = await stays.session()
    const stayAccess = (await stays.tokens()).access_token
    for (const t of [jwt, access_token, stayTok, stayAccess]) expect((await call(wk, 'GET', '/meta/v1/me', t)).status).toBe(200)
    const mid = (await membership(gone.id)).id as string
    const res = await del(wk, await owner.session(), mid)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({ id: mid, user_id: gone.id, role: 'member' })
    // the row is kept, soft deleted
    const row = await membership(gone.id)
    expect(row).toMatchObject({ id: mid, deleted_at: expect.any(String) })
    const evs = await events()
    expect(evs.map((e) => e.type)).toEqual(['membership.deleted'])
    expect(evs[0]).toMatchObject({ resource_id: mid, actor_id: owner.id, after: null })
    expect(JSON.parse(evs[0]!.before)).toMatchObject({ id: mid, user_id: gone.id })
    // every credential path of the removed person is refused
    expect((await call(wk, 'GET', '/meta/v1/me', jwt)).status).toBe(403)
    expect((await call(wk, 'GET', '/meta/v1/me', access_token)).status).toBe(403)
    const fresh = await call(wk, 'GET', '/auth/token', null, undefined, { cookie: gone.cookie })
    expect(fresh.status === 200 && typeof fresh.json?.token === 'string').toBe(false)
    const viaRefresh = await wk.fetch(new Request(`${AUTH_BASE}/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: AUTH_BASE, 'cf-connecting-ip': '198.51.100.250' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh_token!, client_id: otherClient }).toString() }))
    expect(viaRefresh.status).toBeGreaterThanOrEqual(400)
    // another member's credentials are untouched
    expect((await call(wk, 'GET', '/meta/v1/me', stayTok)).status).toBe(200)
    expect((await call(wk, 'GET', '/meta/v1/me', stayAccess)).status).toBe(200)
    // a second delete
    expect((await del(wk, await owner.session(), mid)).status).toBe(404)
    expect((await events()).map((e) => e.type)).toEqual(['membership.deleted'])
  })
})

describe('removal order and revocation (P5)', () => {
  it('after a removal the subject\'s sessions and OAuth tokens are gone, one user.sessions_revoked row names the caller and the Better Auth user; consents and the users row stay; others are untouched', async () => {
    const owner = await human('owner')
    const gone = await human('member', 'gone@x.test')
    const stays = await human('member', 'stays@x.test')
    await gone.tokens()
    await stays.tokens()
    const wk = worker()
    const stayBefore = await authRows(stays.subject)
    expect(await authRows(gone.subject)).toMatchObject({ refresh: 1, consents: 1 })
    expect((await authRows(gone.subject)).sessions).toBeGreaterThan(0)
    const res = await del(wk, await owner.session(), (await membership(gone.id)).id as string)
    expect(res.status).toBe(200)
    expect(await authRows(gone.subject)).toEqual({ sessions: 0, access: 0, refresh: 0, consents: 1 })
    expect(await authRows(stays.subject)).toEqual(stayBefore)
    const a = await audit('user.sessions_revoked')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ actor_id: owner.id, action: 'user.sessions_revoked', target_type: 'user', target_id: gone.subject })
    expect(JSON.parse(a[0]!.detail)).toEqual({ reason: 'membership_removed' })
    expect(JSON.stringify(await audit())).not.toMatch(/token|cookie/i)
    expect(await rows(w.d1, 'select id from users where id = ?', gone.id)).toHaveLength(1)
    expect(await rows(w.control, 'select id from auth_users where id = ?', gone.subject)).toHaveLength(1)
  })

  it('an injected CRM failure leaves the membership live and every session and token in place, with no audit row', async () => {
    const owner = await human('owner')
    const gone = await human('member', 'gone@x.test')
    await gone.tokens()
    const before = await authRows(gone.subject)
    const crm = faultD1(w.d1, { match: /update "memberships"/i, act: async () => { throw new Error('D1 is unavailable') } })
    const wk = worker({ crm: crm.d1 })
    const res = await del(wk, await owner.session(), (await membership(gone.id)).id as string)
    expect(crm.fired()).toBe(1)
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await membership(gone.id)).deleted_at).toBeNull()
    expect(await events()).toEqual([])
    expect(await authRows(gone.subject)).toEqual(before)
    expect(await audit('user.sessions_revoked')).toEqual([])
    expect((await call(worker(), 'GET', '/meta/v1/me', await gone.session())).status).toBe(200)
  })

  it('an injected control failure answers 200 with the membership deleted, the sessions still present and no audit row; the CRM still denies the removed person', async () => {
    const owner = await human('owner')
    const gone = await human('member', 'gone@x.test')
    const { access_token } = await gone.tokens()
    const before = await authRows(gone.subject)
    const control = faultD1(w.control, { match: /delete from auth_/i, act: async () => { throw new Error('D1 is unavailable') } })
    const wk = worker({ control: control.d1 })
    const jwt = await gone.session()
    const res = await del(wk, await owner.session(), (await membership(gone.id)).id as string)
    expect(control.fired()).toBe(1)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect((await membership(gone.id)).deleted_at).not.toBeNull()
    expect((await events()).map((e) => e.type)).toEqual(['membership.deleted'])
    expect(await authRows(gone.subject)).toEqual(before)
    expect(await audit('user.sessions_revoked')).toEqual([])
    expect((await call(wk, 'GET', '/meta/v1/me', jwt)).status).toBe(403)
    expect((await call(wk, 'GET', '/meta/v1/me', access_token)).status).toBe(403)
  })

  it('demotion revokes nothing and writes no revocation audit row', async () => {
    const owner = await human('owner')
    const other = await human('owner', 'o2@x.test')
    await other.tokens()
    const before = await authRows(other.subject)
    const res = await patch(worker(), await owner.session(), (await membership(other.id)).id as string, { role: 'member' })
    expect(res.status).toBe(200)
    expect(await authRows(other.subject)).toEqual(before)
    expect(await audit('user.sessions_revoked')).toEqual([])
  })
})

describe('the last owner (P4)', () => {
  it('demoting or removing the sole owner is 409 last_owner with nothing written: no event, no revocation, no audit', async () => {
    const owner = await human('owner')
    await soleOwner()
    await owner.tokens()
    const wk = worker()
    const tok = await owner.session()
    const mid = (await membership(owner.id)).id as string
    const authBefore = await authRows(owner.subject)
    const demote = await patch(wk, tok, mid, { role: 'member' })
    expect(demote.status, JSON.stringify(demote.json)).toBe(409)
    expect(demote.json.error.code).toBe('last_owner')
    const remove = await del(wk, tok, mid)
    expect(remove.status).toBe(409)
    expect(remove.json.error.code).toBe('last_owner')
    expect(await membership(owner.id)).toMatchObject({ role: 'owner', deleted_at: null })
    expect(await events()).toEqual([])
    expect(await authRows(owner.subject)).toEqual(authBefore)
    expect(await audit()).toEqual([])
    // promoting or keeping the owner role is not a demotion
    expect((await patch(wk, tok, mid, { role: 'owner' })).status).toBe(200)
  })

  it('with two owners one may remove the other, or themselves; the last one left is then protected', async () => {
    const a = await human('owner', 'a@x.test')
    const b = await human('owner', 'b@x.test')
    await soleOwner()
    const wk = worker()
    expect((await del(wk, await a.session(), (await membership(b.id)).id as string)).status).toBe(200)
    expect((await del(wk, await a.session(), (await membership(a.id)).id as string)).status).toBe(409)
    const c = await human('owner', 'c@x.test')
    // a removes themselves while c remains
    expect((await del(wk, await a.session(), (await membership(a.id)).id as string)).status).toBe(200)
    expect((await call(wk, 'GET', '/meta/v1/me', await a.session())).status).toBe(403)
    expect((await call(wk, 'GET', '/meta/v1/me', await c.session())).status).toBe(200)
    // and an owner demotes themselves while another owner remains
    const d = await human('owner', 'd@x.test')
    expect((await patch(wk, await d.session(), (await membership(d.id)).id as string, { role: 'member' })).status).toBe(200)
  })

  it('drift: the other owner is removed between plan and commit, the in-batch guard refuses and the answer is 409 last_owner with the membership still live', async () => {
    const a = await human('owner', 'a@x.test')
    const b = await human('owner', 'b@x.test')
    await soleOwner()
    const bm = (await membership(b.id)).id as string
    const am = (await membership(a.id)).id as string
    const tok = await a.session()
    for (const act of ['delete', 'demote'] as const) {
      await w.d1.prepare('update memberships set deleted_at = null where id = ?').bind(bm).run()
      const fault = faultD1(w.d1, { match: /update "memberships"/i, act: async () => void (await w.d1.prepare("update memberships set deleted_at = '2026-10-27T11:00:00.000Z' where id = ?").bind(bm).run()) })
      const wk = worker({ crm: fault.d1 })
      const res = act === 'delete' ? await del(wk, tok, am) : await patch(wk, tok, am, { role: 'member' })
      expect(fault.fired(), act).toBe(1)
      expect(res.status, `${act} ${JSON.stringify(res.json)}`).toBe(409)
      expect(res.json.error.code).toBe('last_owner')
      expect(await membership(a.id), act).toMatchObject({ role: 'owner', deleted_at: null })
    }
    expect(await events()).toEqual([])
    expect(await audit('user.sessions_revoked')).toEqual([])
  })
})

describe('owner-issued reset links (P6, P7)', () => {
  const newPassword = 'a brand new password 456'
  const resetPassword = (wk: ReturnType<typeof worker>, token: string, password = newPassword) => call(wk, 'POST', '/auth/reset-password', null, { token, newPassword: password }, { origin: AUTH_BASE })
  const signIn = (wk: ReturnType<typeof worker>, email: string, password: string) => call(wk, 'POST', '/auth/sign-in/email', null, { email, password }, { origin: AUTH_BASE })
  const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')

  it('returns <PUBLIC_BASE_URL>/reset-password#token=...; the token resets the password once, ends the old one, and cannot be used twice', async () => {
    const owner = await human('owner')
    const member = await human('member', 'member@x.test')
    const wk = worker()
    const before = Date.now()
    const res = await reset(wk, await owner.session(), member.id)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(Object.keys(res.json).sort()).toEqual(['expires_at', 'url'])
    const url = new URL(res.json.url)
    expect(url.origin + url.pathname).toBe(`${AUTH_BASE}/reset-password`)
    expect(url.search).toBe('')
    const token = tokenOf(res.json.url)
    expect(token.length).toBeGreaterThan(10)
    // one hour: the answer and the stored verification row agree
    const [v] = await rows(w.control, 'select * from auth_verifications where identifier = ?', `reset-password:${token}`)
    expect(v!.value).toBe(member.subject)
    expect(Math.abs(Date.parse(res.json.expires_at) - (before + 3_600_000))).toBeLessThan(10_000)
    expect(Math.abs(new Date(v!.expires_at).getTime() - Date.parse(res.json.expires_at))).toBeLessThan(2_000)
    expect((await resetPassword(wk, token)).status).toBe(200)
    expect((await signIn(wk, 'member@x.test', newPassword)).status).toBe(200)
    expect((await signIn(wk, 'member@x.test', 'a long enough password 123')).status).toBeGreaterThanOrEqual(400)
    expect((await resetPassword(wk, token, 'another password 789')).status).toBeGreaterThanOrEqual(400)
  })

  it('a use after one hour by the clock is refused', async () => {
    const owner = await human('owner')
    const member = await human('member', 'member@x.test')
    const wk = worker()
    const res = await reset(wk, await owner.session(), member.id)
    expect(res.status).toBe(200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 3_600_000 + 1000)
    expect((await resetPassword(wk, tokenOf(res.json.url))).status).toBeGreaterThanOrEqual(400)
    vi.useRealTimers()
    expect((await signIn(wk, 'member@x.test', 'a long enough password 123')).status).toBe(200)
  })

  it('writes one user.reset_link_issued audit row naming the caller and the Better Auth user, and the token is in no audit detail, no CRM row and no later answer', async () => {
    const owner = await human('owner')
    const member = await human('member', 'member@x.test')
    const wk = worker()
    const res = await reset(wk, await owner.session(), member.id)
    const token = tokenOf(res.json.url)
    const a = await audit('user.reset_link_issued')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ actor_id: owner.id, target_type: 'user', target_id: member.subject })
    expect(Object.keys(JSON.parse(a[0]!.detail))).toEqual(['expires_at'])
    expect(JSON.stringify(await audit())).not.toContain(token)
    expect(JSON.stringify(await dump(w.d1))).not.toContain(token)
    expect(JSON.stringify((await call(wk, 'GET', '/meta/v1/users', await owner.session())).json)).not.toContain(token)
    // no CRM event for the issue
    expect(await events('%')).toEqual([])
  })

  it('an owner may issue one for another owner; each issue is audited', async () => {
    const a = await human('owner', 'a@x.test')
    const b = await human('owner', 'b@x.test')
    const wk = worker()
    expect((await reset(wk, await a.session(), b.id)).status).toBe(200)
    expect((await reset(wk, await a.session(), a.id)).status).toBe(200)
    expect(await audit('user.reset_link_issued')).toHaveLength(2)
  })

  it('an unknown id, a removed member, a Clerk-era user and an agent are each 404 not_found, and nothing is written', async () => {
    const owner = await human('owner')
    const removed = await human('member', 'removed@x.test')
    const wk = worker()
    expect((await del(wk, await owner.session(), (await membership(removed.id)).id as string)).status).toBe(200)
    const clerkId = uuidv7(NOW)
    await seedPrincipal(w.d1, { id: clerkId, kind: 'user', email: 'clerk@x.test', authProvider: 'clerk', authSubject: 'user_clerk' })
    await seedMembership(w.d1, { organizationId: orgId, userId: clerkId, role: 'member' })
    const agent = await agentAccount()
    const auditBefore = (await audit()).length
    const verificationsBefore = (await rows(w.control, 'select id from auth_verifications')).length
    for (const id of [uuidv7(NOW), removed.id, clerkId, agent.id, bootUser]) {
      const res = await reset(wk, await owner.session(), id)
      expect(res.status, id).toBe(404)
      expect(res.json.error.code).toBe('not_found')
    }
    expect((await audit()).length).toBe(auditBefore)
    expect(await rows(w.control, 'select id from auth_verifications')).toHaveLength(verificationsBefore)
    expect((await call(wk, 'POST', RESET, await owner.session(), { user_id: 'not-a-uuid' })).status).toBe(400)
    expect((await call(wk, 'POST', RESET, await owner.session(), {})).status).toBe(400)
  })

  it('the public POST /auth/request-password-reset is refused and writes no verification row, with and without a trusted Origin, before and after an owner issued a link', async () => {
    const owner = await human('owner')
    const member = await human('member', 'member@x.test')
    const wk = worker()
    const count = async () => (await rows(w.control, "select id from auth_verifications where identifier like 'reset-password:%'")).length
    for (const headers of [{}, { origin: AUTH_BASE }, { origin: 'https://evil.test' }]) {
      const res = await call(wk, 'POST', '/auth/request-password-reset', null, { email: 'member@x.test' }, headers)
      expect(res.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(400)
      expect(await count()).toBe(0)
    }
    expect((await reset(wk, await owner.session(), member.id)).status).toBe(200)
    expect(await count()).toBe(1)
    const after = await call(wk, 'POST', '/auth/request-password-reset', null, { email: 'member@x.test' }, { origin: AUTH_BASE })
    expect(after.status).toBeGreaterThanOrEqual(400)
    expect(await count()).toBe(1)
    // an unknown address is refused the same way (no account oracle)
    const unknown = await call(wk, 'POST', '/auth/request-password-reset', null, { email: 'nobody@x.test' }, { origin: AUTH_BASE })
    expect(unknown.status).toBe(after.status)
  })
})

describe('scope and provider gating', () => {
  it('members:write is declared, owner-held, not a member scope, not agent-grantable and has consent text', async () => {
    expect(declared).toContain('members:write')
    expect(SCOPE_POLICY['members:write']).toEqual({ member: false, agentGrantable: false })
    expect(grantableScopes(declared)).not.toContain('members:write')
    expect(() => assertAgentGrantable(['members:write'], declared)).toThrow(/not grantable/)
    expect(scopesForRole('member', declared).toStrings()).not.toContain('members:write')
    expect(scopesForRole('owner', declared).toStrings()).toContain('members:write')
    const { SCOPE_DESCRIPTIONS } = await import('@vibase/api')
    expect(SCOPE_DESCRIPTIONS['members:write']).toMatch(/\S/)
    // an owner granting it to an agent is refused
    const owner = await human('owner')
    const agent = await agentAccount()
    const res = await call(worker(), 'PATCH', `/meta/v1/agents/${agent.id}`, await owner.session(), { scopes: ['contacts:read', 'members:write'] })
    expect(res.status, JSON.stringify(res.json)).toBe(400)
    expect(JSON.stringify(res.json)).toContain('members:write')
  })

  type Who = 'member session' | 'agent account' | 'delegated agent' | 'API-key agent'
  const who = ['member session', 'agent account', 'delegated agent', 'API-key agent'] as const satisfies readonly Who[]
  const ops = ['update', 'delete', 'reset'] as const
  it.each(ops.flatMap((op) => who.map((x) => [op, x] as const)))('%s as %s is 403 insufficient_scope naming members:write and changes nothing', async (op, which) => {
    const owner = await human('owner')
    const target = await human('member', 'target@x.test')
    const mid = (await membership(target.id)).id as string
    const token: Record<Who, () => Promise<string>> = {
      'member session': async () => (await human('member', 'm@x.test')).session(),
      'agent account': async () => (await agentAccount()).session(),
      'delegated agent': async () => (await owner.tokens(otherClient, 'openid contacts:read')).access_token,
      'API-key agent': async () => bootKey,
    }
    const wk = worker()
    const crmBefore = JSON.stringify(await dump(w.d1))
    const controlBefore = (await audit()).length
    const tok = await token[which]()
    const res = op === 'update' ? await patch(wk, tok, mid, { role: 'owner' }) : op === 'delete' ? await del(wk, tok, mid) : await reset(wk, tok, target.id)
    expect(res.status, JSON.stringify(res.json)).toBe(403)
    expect(res.json.error.code).toBe('insufficient_scope')
    expect(res.json.error.message).toContain('members:write')
    expect(JSON.stringify(await dump(w.d1))).toBe(crmBefore)
    expect((await audit()).length).toBe(controlBefore)
  })

  it('OpenAPI lists the three operations; MCP lists the three tools for an owner only and tools/call answers as REST does', async () => {
    const owner = await human('owner')
    const member = await human('member', 'm2@x.test')
    const wk = worker()
    const doc = (await call(wk, 'GET', '/meta/v1/openapi.json', null)).json
    expect(doc.paths[`/meta/v1/memberships/{id}`].patch.operationId).toBe('memberships.update')
    expect(doc.paths[`/meta/v1/memberships/{id}`].delete.operationId).toBe('memberships.delete')
    expect(doc.paths[RESET].post.operationId).toBe('users.issue_reset_link')
    const rpc = async (tok: string, method: string, params?: unknown) => call(wk, 'POST', '/mcp', tok, { jsonrpc: '2.0', id: 1, method, params })
    const names = async (tok: string) => ((await rpc(tok, 'tools/list')).json.result.tools as Array<{ name: string }>).map((t) => t.name).filter((n) => ['memberships_update', 'memberships_delete', 'users_issue_reset_link'].includes(n)).sort()
    expect(await names(await owner.session())).toEqual(['memberships_delete', 'memberships_update', 'users_issue_reset_link'])
    expect(await names(await member.session())).toEqual([])
    const mid = (await membership(member.id)).id as string
    const out = (await rpc(await owner.session(), 'tools/call', { name: 'memberships_update', arguments: { id: mid, role: 'owner' } })).json.result
    expect(out.isError ?? false).toBe(false)
    expect((out.structuredContent ?? JSON.parse(out.content[0].text)).role).toBe('owner')
    const link = (await rpc(await owner.session(), 'tools/call', { name: 'users_issue_reset_link', arguments: { user_id: member.id } })).json.result
    expect(link.isError ?? false).toBe(false)
    expect((link.structuredContent ?? JSON.parse(link.content[0].text)).url).toContain('/reset-password#token=')
  })
})

describe('a composition without a control store', () => {
  let clerk: ClerkKit
  let single: Awaited<ReturnType<typeof openWorkerD1>>
  beforeAll(async () => {
    clerk = await clerkKit()
    single = await openWorkerD1()
  })
  afterAll(() => single.dispose())

  it('on Clerk the three operations refuse with 501 provider_not_configured and nothing is written', async () => {
    const issuer = clerk.issuer.issuer
    await single.d1.batch([
      single.d1.prepare('insert into deployment (singleton, organization_id, auth_provider, auth_org_id) values (1, ?, ?, ?)').bind(orgId, 'clerk', issuer),
      single.d1.prepare('insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)').bind(orgId, NOW.toISOString(), NOW.toISOString(), 'Acme', 'clerk', issuer),
    ])
    const wk = composeD1Worker({ DB: single.d1, ...clerk.env, CLERK_WEBHOOK_SECRET: undefined }, { fetch: clerk.fetch })
    const tok = await mintClerkToken(clerk.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' } })
    clerk.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true }))
    const req = (method: string, path: string, body?: unknown) => wk.fetch(new Request(`https://w.test${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
    for (const res of [await req('PATCH', `${PATH}/${uuidv7(NOW)}`, { role: 'member' }), await req('DELETE', `${PATH}/${uuidv7(NOW)}`), await req('POST', RESET, { user_id: uuidv7(NOW) })]) {
      expect(res.status).toBe(501)
      expect(((await res.json()) as any).error.code).toBe('provider_not_configured')
    }
    expect(await rows(single.d1, "select id from events where type like 'membership.%'")).toEqual([])
  })
})
