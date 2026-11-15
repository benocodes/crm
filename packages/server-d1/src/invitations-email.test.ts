import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { fakeEmail, type FakeEmail } from './test/fake-email.js'
import { NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE248]] D3, D5, D6, D8 through the real Worker composition: the owner creates invitations on REST, a fake `EMAIL` binding records what would be sent, and the recorded link is accepted through a real sign-up.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let email: FakeEmail
let n = 0
const declared = createVibaseRegistry().declaredScopes()
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())

/** A control D1 whose batches throw while a flag is on and any statement matches: injected failures of the invitation insert and of the revoke. */
const inject = { insert: false, revoke: false }
function flakyControl(real: D1Like): D1Like {
  const sqlOf = new WeakMap<object, string>()
  return {
    prepare(query: string) {
      const p = real.prepare(query)
      return {
        bind: (...v: unknown[]) => {
          const b = p.bind(...v)
          sqlOf.set(b, query)
          return b
        },
        run: () => p.run(),
        all: () => p.all(),
        first: () => p.first(),
      } as D1PreparedLike
    },
    async batch(batch: D1PreparedLike[]) {
      const sqls = batch.map((s) => sqlOf.get(s) ?? '')
      if (inject.insert && sqls.some((q) => /insert\s+into\s+invitations/i.test(q)))
        throw new Error('injected insert failure')
      if (inject.revoke && sqls.some((q) => /update\s+invitations\s+set\s+revoked_at/i.test(q)))
        throw new Error('injected revoke failure')
      return real.batch(batch)
    },
  }
}

const worker = (on: boolean) =>
  composeD1Worker({
    DB: w.d1,
    CONTROL_DB: flakyControl(w.control),
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    ...(on ? { EMAIL: email, AUTH_EMAIL_FROM: 'Invites@Vibase.Test' } : {}),
  })
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
type Res = { status: number; json: any }
const call = async (
  wk: ReturnType<typeof worker>,
  method: string,
  path: string,
  tok: string,
  body?: unknown,
): Promise<Res> => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const PATH = '/meta/v1/invitations'
const create = (wk: ReturnType<typeof worker>, tok: string, body: Record<string, unknown> = {}) =>
  call(wk, 'POST', PATH, tok, { email: 'ann@x.test', role: 'member', ...body })
const list = async (wk: ReturnType<typeof worker>, tok: string) =>
  (await call(wk, 'GET', PATH, tok)).json.data as Array<Record<string, any>>
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')
const linkIn = (text: string) => /https?:\/\/\S+#token=\S+/.exec(text)![0]!
const auditOf = async (id: string): Promise<Array<Record<string, any>>> =>
  (await rows(w.control, 'select * from control_audit where target_id = ? order by at, id', id)).map((r) => ({
    ...r,
    detail: JSON.parse(r.detail),
  }))

let owner: { id: string; session: () => Promise<string> }
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  const r = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
  orgId = r.organizationId
  kit = authKit(w.control, { scopes: declared })
  const { userId, cookie } = await kit.signUp('owner@x.test')
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, {
    id,
    kind: 'user',
    email: 'owner@x.test',
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role: 'owner' })
  owner = { id, session: () => kit.sessionJwt(cookie) }
  email = fakeEmail()
  inject.insert = false
  inject.revoke = false
})

const signUp = (wk: ReturnType<typeof worker>, address: string, token: string) =>
  wk.fetch(
    new Request(`${AUTH_BASE}/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        origin: AUTH_BASE,
        'content-type': 'application/json',
        'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`,
      },
      body: JSON.stringify({
        name: 'Ann Tester',
        email: address,
        password: 'a long enough password 123',
        invitation_token: token,
      }),
    }),
  )
const crmUser = async (address: string) =>
  (await rows(w.d1, 'select email_verified from users where email = ?', address))[0]

