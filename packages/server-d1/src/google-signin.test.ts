import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createInvitation, openControlDb, revokeInvitation, type D1Like } from '@vibase/storage-d1'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { resolveGoogleSignIn } from './auth-config.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE294]] D7, D8, P2-P5 through the real Worker composition (`better-auth`, the real invitation port): configuration and discovery, Google sign-up only through a live invitation for a Google-verified
// email, linking of an existing account by a Google-verified equal email. Google itself is a fake: the process's `fetch` answers only the token endpoint (the profile is read from the ID token it mints) and
// refuses every other URL. The workerd side (Better Auth's state, the hook, the redirect) is `packages/auth/src/google-workerd.test.ts`.
const CODE = 'invitation_required'
const CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com'
const GOOGLE = { AUTH_GOOGLE_CLIENT_ID: CLIENT_ID, AUTH_GOOGLE_CLIENT_SECRET: 'test-google-secret' } as const
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
const authCounts = async () => ({ auth_users: await count(w.control, 'auth_users'), auth_accounts: await count(w.control, 'auth_accounts'), auth_sessions: await count(w.control, 'auth_sessions') })
const vaultCounts = async () => ({ users: await count(w.d1, 'users'), memberships: await count(w.d1, 'memberships'), principals: await count(w.d1, 'principals'), events: await count(w.d1, 'events') })

const worker = (over: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, ...GOOGLE, ...over }, { clock: () => new Date() })
let wk: ReturnType<typeof worker>
const send = (path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string; host?: string; headers?: Record<string, string> } = {}, via: typeof wk = wk) =>
  via.fetch(
    new Request((init.host ?? AUTH_BASE) + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { origin: AUTH_BASE, 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    }),
  )
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=') && !c.startsWith('better-auth.state')).join('; ')
const me = async (cookie: string) => {
  const jwt = ((await (await send('/auth/token', { cookie })).json()) as { token: string }).token
  const res = await send('/meta/v1/me', { bearer: jwt })
  return { status: res.status, json: (await res.json()) as any }
}

/** A control-plane invitation with a known token (the store only keeps its hash). */
async function invite(email: string, role: 'owner' | 'member' | 'agent', o: { createdAt?: number; expiresAt?: number; state?: 'revoked' | 'accepted' } = {}) {
  const t = o.createdAt ?? Date.now()
  const id = uuidv7()
  const token = `token-${id}`
  expect(await createInvitation(openControlDb(w.control), { id, auditId: uuidv7(), organizationId: orgId, email, role, tokenHash: sha256(token), expiresAt: iso(o.expiresAt ?? t + 7 * DAY), createdBy: systemId, now: iso(t) })).toBe('created')
  if (o.state === 'revoked') await revokeInvitation(openControlDb(w.control), { id, auditId: uuidv7(), actorId: systemId, now: iso(Date.now()) })
  if (o.state === 'accepted') await w.control.prepare('update invitations set accepted_at = ? where id = ?').bind(iso(Date.now()), id).run()
  return { id, token }
}

// The fake Google: the token endpoint answers with an ID token carrying the profile (unsigned: Better Auth reads the claims of the token it just received over TLS from the token endpoint); anything else is refused.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
interface Profile {
  email: string
  email_verified: boolean
  sub?: string
}
const idToken = (p: Profile) => `${b64({ alg: 'RS256', kid: 'fake' })}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: p.sub ?? `sub-${p.email}`, email: p.email, email_verified: p.email_verified, name: 'Ann Google' })}.sig`
let outbound: string[]
const realFetch = globalThis.fetch
const fakeGoogle = (profile: Profile) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    outbound.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fake-at', id_token: idToken(profile), token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile' })
    throw new Error(`no network in this test: ${url}`)
  })

