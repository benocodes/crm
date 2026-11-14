import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createInvitation, openControlDb, revokeInvitation, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { createVibaseRegistry, scopesForRole } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE287]] P1-P7 through the real Worker composition (`better-auth`, no test admission): the sign-up gate, acceptance per role, the commit order, repair on sign-in and the paths
// that must stay as they were. The accounts come from the REAL Better Auth handler on the control-plane database; the CRM database is the real migrated D1.
const CODE = 'invitation_required'
const PASSWORD = 'a long enough password 123'
const DAY = 86_400_000
let w: WorkerPair
let orgId: string
let systemId: string
let ownerToken: string
let n = 0
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')
const iso = (ms: number) => new Date(ms).toISOString()
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) => ((await d1.prepare(text).bind(...binds).all()).results ?? []) as Array<Record<string, any>>
const crm = (text: string, ...binds: unknown[]) => rows(w.d1, text, ...binds)
const ctl = (text: string, ...binds: unknown[]) => rows(w.control, text, ...binds)
const count = async (d1: D1Like, t: string) => Number((await rows(d1, `select count(*) n from "${t}"`))[0]!.n)
const AUTH_ROWS = ['auth_users', 'auth_accounts', 'auth_sessions']
const authCounts = async () => Object.fromEntries(await Promise.all(AUTH_ROWS.map(async (t) => [t, await count(w.control, t)])))
const dump = async (d1: D1Like) => {
  const tables = (await rows(d1, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'auth_rate%' and name not like 'auth_jwks'")).map((r) => r.name as string)
  const all: Record<string, unknown[]> = {}
  for (const t of tables) all[t] = await rows(d1, `select * from "${t}" order by 1`)
  return all
}

/** A D1 whose batches throw while `fail.on` and any statement writes the named tables: an injected failure of the CRM acceptance program. */
function flaky(real: D1Like, fail: { on: boolean }): D1Like {
  const sqlOf = new WeakMap<object, string>()
  return {
    prepare(query: string) {
      const p = real.prepare(query)
      return { bind: (...v: unknown[]) => { const b = p.bind(...v); sqlOf.set(b, query); return b }, run: () => p.run(), all: () => p.all(), first: () => p.first() } as D1PreparedLike
    },
    async batch(batch: D1PreparedLike[]) {
      if (fail.on && batch.some((s) => /insert\s+into\s+"?(memberships|agents)"?/i.test(sqlOf.get(s) ?? ''))) throw new Error('injected failure')
      return real.batch(batch)
    },
  }
}

let fail: { on: boolean }
let clock: () => Date
const worker = (over: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: flaky(w.d1, fail), CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, ...over }, { clock: () => clock() })
let wk: ReturnType<typeof worker>
const send = (path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) =>
  wk.fetch(
    new Request(AUTH_BASE + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { origin: AUTH_BASE, 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  )
const signUp = (email: string, token?: string, extra: Record<string, unknown> = {}) => send('/auth/sign-up/email', { body: { name: 'Ann Tester', email, password: PASSWORD, ...(token === undefined ? {} : { invitation_token: token }), ...extra } })
const signIn = (email: string) => send('/auth/sign-in/email', { body: { email, password: PASSWORD } })
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!
const me = async (cookie: string) => {
  const jwt = ((await (await send('/auth/token', { cookie })).json()) as { token: string }).token
  const res = await send('/meta/v1/me', { bearer: jwt })
  return { status: res.status, json: (await res.json()) as any }
}

/** A control-plane invitation at a chosen clock, with a known token (the store only keeps its hash). */
async function invite(email: string, role: 'owner' | 'member' | 'agent', o: { createdAt?: number; expiresAt?: number; state?: 'revoked' | 'accepted' } = {}) {
  const t = o.createdAt ?? Date.now()
  const id = uuidv7()
  const token = `token-${id}`
  expect(await createInvitation(openControlDb(w.control), { id, auditId: uuidv7(), organizationId: orgId, email, role, tokenHash: sha256(token), expiresAt: iso(o.expiresAt ?? t + 7 * DAY), createdBy: systemId, now: iso(t) })).toBe('created')
  if (o.state === 'revoked') await revokeInvitation(openControlDb(w.control), { id, auditId: uuidv7(), actorId: systemId, now: iso(Date.now()) })
  if (o.state === 'accepted') await w.control.prepare('update invitations set accepted_at = ? where id = ?').bind(iso(Date.now()), id).run()
  return { id, token }
}

beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  fail = { on: false }
  clock = () => new Date()
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE, ownerEmail: 'owner@x.test' }, { control: openControlDb(w.control) })
  orgId = r.organizationId
  ownerToken = tokenOf(r.ownerInvitation!.url)
  systemId = (await crm("select id from principals where kind = 'system'"))[0]!.id
  wk = worker()
})