describe('email on: emailed invitations (D3, D6)', () => {
  it('defaults to email: 201 with delivery and no url key, one message to the address, the audit detail carries delivery', async () => {
    const wk = worker(true)
    const res = await create(wk, await owner.session())
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(Object.keys(res.json).sort()).toEqual(['delivery', 'email', 'expires_at', 'id', 'role'])
    expect(res.json.delivery).toBe('email')
    expect(email.sent).toHaveLength(1)
    const m = email.sent[0]!
    expect(Object.keys(m).sort()).toEqual(['from', 'html', 'subject', 'text', 'to'])
    expect(m.to).toBe('ann@x.test')
    expect(m.from).toEqual({ email: 'invites@vibase.test', name: 'Vibase' })
    expect(m.subject).toBe("You're invited to Vibase at vibase.test")
    expect(linkIn(m.text)).toMatch(/^https:\/\/vibase\.test\/invite#token=[A-Za-z0-9_-]{43}/)
    expect(m.html).toContain(linkIn(m.text))
    expect((await auditOf(res.json.id))[0]!.detail).toMatchObject({ delivery: 'email' })
    expect((await rows(w.control, 'select delivery from invitations where id = ?', res.json.id))[0]).toEqual({
      delivery: 'email',
    })
  })

  it('the emailed link accepts the invitation end to end, and the vault records the address as verified (D5)', async () => {
    const wk = worker(true)
    expect((await create(wk, await owner.session())).status).toBe(201)
    const token = tokenOf(linkIn(email.sent[0]!.text))
    const res = await signUp(wk, 'ann@x.test', token)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await crmUser('ann@x.test')).toEqual({ email_verified: 1 })
    expect((await rows(w.control, 'select accepted_at from invitations'))[0]!.accepted_at).not.toBeNull()
  })

  it('an explicit link: url present, nothing sent, the address is NOT recorded as verified', async () => {
    const wk = worker(true)
    const res = await create(wk, await owner.session(), { delivery: 'link' })
    expect(res.status).toBe(201)
    expect(Object.keys(res.json).sort()).toEqual(['delivery', 'email', 'expires_at', 'id', 'role', 'url'])
    expect(res.json.delivery).toBe('link')
    expect(email.sent).toHaveLength(0)
    expect((await auditOf(res.json.id))[0]!.detail).toMatchObject({ delivery: 'link' })
    expect((await signUp(wk, 'ann@x.test', tokenOf(res.json.url))).status).toBe(200)
    expect(await crmUser('ann@x.test')).toEqual({ email_verified: 0 })
  })

  it('a duplicate is 409 invitation_exists and sends nothing', async () => {
    const wk = worker(true)
    const tok = await owner.session()
    expect((await create(wk, tok)).status).toBe(201)
    email.sent.length = 0
    const again = await create(wk, tok)
    expect([again.status, again.json.error.code]).toEqual([409, 'invitation_exists'])
    expect(email.sent).toHaveLength(0)
  })

  it('an unknown delivery value is a validation error', async () => {
    const res = await create(worker(true), await owner.session(), { delivery: 'both' })
    expect(res.status).toBe(400)
  })

  it('no caller-supplied string reaches the message other than as the recipient', async () => {
    const wk = worker(true)
    const res = await create(wk, await owner.session(), { email: '<script>evil</script>@x.test' })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const m = email.sent[0]!
    expect(m.to).toBe('<script>evil</script>@x.test')
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/evil|script/i)
  })

  it('list returns delivery for new rows', async () => {
    const wk = worker(true)
    const tok = await owner.session()
    await create(wk, tok)
    await create(wk, tok, { email: 'bob@x.test', delivery: 'link' })
    const got = Object.fromEntries((await list(wk, tok)).map((r) => [r.email, r.delivery]))
    expect(got).toEqual({ 'ann@x.test': 'email', 'bob@x.test': 'link' })
  })
})

describe("email off: today's behaviour (D3)", () => {
  it('defaults to link: url present plus delivery, nothing sent, the audit detail says link', async () => {
    const wk = worker(false)
    const res = await create(wk, await owner.session())
    expect(res.status).toBe(201)
    expect(Object.keys(res.json).sort()).toEqual(['delivery', 'email', 'expires_at', 'id', 'role', 'url'])
    expect(res.json.delivery).toBe('link')
    expect(email.sent).toHaveLength(0)
    expect((await auditOf(res.json.id))[0]!.detail).toMatchObject({ delivery: 'link' })
  })

  it('delivery email is 501 email_not_configured and nothing is written', async () => {
    const res = await create(worker(false), await owner.session(), { delivery: 'email' })
    expect([res.status, res.json.error.code]).toEqual([501, 'email_not_configured'])
    expect(await rows(w.control, 'select id from invitations')).toEqual([])
    expect(await rows(w.control, "select id from control_audit where target_type = 'invitation'")).toEqual([])
    expect(email.sent).toHaveLength(0)
  })
})

describe('send failure, every partial state (D3)', () => {
  it('(a) the send rejects, the revoke works: 502 email_send_failed, the invitation revoked with reason email_failed and the caller as actor, and a retry succeeds', async () => {
    const wk = worker(true)
    const tok = await owner.session()
    email.failing = true
    const res = await create(wk, tok)
    expect([res.status, res.json.error.code]).toEqual([502, 'email_send_failed'])
    const [inv] = await rows(w.control, 'select id, revoked_at from invitations')
    expect(inv!.revoked_at).not.toBeNull()
    const audit = await auditOf(inv!.id)
    expect(audit.map((a) => a.action)).toEqual(['invitation.created', 'invitation.revoked'])
    expect(audit[1]).toMatchObject({ actor_id: owner.id, detail: { reason: 'email_failed' } })
    email.failing = false
    const retry = await create(wk, tok)
    expect(retry.status, JSON.stringify(retry.json)).toBe(201)
    expect(email.sent).toHaveLength(1)
  })

  it('(b) the send rejects and the revoke fails: still 502, the invitation stays pending with delivery email', async () => {
    const wk = worker(true)
    const tok = await owner.session()
    email.failing = true
    inject.revoke = true
    const res = await create(wk, tok)
    expect([res.status, res.json.error.code]).toEqual([502, 'email_send_failed'])
    inject.revoke = false
    const got = await list(wk, tok)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ email: 'ann@x.test', status: 'pending', delivery: 'email' })
  })

  it('(c) the write fails: nothing is sent and nothing is stored', async () => {
    const wk = worker(true)
    inject.insert = true
    const res = await create(wk, await owner.session())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.json.error.code).not.toBe('email_send_failed')
    expect(email.sent).toHaveLength(0)
    expect(await rows(w.control, 'select id from invitations')).toEqual([])
  })
})
