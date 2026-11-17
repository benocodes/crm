import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb, type D1Like } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { createAuth } from '@vibase/auth'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { fakeEmail, type FakeEmail } from './test/fake-email.js'
import { bootstrapD1, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE304]] D4, D6, D2 and the P1-P3 rules through the real Worker composition: the real Better Auth on a control-plane D1 (Miniflare), a fake `EMAIL` binding that records the message objects, an injected `waitUntil`
// recorder. The HTTP reset request is real (`POST /auth/request-password-reset`), and so are the owner-issued link (`users.issue_reset_link`) and the reset the emailed link completes.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let email: FakeEmail
const declared = createVibaseRegistry().declaredScopes()
const OLD = 'a long enough password 123'
const NEW = 'a brand new password 456'
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())

/** Every `waitUntil` the Worker was handed, so a test can both count them and wait for them. */
let scheduled: Array<Promise<unknown>> = []
const settle = () => Promise.allSettled(scheduled)

const worker = (over: { email?: unknown; from?: string; extra?: Partial<D1WorkerEnv> } = {}) =>
  composeD1Worker(
    {
      DB: w.d1,
      CONTROL_DB: w.control,
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
      ...(over.email !== undefined ? { EMAIL: over.email as never } : {}),
      ...(over.from !== undefined ? { AUTH_EMAIL_FROM: over.from } : {}),
      ...over.extra,
    },
    {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(p)
      },
    },
  )
const on = (over: Parameters<typeof worker>[0] = {}) => worker({ email, from: 'Noreply@Vibase.Test', ...over })
const off = () => worker()