describe('the gate (P1, P2)', () => {
  const REFUSED = { code: CODE }
  const causes: Array<[string, () => Promise<{ email: string; token?: string }>]> = [
    ['no token', async () => ({ email: 'owner@x.test' })],
    ['an unknown token', async () => ({ email: 'owner@x.test', token: 'not-a-token' })],
    ['a live token for another email', async () => ({ email: 'other@x.test', token: ownerToken })],
    ['an expired invitation', async () => ({ email: 'late@x.test', token: (await invite('late@x.test', 'member', { createdAt: Date.now() - 9 * DAY, expiresAt: Date.now() - 2 * DAY })).token })],
    ['a revoked invitation', async () => ({ email: 'gone@x.test', token: (await invite('gone@x.test', 'member', { state: 'revoked' })).token })],
    ['an accepted invitation', async () => ({ email: 'used@x.test', token: (await invite('used@x.test', 'member', { state: 'accepted' })).token })],
  ]
  it.each(causes)('%s: 403 with the one code and no auth row', async (_name, make) => {
    const a = await make()
    const before = await authCounts()
    const res = await signUp(a.email, a.token)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject(REFUSED)
    expect(await authCounts()).toEqual(before)
  })

  it('no invitations at all (the empty state): 403 with the same code and no auth row', async () => {
    await w.control.prepare('delete from invitations').run()
    const res = await signUp('first@x.test', 'anything')
    expect([res.status, ((await res.json()) as any).code ?? null]).toEqual([403, CODE])
    expect(await authCounts()).toEqual({ auth_users: 0, auth_accounts: 0, auth_sessions: 0 })
  })

  it('the refusal body is identical for every cause (no oracle on which invitations exist)', async () => {
    const bodies = new Set<string>()
    for (const [, make] of causes) {
      const a = await make()
      const res = await signUp(a.email, a.token)
      bodies.add(`${res.status} ${JSON.stringify(await res.json())}`)
    }
    expect([...bodies]).toHaveLength(1)
    expect([...bodies][0]).toMatch(/^403 /)
  })

  it('a live token for that email, differently cased, creates the account and a session', async () => {
    const res = await signUp('Owner@X.test', ownerToken)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('session')
    expect(await authCounts()).toMatchObject({ auth_users: 1, auth_accounts: 1 })
  })

  it('an email that already has an account is refused with the same 403 without a token (no account-existence oracle)', async () => {
    expect((await signUp('owner@x.test', ownerToken)).status).toBe(200)
    const again = await signUp('owner@x.test')
    expect(again.status).toBe(403)
    expect(await again.json()).toMatchObject(REFUSED)
  })
})

describe('acceptance per role (P3)', () => {
  it.each(['owner', 'member', 'agent'] as const)('%s: the vault rows, the one event, the token resolving to that principal', async (role) => {
    const email = `${role}@x.test`
    const token = role === 'owner' ? ownerToken : (await invite(email, role)).token
    const crmBefore = await crm('select count(*) n from events')
    const res = await signUp(email, token)
    expect(res.status, await res.clone().text()).toBe(200)
    const subject = ((await res.json()) as any).user.id as string
    const cookie = cookieOf(res)

    const events = (await crm('select * from events order by id')).filter((e) => e.type === 'membership.created' || e.type === 'agent.created')
    expect(events.map((e) => e.type)).toEqual([role === 'agent' ? 'agent.created' : 'membership.created'])
    expect(JSON.stringify(events)).not.toContain(token)
    expect(await crm('select count(*) n from events')).not.toEqual(crmBefore)

    if (role === 'agent') {
      const agent = (await crm('select * from agents where auth_subject = ?', subject))[0]!
      expect(agent).toEqual({ id: agent.id, created_at: agent.created_at, updated_at: agent.created_at, organization_id: orgId, name: 'Ann Tester', scopes: '[]', disabled_at: null, created_by: systemId, auth_provider: 'better-auth', auth_subject: subject, auth_client_id: null, delegated_by: null })
      expect((await crm('select kind from principals where id = ?', agent.id))[0]).toEqual({ kind: 'agent' })
      expect(await count(w.d1, 'memberships')).toBe(0)
      expect(await count(w.d1, 'users')).toBe(0)
      expect(events[0]!.resource_id).toBe(agent.id)
      const got = await me(cookie)
      expect([got.status, got.json.principal.kind, got.json.principal.id]).toEqual([200, 'agent', agent.id])
      expect(got.json.active_organization.scopes).toEqual([])
    } else {
      const user = (await crm('select * from users where auth_subject = ?', subject))[0]!
      expect(user).toEqual({ id: user.id, created_at: user.created_at, updated_at: user.created_at, email, name: 'Ann Tester', auth_provider: 'better-auth', auth_subject: subject, email_verified: 0 })
      expect((await crm('select kind from principals where id = ?', user.id))[0]).toEqual({ kind: 'user' })
      const m = await crm('select * from memberships')
      expect(m).toEqual([{ id: m[0]!.id, created_at: user.created_at, updated_at: user.created_at, organization_id: orgId, user_id: user.id, role, created_by: systemId, deleted_at: null }])
      expect(events[0]!.resource_id).toBe(m[0]!.id)
      expect(await count(w.d1, 'agents')).toBe(0)
      const got = await me(cookie)
      expect(got.status, JSON.stringify(got.json)).toBe(200)
      expect([got.json.principal.kind, got.json.principal.id, got.json.active_organization.role]).toEqual(['user', user.id, role])
      expect(got.json.active_organization.scopes).toEqual(scopesForRole(role, createVibaseRegistry().declaredScopes()).toStrings())
    }
  })

  it('an agent account holds no scopes: its session token is admitted as an agent but every resource scope is refused', async () => {
    const { token } = await invite('bot@x.test', 'agent')
    const res = await signUp('bot@x.test', token)
    expect(res.status).toBe(200)
    const jwt = ((await (await send('/auth/token', { cookie: cookieOf(res) })).json()) as { token: string }).token
    const contacts = await send('/api/v1/contacts', { bearer: jwt })
    expect(contacts.status).toBe(403)
  })
})

