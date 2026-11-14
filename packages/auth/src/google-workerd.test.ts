import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bundleWorker, startWorkerd, BASE, type Bundle, type Workerd } from './test/index.js'

// [[CORE294]] D7, D8, D9 in workerd: Google sign-in through the real Better Auth composition, with a FAKE GOOGLE behind Miniflare's outbound service (the token endpoint; the profile is read from the ID token the
// fake mints) and every other outbound request refused. The invitation port is the entry's fake (admits exactly `ann@auth.test|the-token`, settles nothing), so this proves the Better Auth side: the token rides
// the state's server context across the redirect, the backstop reads it there in the user-creation hook of the callback, and every refusal is a redirect with `error=invitation_required` and no auth row.
const ENTRY = fileURLToPath(new URL('./test/entry.ts', import.meta.url))
const CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com'
const TOKEN = 'the-token'
const EMAIL = 'ann@auth.test'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
interface Profile {
  email: string
  email_verified: boolean
  sub?: string
}
const idToken = (p: Profile) => `${b64({ alg: 'RS256', kid: 'fake' })}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: p.sub ?? `sub-${p.email}`, email: p.email, email_verified: p.email_verified, name: 'Ann Google' })}.sig`

let bundle: Bundle
let w: Workerd
let profile: Profile
let outbound: string[]
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    bindings: { FAKE_ADMISSION: `${EMAIL}|${TOKEN}`, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'test-google-secret' },
    outbound: async (req) => {
      outbound.push(`${req.method} ${req.url}`)
      if (req.method === 'POST' && req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'fake-at', id_token: idToken(profile), token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile' })
      }
      throw new Error(`no network in the auth tests: ${req.url}`)
    },
  })
}, 120_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

let n = 0
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}` })
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const counts = async () => ({ users: (await w.controlRows('select id from auth_users')).length, accounts: (await w.controlRows('select id from auth_accounts')).length, sessions: (await w.controlRows('select id from auth_sessions')).length })

/** The whole flow: the button's POST, then Google's redirect back to the callback with the state it was given. */
async function flow(o: { profile: Profile; body?: Record<string, unknown> }) {
  outbound = []
  profile = o.profile
  const start = await w.call('/auth/sign-in/social', { body: { provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in', ...o.body }, headers: ip() })
  expect(start.status, await start.clone().text()).toBe(200)
  const { url } = (await start.json()) as { url: string; redirect: boolean }
  const state = new URL(url).searchParams.get('state')!
  const cb = await w.call(`/auth/callback/google?code=fake-code&state=${state}`, { cookie: cookiesOf(start), headers: ip(), manual: true })
  return { url, cb, location: cb.headers.get('location') ?? '' }
}
const clear = async () => {
  for (const t of ['auth_sessions', 'auth_accounts', 'auth_users']) await w.controlRows(`delete from ${t}`)
}
beforeEach(clear)
const errorOf = (location: string) => new URL(location, BASE).searchParams.get('error')

describe('Google sign-in in workerd (fake Google, network blocked)', () => {
  it('the authorization URL: Google, scope `openid email profile`, redirect URI <base>/auth/callback/google, no token in it', async () => {
    const { url } = await flow({ profile: { email: EMAIL, email_verified: true }, body: { invitation_token: TOKEN } }).then((r) => r)
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback/google`)
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url).not.toContain(TOKEN)
  })

  it('an invitation token sent in the button body is readable in the user-creation hook of the callback: the account is created, and the token appears in no URL or Location of the flow', async () => {
    const before = await counts()
    const { url, cb, location } = await flow({ profile: { email: EMAIL, email_verified: true }, body: { invitation_token: TOKEN } })
    expect(cb.status).toBe(302)
    expect(errorOf(location)).toBeNull()
    expect(new URL(location, BASE).pathname).toBe('/sign-in')
    expect(url + location).not.toContain(TOKEN)
    expect(cb.headers.getSetCookie().join(';')).toContain('session')
    const after = await counts()
    expect([after.users - before.users, after.accounts - before.accounts, after.sessions - before.sessions]).toEqual([1, 1, 1])
    expect(await w.controlRows("select provider_id, account_id from auth_accounts where provider_id = 'google'")).toEqual([{ provider_id: 'google', account_id: `sub-${EMAIL}` }])
    expect((await w.controlRows('select email_verified from auth_users where email = ?', EMAIL))[0]).toEqual({ email_verified: 1 })
    expect(outbound).toEqual(['POST https://oauth2.googleapis.com/token'])
  })
})

describe('refusals (the Google branch of the backstop, P3, P4)', () => {
  const GOOD = { email: EMAIL, email_verified: true }
  it.each([
    ['no token', { profile: { ...GOOD, email: 'nobody@auth.test' }, body: {} }],
    ['a token for another email', { profile: { ...GOOD, email: 'bob@auth.test' }, body: { invitation_token: TOKEN } }],
    ['a wrong token', { profile: { ...GOOD, email: 'carl@auth.test' }, body: { invitation_token: 'nope' } }],
    ['a live token but the Google email not verified', { profile: { ...GOOD, email: EMAIL, email_verified: false, sub: 'sub-unverified' }, body: { invitation_token: TOKEN } }],
    ['a valid token sent only as client additionalData (top-level state), not in the body field', { profile: { ...GOOD, email: EMAIL, sub: 'sub-additional' }, body: { additionalData: { invitation_token: TOKEN, invitationToken: TOKEN } } }],
  ])('%s: a redirect to /sign-in?error=invitation_required, no auth row, no session', async (_n, o) => {
    const { cb, location } = await flow(o)
    expect(cb.status).toBe(302)
    expect(new URL(location, BASE).pathname).toBe('/sign-in')
    expect(errorOf(location)).toBe('invitation_required')
    expect(cb.headers.getSetCookie().join(';')).not.toContain('session_token')
    expect(await counts()).toEqual({ users: 0, accounts: 0, sessions: 0 })
  })
})