/** The button's POST, then Google's redirect back to the callback with the state it was given. `body` adds fields to the button's body. */
async function google(o: { profile: Profile; token?: string; body?: Record<string, unknown>; cookie?: string }) {
  outbound = []
  const start = await send('/auth/sign-in/social', { body: { provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in', ...(o.token === undefined ? {} : { invitation_token: o.token }), ...o.body } })
  expect(start.status, await start.clone().text()).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const state = new URL(url).searchParams.get('state')!
  const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  fakeGoogle(o.profile)
  try {
    const cb = await send(`/auth/callback/google?code=fake-code&state=${state}`, { cookie: cookies, headers: { origin: '' } })
    return { start, url, cb, location: cb.headers.get('location') ?? '' }
  } finally {
    vi.stubGlobal('fetch', realFetch)
  }
}
const errorOf = (location: string) => new URL(location, AUTH_BASE).searchParams.get('error')

beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE, ownerEmail: 'owner@x.test' }, { control: openControlDb(w.control) })
  orgId = r.organizationId
  ownerToken = tokenOf(r.ownerInvitation!.url)
  systemId = (await crm("select id from principals where kind = 'system'"))[0]!.id
  wk = worker()
})
afterEach(() => vi.stubGlobal('fetch', realFetch))

describe('configuration (D7)', () => {
  const E = (o: Record<string, string | undefined>) => o
  it.each([
    ['the AUTH pair', E({ AUTH_GOOGLE_CLIENT_ID: 'a-id', AUTH_GOOGLE_CLIENT_SECRET: 'a-secret' }), { clientId: 'a-id', clientSecret: 'a-secret' }],
    ['the Gmail pair', E({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }), { clientId: 'g-id', clientSecret: 'g-secret' }],
    ['both pairs: the AUTH pair wins', E({ AUTH_GOOGLE_CLIENT_ID: 'a-id', AUTH_GOOGLE_CLIENT_SECRET: 'a-secret', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }), { clientId: 'a-id', clientSecret: 'a-secret' }],
    ['half of the Gmail pair: off', E({ GOOGLE_CLIENT_ID: 'g-id' }), undefined],
    ['the other half of the Gmail pair: off', E({ GOOGLE_CLIENT_SECRET: 'g-secret' }), undefined],
    ['half of the AUTH pair beside a complete Gmail pair is still an error (below); a blank AUTH pair is unset', E({ AUTH_GOOGLE_CLIENT_ID: ' ', AUTH_GOOGLE_CLIENT_SECRET: '', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }), { clientId: 'g-id', clientSecret: 'g-secret' }],
    ['no variable at all: off', E({}), undefined],
  ])('%s', (_n, env, want) => {
    expect(resolveGoogleSignIn(env)).toEqual(want)
  })

  it.each([['AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET'], ['AUTH_GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_CLIENT_ID']])('only %s set: the Worker fails closed (500 on every non-health request, /health 200), the log names %s and never the value', async (set, missing) => {
    const lines: string[] = []
    for (const level of ['error', 'warn', 'log', 'info'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    const half = worker({ AUTH_GOOGLE_CLIENT_ID: undefined, AUTH_GOOGLE_CLIENT_SECRET: undefined, GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', [set]: 'super-secret-value-xyz' } as Partial<D1WorkerEnv>)
    expect((await send('/api/v1/contacts', {}, half)).status).toBe(500)
    expect((await send('/auth/get-session', {}, half)).status).toBe(500)
    expect((await send('/health', {}, half)).status).toBe(200)
    vi.restoreAllMocks()
    const text = lines.join('\n')
    expect(text).toContain(missing)
    expect(text).not.toContain('super-secret-value-xyz')
  })

  it('half of the Gmail pair only leaves Google off: the Worker serves and discovery says password only', async () => {
    const off = worker({ AUTH_GOOGLE_CLIENT_ID: undefined, AUTH_GOOGLE_CLIENT_SECRET: undefined, GOOGLE_CLIENT_ID: 'g-id' })
    expect((await send('/health', {}, off)).status).toBe(200)
    const doc = (await (await send('/.well-known/vibase', {}, off)).json()) as any
    expect(doc.auth.sign_in_methods).toEqual(['password'])
  })
})

describe('discovery and the authorization URL (D7, P2)', () => {
  it('Google on: sign_in_methods is ["password","google"], in the better-auth block only', async () => {
    const doc = (await (await send('/.well-known/vibase')).json()) as any
    expect(doc.auth.sign_in_methods).toEqual(['password', 'google'])
    expect(Object.keys(doc).filter((k) => k !== 'auth' && JSON.stringify(doc[k]).includes('sign_in_methods'))).toEqual([])
  })

  it('Google off: ["password"]', async () => {
    const doc = (await (await send('/.well-known/vibase', {}, worker({ AUTH_GOOGLE_CLIENT_ID: undefined, AUTH_GOOGLE_CLIENT_SECRET: undefined }))).json()) as any
    expect(doc.auth.sign_in_methods).toEqual(['password'])
  })

  it('on the Clerk provider the field does not exist', async () => {
    const clerk = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: undefined })
    const res = await clerk.fetch(new Request(`${AUTH_BASE}/.well-known/vibase`))
    expect(JSON.stringify(await res.json())).not.toContain('sign_in_methods')
  })

  it('the authorization URL is Google, scope `openid email profile`, redirect URI built from PUBLIC_BASE_URL (not the request host)', async () => {
    const res = await send('/auth/sign-in/social', { body: { provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in' }, host: 'https://other.example' })
    expect(res.status, await res.clone().text()).toBe(200)
    const u = new URL(((await res.json()) as { url: string }).url)
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('redirect_uri')).toBe(`${AUTH_BASE}/auth/callback/google`)
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  it('Google off: Better Auth has no provider, refuses the call (404 PROVIDER_NOT_FOUND) and there is no redirect to Google', async () => {
    const off = worker({ AUTH_GOOGLE_CLIENT_ID: undefined, AUTH_GOOGLE_CLIENT_SECRET: undefined })
    const res = await send('/auth/sign-in/social', { body: { provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in' } }, off)
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
    expect(JSON.stringify(await res.json())).not.toContain('accounts.google.com')
  })
})

describe('Google sign-up through an invitation (D8, P3-P5)', () => {
  it('from the button body to the callback: auth rows, vault rows with email_verified true, the membership event, the invitation accepted, a session; the token is in no URL or Location', async () => {
    const eventsBefore = await count(w.d1, 'events')
    const { url, cb, location } = await google({ profile: { email: 'owner@x.test', email_verified: true }, token: ownerToken })
    expect(cb.status).toBe(302)
    expect(errorOf(location)).toBeNull()
    expect(new URL(location, AUTH_BASE).pathname).toBe('/sign-in')
    expect(url + location + cb.url).not.toContain(ownerToken)
    expect(await authCounts()).toEqual({ auth_users: 1, auth_accounts: 1, auth_sessions: 1 })
    const account = (await ctl('select provider_id, account_id, user_id from auth_accounts'))[0]!
    expect(account).toMatchObject({ provider_id: 'google', account_id: 'sub-owner@x.test' })
    const user = (await crm('select * from users'))[0]!
    expect(user).toMatchObject({ email: 'owner@x.test', auth_provider: 'better-auth', auth_subject: account.user_id, email_verified: 1 })
    const m = await crm('select * from memberships')
    expect(m).toHaveLength(1)
    expect([m[0]!.role, m[0]!.user_id]).toEqual(['owner', user.id])
    const events = (await crm('select type from events order by id')).map((e) => e.type)
    expect(events.filter((t) => t === 'membership.created')).toHaveLength(1)
    expect(await count(w.d1, 'events')).toBe(eventsBefore + 1)
    expect((await ctl('select accepted_at from invitations'))[0]!.accepted_at).not.toBeNull()
    expect(await ctl("select id from control_audit where action = 'invitation.accepted'")).toHaveLength(1)
    const got = await me(cookieOf(cb))
    expect([got.status, got.json.principal.kind, got.json.principal.id, got.json.active_organization.role]).toEqual([200, 'user', user.id, 'owner'])
    expect(outbound).toEqual(['POST https://oauth2.googleapis.com/token'])
  })

  it('P5: a password sign-up still writes email_verified false', async () => {
    const res = await send('/auth/sign-up/email', { body: { name: 'Ann', email: 'owner@x.test', password: PASSWORD, invitation_token: ownerToken } })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await crm('select email_verified from users'))[0]).toEqual({ email_verified: 0 })
  })
})

describe('admission refusals (matrix: cause x outcome, P3, P4)', () => {
  const causes: Array<[string, () => Promise<Parameters<typeof google>[0]>]> = [
    ['no token', async () => ({ profile: { email: 'owner@x.test', email_verified: true } })],
    ['a token for another email', async () => ({ profile: { email: 'other@x.test', email_verified: true }, token: ownerToken })],
    ['a live token but the Google email not verified', async () => ({ profile: { email: 'owner@x.test', email_verified: false }, token: ownerToken })],
    ['an expired invitation', async () => ({ profile: { email: 'late@x.test', email_verified: true }, token: (await invite('late@x.test', 'member', { createdAt: Date.now() - 9 * DAY, expiresAt: Date.now() - 2 * DAY })).token })],
    ['a revoked invitation', async () => ({ profile: { email: 'gone@x.test', email_verified: true }, token: (await invite('gone@x.test', 'member', { state: 'revoked' })).token })],
    ['an accepted invitation', async () => ({ profile: { email: 'used@x.test', email_verified: true }, token: (await invite('used@x.test', 'member', { state: 'accepted' })).token })],
    ['a valid token sent only as client additionalData (top-level state), not in the body field', async () => ({ profile: { email: 'owner@x.test', email_verified: true }, body: { additionalData: { invitation_token: ownerToken, invitationToken: ownerToken } } })],
  ]
  it.each(causes)('%s: redirect to /sign-in?error=invitation_required, no auth row, no vault row, no event, no session', async (_n, make) => {
    const args = await make()
    const auth = await authCounts()
    const vault = await vaultCounts()
    const { cb, location } = await google(args)
    expect(cb.status).toBe(302)
    expect(new URL(location, AUTH_BASE).pathname).toBe('/sign-in')
    expect(errorOf(location)).toBe(CODE)
    expect(cb.headers.getSetCookie().join(';')).not.toMatch(/session_token=[^;]/)
    expect(await authCounts()).toEqual(auth)
    expect(await vaultCounts()).toEqual(vault)
    expect(await ctl("select id from control_audit where action = 'invitation.accepted'")).toEqual([])
  })
})

describe('existing accounts (D8 linking)', () => {
  async function passwordAccount() {
    const res = await send('/auth/sign-up/email', { body: { name: 'Ann Tester', email: 'owner@x.test', password: PASSWORD, invitation_token: ownerToken } })
    expect(res.status, await res.clone().text()).toBe(200)
  }

  it('no token, an existing password account and a Google-verified equal email: linked to that user and signed in (one user, two accounts), no second vault row', async () => {
    await passwordAccount()
    const vault = await vaultCounts()
    const { cb, location } = await google({ profile: { email: 'Owner@X.test', email_verified: true, sub: 'sub-owner' } })
    expect(cb.status).toBe(302)
    expect(errorOf(location)).toBeNull()
    expect(cb.headers.getSetCookie().join(';')).toContain('session_token')
    expect(await count(w.control, 'auth_users')).toBe(1)
    expect((await ctl('select provider_id from auth_accounts order by provider_id')).map((r) => r.provider_id)).toEqual(['credential', 'google'])
    expect(await vaultCounts()).toEqual(vault)
    expect(await count(w.d1, 'users')).toBe(1)
    expect((await me(cookieOf(cb))).status).toBe(200)
    // The linked account signs in again with no token at all.
    const again = await google({ profile: { email: 'owner@x.test', email_verified: true, sub: 'sub-owner' } })
    expect(errorOf(again.location)).toBeNull()
    expect(await count(w.control, 'auth_accounts')).toBe(2)
  })

  it('the same with the Google email NOT verified: not linked, refused, no auth_accounts row for Google', async () => {
    await passwordAccount()
    const { cb, location } = await google({ profile: { email: 'owner@x.test', email_verified: false } })
    expect(cb.status).toBe(302)
    expect(errorOf(location)).not.toBeNull()
    expect(errorOf(location)).not.toBe(CODE)
    expect(cb.headers.getSetCookie().join(';')).not.toMatch(/session_token=[^;]/)
    expect((await ctl('select provider_id from auth_accounts')).map((r) => r.provider_id)).toEqual(['credential'])
    expect(await count(w.control, 'auth_users')).toBe(1)
  })

  it('no token and no account for that email (the empty state): refused with invitation_required, nothing written', async () => {
    const { location } = await google({ profile: { email: 'stranger@x.test', email_verified: true } })
    expect(errorOf(location)).toBe(CODE)
    expect(await authCounts()).toEqual({ auth_users: 0, auth_accounts: 0, auth_sessions: 0 })
    expect(await count(w.d1, 'users')).toBe(0)
  })
})