describe('commit order and single use (P3, P4)', () => {
  it('an injected CRM failure leaves the account, the invitation pending, no audit row and no CRM row', async () => {
    fail.on = true
    const res = await signUp('owner@x.test', ownerToken)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await authCounts()).toMatchObject({ auth_users: 1, auth_accounts: 1 })
    const inv = (await ctl('select * from invitations'))[0]!
    expect(inv.accepted_at).toBeNull()
    expect(await ctl("select * from control_audit where action = 'invitation.accepted'")).toEqual([])
    for (const t of ['users', 'memberships']) expect(await count(w.d1, t), t).toBe(0)
    expect(await crm("select * from events where type = 'membership.created'")).toEqual([])
  })

  it('after success: accepted_at set, one invitation.accepted audit row by the new principal with no token or hash, and the same token then refuses', async () => {
    const res = await signUp('owner@x.test', ownerToken)
    expect(res.status).toBe(200)
    const user = (await crm('select id from users'))[0]!
    const inv = (await ctl('select * from invitations'))[0]!
    expect(inv.accepted_at).not.toBeNull()
    const audit = await ctl("select * from control_audit where action = 'invitation.accepted'")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: user.id, target_type: 'invitation', target_id: inv.id })
    expect(JSON.parse(audit[0]!.detail)).toEqual({ email: 'owner@x.test', role: 'owner', expires_at: inv.expires_at })
    expect(audit[0]!.detail).not.toContain(ownerToken)
    expect(audit[0]!.detail).not.toContain(inv.token_hash)
    const again = await signUp('owner@x.test', ownerToken)
    expect([again.status, ((await again.json()) as any).code]).toEqual([403, CODE])
    expect(await count(w.control, 'auth_users')).toBe(1)
    const list = await send('/meta/v1/invitations', { bearer: ((await (await send('/auth/token', { cookie: cookieOf(res) })).json()) as { token: string }).token })
    expect(((await list.json()) as any).data[0].status).toBe('accepted')
  })
})

