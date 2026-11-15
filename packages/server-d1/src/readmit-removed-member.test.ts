import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createInvitation, openControlDb, revokeInvitation, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { createVibaseRegistry, scopesForRole } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE302]] / [[CORE243]] D14 P1-P6: re-admitting a removed member on `better-auth`, through the real Worker composition. A removed member's account and `users` row stay; an invitation token
// presented on a sign-in (the `vibase-invitation` header on `/auth/sign-in/email`: Better Auth's sign-in body schema strips unknown fields, proven by this file's first test) restores a membership
// with the invitation's role. Anything that does not re-admit is ignored and the sign-in kept.
const PASSWORD = 'a long enough password 123'
const DAY = 86_400_000
const CARRIER = 'vibase-invitation'
let w: WorkerPair
let orgId: string
let systemId: string
let ownerToken: string
let ownerJwt: string
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
const dump = async (d1: D1Like, only?: (t: string) => boolean) => {
  const tables = (await rows(d1, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'")).map((r) => r.name as string).filter((t) => (only ? only(t) : true))
  const all: Record<string, unknown[]> = {}
  for (const t of tables) all[t] = await rows(d1, `select * from "${t}" order by 1`)
  return all
}
const controlState = () => dump(w.control, (t) => !t.startsWith('auth_'))

function flaky(real: D1Like, match: (sql: string) => boolean, fail: { on: boolean }): D1Like {
  const sqlOf = new WeakMap<object, string>()
  return {
    prepare(query: string) {
      const p = real.prepare(query)
      return { bind: (...v: unknown[]) => { const b = p.bind(...v); sqlOf.set(b, query); return b }, run: () => p.run(), all: () => p.all(), first: () => p.first() } as D1PreparedLike
    },
    async batch(batch: D1PreparedLike[]) {
      if (fail.on && batch.some((s) => match(sqlOf.get(s) ?? ''))) throw new Error('injected failure')
      return real.batch(batch)
    },
  }
}
const failCrm = { on: false }
const failControl = { on: false }
let clock: () => Date
const worker = () =>
  composeD1Worker(
    {
      DB: flaky(w.d1, (s) => /insert\s+into\s+"?memberships"?/i.test(s), failCrm),
      CONTROL_DB: flaky(w.control, (s) => /update\s+invitations\s+set\s+accepted_at/i.test(s), failControl),
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
    },
    { clock: () => clock() },
  )
let wk: ReturnType<typeof worker>
const send = (path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {}) =>
  wk.fetch(
    new Request(AUTH_BASE + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { origin: AUTH_BASE, 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  )
const signUp = (email: string, token: string) => send('/auth/sign-up/email', { body: { name: 'Ann Tester', email, password: PASSWORD, invitation_token: token } })
const signIn = (email: string, token?: string) => send('/auth/sign-in/email', { body: { email, password: PASSWORD }, headers: token === undefined ? {} : { [CARRIER]: token } })
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!
const jwtOf = async (cookie: string) => ((await (await send('/auth/token', { cookie })).json()) as { token: string }).token
const me = async (cookie: string) => {
  const res = await send('/meta/v1/me', { bearer: await jwtOf(cookie) })
  return { status: res.status, json: (await res.json()) as any }
}

async function invite(email: string, role: 'owner' | 'member' | 'agent', o: { createdAt?: number; expiresAt?: number; state?: 'revoked' | 'accepted'; delivery?: 'link' | 'email' } = {}) {
  const t = o.createdAt ?? Date.now()
  const id = uuidv7()
  const token = `token-${id}`
  expect(await createInvitation(openControlDb(w.control), { id, auditId: uuidv7(), organizationId: orgId, email, role, tokenHash: sha256(token), expiresAt: iso(o.expiresAt ?? t + 7 * DAY), createdBy: systemId, now: iso(t), delivery: o.delivery })).toBe('created')
  if (o.state === 'revoked') await revokeInvitation(openControlDb(w.control), { id, auditId: uuidv7(), actorId: systemId, now: iso(Date.now()) })
  if (o.state === 'accepted') await w.control.prepare('update invitations set accepted_at = ? where id = ?').bind(iso(Date.now()), id).run()
  return { id, token }
}

/** Admits `email` as `role` through the real sign-up, then the owner removes the membership through `memberships.delete`. */
async function admitAndRemove(email: string, role: 'owner' | 'member', o: { delivery?: 'link' | 'email' } = {}) {
  const { token } = await invite(email, role, o)
  const up = await signUp(email, token)
  expect(up.status, await up.clone().text()).toBe(200)
  const userId = (await crm('select id from users where email = ?', email))[0]!.id as string
  const membership = (await crm('select * from memberships where user_id = ? and deleted_at is null', userId))[0]!
  const del = await send(`/meta/v1/memberships/${membership.id}`, { method: 'DELETE', bearer: ownerJwt })
  expect(del.status, await del.clone().text()).toBe(200)
  return { userId, oldMembershipId: membership.id as string, subject: ((await up.json()) as any).user.id as string }
}

beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  failCrm.on = false
  failControl.on = false
  clock = () => new Date()
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE, ownerEmail: 'owner@x.test' }, { control: openControlDb(w.control) })
  orgId = r.organizationId
  ownerToken = tokenOf(r.ownerInvitation!.url)
  systemId = (await crm("select id from principals where kind = 'system'"))[0]!.id
  wk = worker()
  const up = await signUp('owner@x.test', ownerToken)
  expect(up.status).toBe(200)
  ownerJwt = await jwtOf(cookieOf(up))
})