type Res = { status: number; json: any; text: string }
let ipN = 0
const ipFor = () => `198.51.100.${(ipN++ % 250) + 1}`
const call = async (
  wk: ReturnType<typeof worker>,
  method: string,
  path: string,
  o: { tok?: string; body?: unknown; ip?: string | null; cookie?: string } = {},
): Promise<Res> => {
  const ip = o.ip === undefined ? ipFor() : o.ip
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: {
        origin: AUTH_BASE,
        ...(ip ? { 'cf-connecting-ip': ip } : {}),
        ...(o.tok ? { authorization: `Bearer ${o.tok}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.body ? { 'content-type': 'application/json' } : {}),
      },
      body: o.body ? JSON.stringify(o.body) : undefined,
    }),
  )
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, text }
}
const requestReset = (wk: ReturnType<typeof worker>, address: string, ip?: string | null) =>
  call(wk, 'POST', '/auth/request-password-reset', { body: { email: address }, ip })
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const verifications = () =>
  rows(w.control, "select identifier from auth_verifications where identifier like 'reset-password:%'")
const linkIn = (text: string) => /https?:\/\/\S+#token=\S+/.exec(text)![0]!
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')

type Human = { id: string; email: string; subject: string; cookie: string; session(): Promise<string> }
async function human(role: 'owner' | 'member', address = `${role}@x.test`, name = 'Test User'): Promise<Human> {
  const { userId, cookie } = await kit.signUp(address, name)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email: address, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return { id, email: address, subject: userId, cookie, session: () => kit.sessionJwt(cookie) }
}
const issueLink = (wk: ReturnType<typeof worker>, tok: string, userId: string) =>
  call(wk, 'POST', '/meta/v1/users/reset-link', { tok, body: { user_id: userId } })

/** Every console line, whatever the method, as one string each. */
const lines = () =>
  [console.error, console.warn, console.log, console.info].flatMap((m) =>
    vi.mocked(m).mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
  )

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
  email = fakeEmail()
  scheduled = []
  for (const m of ['error', 'warn', 'log', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('gate matrix (D4): email on/off x request path x HTTP/in-process', () => {
  it('HTTP /request-password-reset passes only with email on', async () => {
    await human('member', 'ann@x.test')
    const onRes = await requestReset(on(), 'ann@x.test')
    expect(onRes.status, onRes.text).toBe(200)
    await settle()
    expect(email.sent).toHaveLength(1)
    email.sent.length = 0
    await w.control.prepare('delete from auth_verifications').run()
    const offRes = await requestReset(off(), 'ann@x.test')
    expect([offRes.status, offRes.json.code]).toEqual([400, 'RESET_PASSWORD_DISABLED'])
    await settle()
    expect(email.sent).toHaveLength(0)
    expect(await verifications()).toEqual([])
  })

  it('HTTP /forget-password is refused in both modes (Better Auth 1.7.22 has no such route: 404; the gate would refuse it with RESET_PASSWORD_DISABLED if it had): no verification row, nothing sent', async () => {
    await human('member', 'ann@x.test')
    for (const wk of [on(), off()]) {
      const res = await call(wk, 'POST', '/auth/forget-password', { body: { email: 'ann@x.test' } })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
    await settle()
    expect(email.sent).toHaveLength(0)
    expect(await verifications()).toEqual([])
  })

  it('the owner-issued link (in-process) works in both modes and is never sent', async () => {
    const owner = await human('owner')
    const member = await human('member', 'ann@x.test')
    for (const wk of [on(), off()]) {
      const res = await issueLink(wk, await owner.session(), member.id)
      expect(res.status, res.text).toBe(200)
      expect(new URL(res.json.url).pathname).toBe('/reset-password')
      await settle()
    }
    expect(email.sent).toHaveLength(0)
  })
})

describe('delivery and timing (D4, P1)', () => {
  it('a known address gets exactly one message, scheduled through waitUntil; an unknown address gets the same answer and none', async () => {
    await human('member', 'ann@x.test')
    const wk = on()
    // The first request builds the auth provider, which schedules its own keep-alive waitUntil (OPS252, 22ce975). A warm-up request with an unknown address takes that one-off out of the count, so what is counted below is only the reset-email delivery.
    const warm = await requestReset(wk, 'warmup@x.test')
    await settle()
    const baseline = scheduled.length
    expect(email.sent).toHaveLength(0)
    const known = await requestReset(wk, 'ann@x.test')
    expect(known.status).toBe(200)
    expect(scheduled).toHaveLength(baseline + 1)
    await settle()
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.to).toBe('ann@x.test')
    const unknown = await requestReset(wk, 'nobody@x.test')
    await settle()
    expect(scheduled).toHaveLength(baseline + 1)
    expect(email.sent).toHaveLength(1)
    expect([unknown.status, unknown.json]).toEqual([known.status, known.json])
    expect(warm.json).toEqual(known.json)
  })

  it('the response resolves while the send is still pending (the send is scheduled, never awaited)', async () => {
    await human('member', 'ann@x.test')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = {
      sent: [] as unknown[],
      send: async (m: unknown) => {
        await gate
        slow.sent.push(m)
      },
    }
    const wk = on({ email: slow })
    const res = await Promise.race([
      requestReset(wk, 'ann@x.test'),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 4000)),
    ])
    expect(res).not.toBe('timeout')
    expect((res as Res).status).toBe(200)
    expect(slow.sent).toHaveLength(0)
    release()
    await settle()
    expect(slow.sent).toHaveLength(1)
  })
})

describe('P1: only the in-process call is captured', () => {
  /** The real Better Auth handler with a hand-registered waiter (what `issueResetToken` registers around its in-process call), so the HTTP request arrives while the waiter is live. */
  const setup = async () => {
    const captures = new Map<string, (token: string) => void>()
    const delivered: Array<{ email: string; token: string }> = []
    const auth = createAuth(
      w.control,
      { secret: AUTH_SECRET, baseURL: AUTH_BASE },
      { unsafeOpenAdmissionForTests: true, resetCaptures: captures, deliverResetToken: (a) => void delivered.push(a) },
    )
    const post = (path: string, body: unknown) =>
      auth.handler(
        new Request(AUTH_BASE + path, {
          method: 'POST',
          headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': ipFor() },
          body: JSON.stringify(body),
        }),
      )
    expect((await post('/auth/sign-up/email', { name: 'Ann', email: 'ann@x.test', password: OLD })).status).toBe(200)
    return { captures, delivered, auth, post }
  }

  it('an HTTP request for an address with a live waiter is delivered, and the waiter gets nothing from it', async () => {
    const { captures, delivered, post } = await setup()
    const got: string[] = []
    captures.set('ann@x.test', (t) => void got.push(t))
    const res = await post('/auth/request-password-reset', { email: 'Ann@X.test' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(got).toEqual([])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.email).toBe('ann@x.test')
    expect((await verifications()).map((v) => v.identifier)).toEqual([`reset-password:${delivered[0]!.token}`])
  })

  it('the in-process call still reaches its own waiter and is never delivered, before and after an HTTP request', async () => {
    const { delivered, auth, post } = await setup()
    const first = await auth.issueResetToken('ann@x.test')
    expect(first?.token).toBeTruthy()
    expect(delivered).toEqual([])
    expect((await post('/auth/request-password-reset', { email: 'ann@x.test' })).status).toBe(200)
    const second = await auth.issueResetToken('ann@x.test')
    expect(second?.token).toBeTruthy()
    expect(second!.token).not.toBe(first!.token)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.token).not.toBe(first!.token)
    expect(delivered[0]!.token).not.toBe(second!.token)
  })
})

describe('the reset message end to end (D6)', () => {
  it('subject and text carry the host, the link is <base>/reset-password#token=..., nothing user-supplied appears, and the link completes a reset that ends existing sessions', async () => {
    const member = await human('member', 'ann@x.test', 'Mallory <script>alert(1)</script>')
    const signedIn = await call(on(), 'POST', '/auth/sign-in/email', { body: { email: 'ann@x.test', password: OLD } })
    expect(signedIn.status).toBe(200)
    const wk = on()
    expect((await requestReset(wk, 'ann@x.test')).status).toBe(200)
    await settle()
    expect(email.sent).toHaveLength(1)
    const m = email.sent[0]!
    expect(Object.keys(m).sort()).toEqual(['from', 'html', 'subject', 'text', 'to'])
    expect(m.from).toEqual({ email: 'noreply@vibase.test', name: 'Vibase' })
    expect(m.to).toBe('ann@x.test')
    expect(m.subject).toBe('Reset your Vibase password at vibase.test')
    const link = linkIn(m.text)
    expect(link).toMatch(/^https:\/\/vibase\.test\/reset-password#token=[A-Za-z0-9_-]{10,}$/)
    expect(m.html).toContain(link)
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/Mallory|script|alert/)
    expect(m.text).toMatch(/1 hour/)

    const before = await call(wk, 'GET', '/auth/get-session', { cookie: member.cookie })
    expect(before.json?.user?.email).toBe('ann@x.test')
    const done = await call(wk, 'POST', '/auth/reset-password', { body: { token: tokenOf(link), newPassword: NEW } })
    expect(done.status, done.text).toBe(200)
    expect(
      (await call(wk, 'POST', '/auth/sign-in/email', { body: { email: 'ann@x.test', password: NEW } })).status,
    ).toBe(200)
    expect(
      (await call(wk, 'POST', '/auth/sign-in/email', { body: { email: 'ann@x.test', password: OLD } })).status,
    ).toBe(401)
    expect((await call(wk, 'GET', '/auth/get-session', { cookie: member.cookie })).json).toBeNull()
    expect(
      (await call(wk, 'POST', '/auth/reset-password', { body: { token: tokenOf(link), newPassword: 'again 12345' } }))
        .status,
    ).toBe(400)
  })
})

describe('rate limit (D4, P3): 5 requests per hour per client IP', () => {
  it('the 6th request from one IP is 429, another IP is served, and the 4th within a minute is still 2xx', async () => {
    await human('member', 'ann@x.test')
    const wk = on()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await requestReset(wk, 'ann@x.test', '203.0.113.7')).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    expect((await requestReset(wk, 'ann@x.test', '203.0.113.8')).status).toBe(200)
  })

  it('the window is a whole hour, not the library default of one minute: still limited after 5 minutes, served again after the hour', async () => {
    await human('member', 'ann@x.test')
    const wk = on()
    for (let i = 0; i < 5; i++) expect((await requestReset(wk, 'ann@x.test', '203.0.113.20')).status).toBe(200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5 * 60_000)
    expect((await requestReset(wk, 'ann@x.test', '203.0.113.20')).status).toBe(429)
    vi.setSystemTime(Date.now() + 60 * 60_000)
    expect((await requestReset(wk, 'ann@x.test', '203.0.113.20')).status).toBe(200)
  })

  it('a request that carries no cf-connecting-ip shares one bucket per path, so the limit still applies', async () => {
    await human('member', 'ann@x.test')
    const wk = on()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await requestReset(wk, 'ann@x.test', null)).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    // a keyed client is not in the shared bucket
    expect((await requestReset(wk, 'ann@x.test', '203.0.113.9')).status).toBe(200)
  })

  it('a client-supplied X-Forwarded-For is not trusted: varying it does not escape the bucket', async () => {
    await human('member', 'ann@x.test')
    const wk = on()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await wk.fetch(
        new Request(`${AUTH_BASE}/auth/request-password-reset`, {
          method: 'POST',
          headers: {
            origin: AUTH_BASE,
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.50',
            'x-forwarded-for': `10.0.0.${i + 1}`,
          },
          body: JSON.stringify({ email: 'ann@x.test' }),
        }),
      )
      statuses.push(res.status)
    }
    expect(statuses.at(-1)).toBe(429)
  })
})

describe('discovery (D2): auth.self_service_reset', () => {
  const doc = async (wk: ReturnType<typeof worker>) => {
    const res = await wk.fetch(new Request(`${AUTH_BASE}/.well-known/vibase`))
    return { status: res.status, json: (await res.json()) as any }
  }
  it('true exactly when email is on', async () => {
    expect((await doc(on())).json.auth.self_service_reset).toBe(true)
    expect((await doc(off())).json.auth.self_service_reset).toBe(false)
  })
  it('half a pair stays a configuration error, not a flag', async () => {
    expect((await doc(worker({ email }))).status).toBe(500)
    expect((await doc(worker({ from: 'noreply@vibase.test' }))).status).toBe(500)
  })
})

describe('failure observability (D4, P2)', () => {
  /** A provider error whose message echoes the recipient, as real providers' do. */
  const rejecting = (code?: string) => ({
    send: async (m: { to: string }) => {
      throw Object.assign(new Error(`rejected recipient ${m.to}`), code ? { code } : {})
    },
  })

  it('a rejecting sender on the reset path logs one fixed-name line with the error code and nothing else; the HTTP answer is unchanged', async () => {
    await human('member', 'ann@x.test')
    const ok = await requestReset(on(), 'ann@x.test')
    await settle()
    await w.control.prepare('delete from auth_verifications').run()
    scheduled = []
    vi.clearAllMocks()
    const wk = on({ email: rejecting('E_RECIPIENT_REJECTED') })
    const res = await requestReset(wk, 'ann@x.test')
    await settle()
    expect([res.status, res.json]).toEqual([ok.status, ok.json])
    const [tokenRow] = await verifications()
    const token = tokenRow!.identifier.replace('reset-password:', '')
    const mine = lines().filter((l) => l.includes('password_reset_send_failed'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('E_RECIPIENT_REJECTED')
    for (const l of lines()) {
      expect(l).not.toContain('ann@x.test')
      expect(l).not.toContain(token)
      expect(l).not.toContain('rejected recipient')
      expect(l).not.toContain('reset-password#')
      expect(l).not.toContain('Reset your Vibase')
    }
  })

  it('an error without a code logs its name', async () => {
    await human('member', 'ann@x.test')
    vi.clearAllMocks()
    const wk = on({ email: rejecting() })
    await requestReset(wk, 'ann@x.test')
    await settle()
    const mine = lines().filter((l) => l.includes('password_reset_send_failed'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('Error')
    expect(mine[0]).not.toContain('ann@x.test')
  })
})