describe('repair on sign-in (P5)', () => {
  /** An orphan: an account with no CRM rows (the test kit's open admission), as an interrupted acceptance leaves one. */
  async function orphan(email: string) {
    const kit: AuthKit = authKit(w.control)
    const { userId } = await kit.signUp(email)
    return userId
  }
  const accountCreatedAt = async (userId: string) => {
    const raw = (await ctl('select created_at from auth_users where id = ?', userId))[0]!.created_at
    return typeof raw === 'number' ? raw : Date.parse(raw)
  }

  it('an orphan with its live admitting invitation is repaired by a password sign-in, exactly once over two sign-ins', async () => {
    const userId = await orphan('owner@x.test')
    const first = await signIn('owner@x.test')
    expect(first.status, await first.clone().text()).toBe(200)
    expect((await signIn('owner@x.test')).status).toBe(200)
    expect(await crm('select auth_subject from users')).toEqual([{ auth_subject: userId }])
    expect(await count(w.d1, 'memberships')).toBe(1)
    expect(await crm("select * from events where type = 'membership.created'")).toHaveLength(1)
    expect(await ctl("select * from control_audit where action = 'invitation.accepted'")).toHaveLength(1)
    expect((await ctl('select accepted_at from invitations'))[0]!.accepted_at).not.toBeNull()
    expect((await me(cookieOf(first))).status).toBe(200)
  })

  it('the repair after an injected sign-up failure completes the same acceptance', async () => {
    fail.on = true
    expect((await signUp('owner@x.test', ownerToken)).status).toBeGreaterThanOrEqual(400)
    fail.on = false
    const res = await signIn('owner@x.test')
    expect(res.status).toBe(200)
    expect(await count(w.d1, 'memberships')).toBe(1)
    expect(await ctl("select * from control_audit where action = 'invitation.accepted'")).toHaveLength(1)
  })

  it.each([
    ['revoked', async () => void (await w.control.prepare('update invitations set revoked_at = ?').bind(iso(Date.now())).run())],
    ['expired', async () => void (await w.control.prepare('update invitations set expires_at = ?, created_at = ?').bind(iso(Date.now() - 1000), iso(Date.now() - 8 * DAY)).run())],
    ['absent', async () => void (await w.control.prepare('delete from invitations').run())],
  ] as Array<[string, () => Promise<void>]>)('the admitting invitation %s: sign-in writes nothing and /meta/v1/me stays 403', async (_name, spoil) => {
    await orphan('owner@x.test')
    await spoil()
    const crmBefore = await dump(w.d1)
    const ctlBefore = (await dump(w.control)) as Record<string, unknown[]>
    const res = await signIn('owner@x.test')
    expect(res.status).toBe(200)
    expect(await dump(w.d1)).toEqual(crmBefore)
    const after = (await dump(w.control)) as Record<string, unknown[]>
    for (const t of Object.keys(ctlBefore).filter((t) => !t.startsWith('auth_'))) expect(after[t], t).toEqual(ctlBefore[t])
    const got = await me(cookieOf(res))
    expect([got.status, got.json.error?.code]).toEqual([403, 'organization_forbidden'])
  })

  it('no invitation at all, or only a live one created after the account, writes nothing (the created-before rule, within the same second)', async () => {
    const userId = await orphan('late@x.test')
    const at = await accountCreatedAt(userId)
    // The invitation is minted 300 ms AFTER the account: a different encoding of the same second must still read as later.
    await invite('late@x.test', 'member', { createdAt: at + 300 })
    const before = await dump(w.d1)
    const res = await signIn('late@x.test')
    expect(res.status).toBe(200)
    expect(await dump(w.d1)).toEqual(before)
    expect(await ctl("select * from control_audit where action = 'invitation.accepted'")).toEqual([])
    expect((await me(cookieOf(res))).status).toBe(403)

    await orphan('nobody@x.test')
    const none = await signIn('nobody@x.test')
    expect(none.status).toBe(200)
    expect(await dump(w.d1)).toEqual(before)
  })

  it('an invitation created 300 ms BEFORE the account (same second) admits it', async () => {
    const userId = await orphan('early@x.test')
    const at = await accountCreatedAt(userId)
    await invite('early@x.test', 'member', { createdAt: at - 300 })
    expect((await signIn('early@x.test')).status).toBe(200)
    expect(await count(w.d1, 'memberships')).toBe(1)
  })

  it('a linked subject never re-runs acceptance: its sign-in leaves every CRM and control row unchanged', async () => {
    expect((await signUp('owner@x.test', ownerToken)).status).toBe(200)
    // A later live invitation for the same address (created after acceptance) must not be adopted by the linked subject.
    await invite('owner@x.test', 'member', { createdAt: Date.now() - 5000 })
    const crmBefore = await dump(w.d1)
    const ctlBefore = (await dump(w.control)) as Record<string, unknown[]>
    expect((await signIn('owner@x.test')).status).toBe(200)
    expect(await dump(w.d1)).toEqual(crmBefore)
    const after = (await dump(w.control)) as Record<string, unknown[]>
    for (const t of Object.keys(ctlBefore).filter((t) => !t.startsWith('auth_'))) expect(after[t], t).toEqual(ctlBefore[t])
  })
})

describe('the shipped composition and the existing paths', () => {
  it('token resolution creates no row for an orphan, even when a repairable invitation exists (CORE244 P2)', async () => {
    const kit = authKit(w.control)
    const { cookie } = await kit.signUp('owner@x.test')
    const before = await dump(w.d1)
    const got = await me(cookie)
    expect([got.status, got.json.error?.code]).toEqual([403, 'organization_forbidden'])
    expect(await dump(w.d1)).toEqual(before)
  })

  it("bootstrap's re-run after the owner has accepted issues nothing", async () => {
    expect((await signUp('owner@x.test', ownerToken)).status).toBe(200)
    const again = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE, ownerEmail: 'owner@x.test' }, { control: openControlDb(w.control) })
    expect(again.ownerInvitation).toBeNull()
    expect(await count(w.control, 'invitations')).toBe(1)
  })
})