describe('the token carrier (P1)', () => {
  it("Better Auth's sign-in body schema strips an `invitation_token` field, so the token cannot ride the body: only the header re-admits", async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const { token } = await invite('p@x.test', 'member')
    const inBody = await send('/auth/sign-in/email', { body: { email: 'p@x.test', password: PASSWORD, invitation_token: token } })
    expect(inBody.status).toBe(200)
    expect(await crm('select * from memberships where user_id = ? and deleted_at is null', p.userId)).toEqual([])
    const inHeader = await signIn('p@x.test', token)
    expect(inHeader.status).toBe(200)
    expect(await crm('select * from memberships where user_id = ? and deleted_at is null', p.userId)).toHaveLength(1)
  })
})

describe('re-admission by password (P1, P2)', () => {
  it.each([
    ['member', 'member'],
    ['member', 'owner'],
    ['owner', 'member'],
  ] as const)('removed as %s, re-invited as %s: a new membership with the invitation role, the removed row kept, one event, one audit row', async (removedAs, invitedAs) => {
    const p = await admitAndRemove('p@x.test', removedAs)
    const removedRow = (await crm('select * from memberships where id = ?', p.oldMembershipId))[0]!
    expect(removedRow.deleted_at).not.toBeNull()
    const userBefore = (await crm('select * from users where id = ?', p.userId))[0]!
    const principalsBefore = await count(w.d1, 'principals')
    const usersBefore = await count(w.d1, 'users')
    const createdBefore = (await crm("select id from events where type = 'membership.created'")).map((e) => e.id)
    const { id: invId, token } = await invite('p@x.test', invitedAs)

    const res = await signIn('p@x.test', token)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('session')

    const all = await crm('select * from memberships where user_id = ? order by created_at, id', p.userId)
    expect(all).toHaveLength(2)
    expect(all.find((m) => m.id === p.oldMembershipId)).toEqual(removedRow)
    const fresh = all.find((m) => m.id !== p.oldMembershipId)!
    expect(fresh).toEqual({ id: fresh.id, created_at: expect.any(String), updated_at: fresh.created_at, organization_id: orgId, user_id: p.userId, role: invitedAs, created_by: systemId, deleted_at: null })
    const created = (await crm("select * from events where type = 'membership.created'")).filter((e) => !createdBefore.includes(e.id))
    expect(created).toHaveLength(1)
    expect(created[0]!.resource_id).toBe(fresh.id)
    expect(await count(w.d1, 'principals')).toBe(principalsBefore)
    expect(await count(w.d1, 'users')).toBe(usersBefore)
    expect((await crm('select * from users where id = ?', p.userId))[0]).toEqual(userBefore)

    expect((await ctl('select accepted_at from invitations where id = ?', invId))[0]!.accepted_at).not.toBeNull()
    const audit = await ctl("select * from control_audit where action = 'invitation.accepted' and target_id = ?", invId)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_id).toBe(p.userId)
    const inv = (await ctl('select token_hash from invitations where id = ?', invId))[0]!
    expect(audit[0]!.detail).not.toContain(token)
    expect(audit[0]!.detail).not.toContain(inv.token_hash)
    expect(JSON.stringify(created)).not.toContain(token)

    const got = await me(cookieOf(await signIn('p@x.test')))
    expect(got.status, JSON.stringify(got.json)).toBe(200)
    expect(got.json.active_organization.role).toBe(invitedAs)
    expect(got.json.active_organization.scopes).toEqual(scopesForRole(invitedAs, createVibaseRegistry().declaredScopes()).toStrings())
  })

  it('an invitation with delivery "email" turns email_verified true; a link one leaves it as it was (false stays false, true stays true)', async () => {
    const a = await admitAndRemove('a@x.test', 'member')
    const b = await admitAndRemove('b@x.test', 'member')
    const c = await admitAndRemove('c@x.test', 'member')
    await w.d1.prepare('update users set email_verified = 1 where id = ?').bind(c.userId).run()
    expect((await signIn('a@x.test', (await invite('a@x.test', 'member', { delivery: 'email' })).token)).status).toBe(200)
    expect((await signIn('b@x.test', (await invite('b@x.test', 'member', { delivery: 'link' })).token)).status).toBe(200)
    expect((await signIn('c@x.test', (await invite('c@x.test', 'member', { delivery: 'link' })).token)).status).toBe(200)
    const verified = async (id: string) => (await crm('select email_verified v from users where id = ?', id))[0]!.v
    expect([await verified(a.userId), await verified(b.userId), await verified(c.userId)]).toEqual([1, 0, 1])
    for (const id of [a.userId, b.userId, c.userId]) expect(await crm('select id from memberships where user_id = ? and deleted_at is null', id)).toHaveLength(1)
  })
})

describe('tokens that do not re-admit are ignored (P3)', () => {
  type Arranged = { email: string; token?: string; meStatus: number }
  const removed = async () => (await admitAndRemove('p@x.test', 'member'), 'p@x.test')
  const cases: Array<[string, () => Promise<Arranged>]> = [
    ['no invitations at all (the empty state)', async () => (await removed(), await w.control.prepare('delete from invitations').run(), { email: 'p@x.test', token: 'anything', meStatus: 403 })],
    ['no token (a live invitation exists)', async () => (await removed(), await invite('p@x.test', 'member'), { email: 'p@x.test', meStatus: 403 })],
    ['an unknown token', async () => (await removed(), await invite('p@x.test', 'member'), { email: 'p@x.test', token: 'not-a-token', meStatus: 403 })],
    ['a live token for another email', async () => (await removed(), { email: 'p@x.test', token: (await invite('other@x.test', 'member')).token, meStatus: 403 })],
    [
      'an expired token (its expiry passed)',
      async () => (await removed(), { email: 'p@x.test', token: (await invite('p@x.test', 'member', { createdAt: Date.now() - 9 * DAY, expiresAt: Date.now() - 2 * DAY })).token, meStatus: 403 }),
    ],
    ['a revoked token', async () => (await removed(), { email: 'p@x.test', token: (await invite('p@x.test', 'member', { state: 'revoked' })).token, meStatus: 403 })],
    ['an already accepted token', async () => (await removed(), { email: 'p@x.test', token: (await invite('p@x.test', 'member', { state: 'accepted' })).token, meStatus: 403 })],
    ['an agent invitation for the removed human\'s email', async () => (await removed(), { email: 'p@x.test', token: (await invite('p@x.test', 'agent')).token, meStatus: 403 })],
    [
      'a subject with a live membership presenting a live token for its email (role unchanged, invitation stays pending)',
      async () => {
        expect((await signUp('m@x.test', (await invite('m@x.test', 'member')).token)).status).toBe(200)
        return { email: 'm@x.test', token: (await invite('m@x.test', 'owner')).token, meStatus: 200 }
      },
    ],
    [
      'a subject linked to an agent account',
      async () => {
        expect((await signUp('bot@x.test', (await invite('bot@x.test', 'agent')).token)).status).toBe(200)
        return { email: 'bot@x.test', token: (await invite('bot@x.test', 'member')).token, meStatus: 200 }
      },
    ],
    [
      'an unlinked orphan account created before the invitation (CORE287 P7: never adopted)',
      async () => {
        await authKit(w.control).signUp('orphan@x.test')
        await new Promise((r) => setTimeout(r, 20))
        return { email: 'orphan@x.test', token: (await invite('orphan@x.test', 'member')).token, meStatus: 403 }
      },
    ],
  ]
  it.each(cases)('%s: a session, nothing written, the invitation untouched', async (_name, arrange) => {
    const a = await arrange()
    const crmBefore = await dump(w.d1)
    const ctlBefore = await controlState()
    const res = await signIn(a.email, a.token)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('session')
    expect(await dump(w.d1)).toEqual(crmBefore)
    expect(await controlState()).toEqual(ctlBefore)
    const got = await me(cookieOf(res))
    expect(got.status).toBe(a.meStatus)
    if (a.meStatus === 403) expect(got.json.error?.code).toBe('organization_forbidden')
  })

  it('a live member keeps their role: /meta/v1/me still says member after presenting an owner token', async () => {
    expect((await signUp('m@x.test', (await invite('m@x.test', 'member')).token)).status).toBe(200)
    const { token, id } = await invite('m@x.test', 'owner')
    const res = await signIn('m@x.test', token)
    expect((await me(cookieOf(res))).json.active_organization.role).toBe('member')
    expect((await ctl('select accepted_at from invitations where id = ?', id))[0]!.accepted_at).toBeNull()
  })
})

describe('partial states and races (P4)', () => {
  const liveCount = (userId: string) => crm('select id from memberships where user_id = ? and deleted_at is null', userId)
  const acceptedAudit = (invId: string) => ctl("select * from control_audit where action = 'invitation.accepted' and target_id = ?", invId)

  it('an injected CRM failure: invitation_acceptance_failed, no session, no membership, invitation pending, no audit row; the next token sign-in re-admits exactly once', async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const { id, token } = await invite('p@x.test', 'member')
    failCrm.on = true
    const res = await signIn('p@x.test', token)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as any).code).toBe('invitation_acceptance_failed')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await liveCount(p.userId)).toEqual([])
    expect((await ctl('select accepted_at from invitations where id = ?', id))[0]!.accepted_at).toBeNull()
    expect(await acceptedAudit(id)).toEqual([])
    failCrm.on = false
    expect((await signIn('p@x.test', token)).status).toBe(200)
    expect(await liveCount(p.userId)).toHaveLength(1)
    expect(await acceptedAudit(id)).toHaveLength(1)
  })

  it('an injected control failure after the CRM commit: the same answer, the membership live, the invitation pending; the next sign-in WITHOUT a token completes accepted_at and the audit row once (two later sign-ins: still one)', async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const { id, token } = await invite('p@x.test', 'member')
    failControl.on = true
    const res = await signIn('p@x.test', token)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as any).code).toBe('invitation_acceptance_failed')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await liveCount(p.userId)).toHaveLength(1)
    expect((await ctl('select accepted_at from invitations where id = ?', id))[0]!.accepted_at).toBeNull()
    expect(await acceptedAudit(id)).toEqual([])
    failControl.on = false
    const crmBefore = await dump(w.d1)
    expect((await signIn('p@x.test')).status).toBe(200)
    expect((await ctl('select accepted_at from invitations where id = ?', id))[0]!.accepted_at).not.toBeNull()
    const audit = await acceptedAudit(id)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_id).toBe(p.userId)
    expect((await signIn('p@x.test')).status).toBe(200)
    expect((await signIn('p@x.test', token)).status).toBe(200)
    expect(await acceptedAudit(id)).toHaveLength(1)
    expect(await dump(w.d1)).toEqual(crmBefore)
  })

  it('marking accepted before the CRM unit would break this: with the CRM unit failing, the invitation is never accepted', async () => {
    await admitAndRemove('p@x.test', 'member')
    const { id, token } = await invite('p@x.test', 'member')
    failCrm.on = true
    await signIn('p@x.test', token)
    expect((await ctl('select accepted_at, revoked_at from invitations where id = ?', id))[0]).toEqual({ accepted_at: null, revoked_at: null })
  })

  it('two concurrent token sign-ins converge on one live membership, one membership.created and one audit row', async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const { id, token } = await invite('p@x.test', 'member')
    const createdBefore = await count(w.d1, 'events')
    const [a, b] = await Promise.all([signIn('p@x.test', token), signIn('p@x.test', token)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(await liveCount(p.userId)).toHaveLength(1)
    expect(await crm("select id from events where type = 'membership.created' and resource_id in (select id from memberships where user_id = ?)", p.userId)).toHaveLength(2)
    expect(await count(w.d1, 'events')).toBe(createdBefore + 1)
    expect(await acceptedAudit(id)).toHaveLength(1)
  })

  it('a racing winner between plan and commit: our membership insert does nothing and no second membership.created is written (the event statement is gated on the row it describes)', async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const { id, token } = await invite('p@x.test', 'member')
    // The competing sign-in's membership, committed (without an event, to tell the two apart) just before ours.
    let hook: (() => Promise<void>) | null = async () => {
      await w.d1.prepare('insert into memberships (id, created_at, updated_at, organization_id, user_id, role, created_by) values (?, ?, ?, ?, ?, ?, ?)').bind(uuidv7(), iso(Date.now()), iso(Date.now()), orgId, p.userId, 'member', systemId).run()
    }
    const sqlOf = new WeakMap<object, string>()
    const racing: D1Like = {
      prepare(query: string) {
        const q = w.d1.prepare(query)
        return { bind: (...v: unknown[]) => { const b = q.bind(...v); sqlOf.set(b, query); return b }, run: () => q.run(), all: () => q.all(), first: () => q.first() } as D1PreparedLike
      },
      async batch(batch: D1PreparedLike[]) {
        if (hook && batch.some((s) => /insert\s+into\s+"?memberships"?/i.test(sqlOf.get(s) ?? ''))) {
          const run = hook
          hook = null
          await run()
        }
        return w.d1.batch(batch)
      },
    }
    const racer = composeD1Worker({ DB: racing, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE }, { clock: () => clock() })
    const eventsBefore = await count(w.d1, 'events')
    const res = await racer.fetch(new Request(AUTH_BASE + '/auth/sign-in/email', { method: 'POST', headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9', [CARRIER]: token }, body: JSON.stringify({ email: 'p@x.test', password: PASSWORD }) }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await liveCount(p.userId)).toHaveLength(1)
    expect(await count(w.d1, 'events')).toBe(eventsBefore)
    expect(await acceptedAudit(id)).toHaveLength(1)
  })

  it("the new bound (a live invitation created no later than the live membership), pinned within one second: an invitation made 300 ms before re-admission is completed, one made 300 ms after is not", async () => {
    const p = await admitAndRemove('p@x.test', 'member')
    const T = Math.floor(Date.now() / 1000) * 1000 + 100
    const before = await invite('p@x.test', 'member', { createdAt: T })
    clock = () => new Date(T + 300)
    failControl.on = true
    expect((await signIn('p@x.test', before.token)).status).toBeGreaterThanOrEqual(400)
    failControl.on = false
    expect(await liveCount(p.userId)).toHaveLength(1)
    expect((await signIn('p@x.test')).status).toBe(200)
    expect((await ctl('select accepted_at from invitations where id = ?', before.id))[0]!.accepted_at).not.toBeNull()
    // Same second, later: not the admitting invitation.
    const after = await invite('m2@x.test', 'member', { createdAt: T })
    expect((await signUp('m2@x.test', after.token)).status).toBe(200)
    const membershipAt = Date.parse((await crm("select created_at from memberships where user_id = (select id from users where email = 'm2@x.test')"))[0]!.created_at)
    const late = await invite('m2@x.test', 'owner', { createdAt: membershipAt + 300 })
    expect((await signIn('m2@x.test')).status).toBe(200)
    expect((await ctl('select accepted_at from invitations where id = ?', late.id))[0]!.accepted_at).toBeNull()
    expect(await acceptedAudit(late.id)).toEqual([])
  })
})

describe('the original acceptance on the sign-in path (CORE287 P5 under the new bound)', () => {
  it('an accepted invitation whose control batch failed is completed by the next sign-in of the new member (the membership is newer than its invitation)', async () => {
    failControl.on = true
    expect((await signUp('n@x.test', (await invite('n@x.test', 'member')).token)).status).toBeGreaterThanOrEqual(400)
    failControl.on = false
    expect((await signIn('n@x.test')).status).toBe(200)
    expect(await ctl("select * from control_audit where action = 'invitation.accepted' and json_extract(detail, '$.email') = 'n@x.test'")).toHaveLength(1)
  })
})
