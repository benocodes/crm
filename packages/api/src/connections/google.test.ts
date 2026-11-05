import { beforeAll, describe, expect, it } from 'vitest'
import { FAKE_ENDPOINTS, FakeGoogle } from '../test/google.js'
import { GMAIL_READONLY, GMAIL_SEND, GoogleExchangeError, REQUESTED_SCOPES, buildAuthorizeUrl, exchangeCode, verifyIdToken, GOOGLE_ENDPOINTS } from './google.js'
import { pkceChallenge, pkceVerifier } from './state.js'

// CHN140 D1, D9, D57: the authorize URL, the code exchange and the ID token check, against a fake Google that mints real signed tokens.
const REDIRECT = 'https://api.example.test/oauth/google/callback'
const ACCOUNT = { sub: 'sub-1', email: 'ann@example.test' }
let google: FakeGoogle
beforeAll(async () => {
  google = await FakeGoogle.create()
})

async function code(opts: Parameters<FakeGoogle['consent']>[2] = {}) {
  const verifier = await pkceVerifier('s', `n-${Math.random()}`)
  const url = buildAuthorizeUrl({ endpoints: FAKE_ENDPOINTS, clientId: google.clientId, redirectUri: REDIRECT, state: 'st', challenge: await pkceChallenge(verifier) })
  const callback = new URL(await google.consent(url, ACCOUNT, opts))
  return { code: callback.searchParams.get('code')!, verifier }
}
const exchange = (c: { code: string; verifier: string }, over: Partial<Parameters<typeof exchangeCode>[0]> = {}) =>
  exchangeCode({ endpoints: FAKE_ENDPOINTS, clientId: google.clientId, clientSecret: google.clientSecret, redirectUri: REDIRECT, code: c.code, verifier: c.verifier, fetch: google.fetch, ...over })

describe('buildAuthorizeUrl (D1)', () => {
  it('asks for the authorization code flow with offline access, consent, the three scopes and an S256 challenge', () => {
    const u = new URL(buildAuthorizeUrl({ endpoints: GOOGLE_ENDPOINTS, clientId: 'cid', redirectUri: REDIRECT, state: 'the-state', challenge: 'the-challenge' }))
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = u.searchParams
    expect(Object.fromEntries(q)).toEqual({
      client_id: 'cid',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'the-state',
      code_challenge: 'the-challenge',
      code_challenge_method: 'S256',
    })
    expect(REQUESTED_SCOPES).toEqual(['openid', 'email', GMAIL_READONLY, GMAIL_SEND])
  })
})

describe('exchangeCode', () => {
  it('returns the refresh token, the access token, the ID token and the granted scopes', async () => {
    const r = await exchange(await code())
    expect(r.refreshToken).toMatch(/^rt-/)
    expect(r.accessToken).toMatch(/^at-/)
    expect(r.scopes).toEqual(['openid', 'email', GMAIL_READONLY, GMAIL_SEND])
    expect(r.idToken.split('.')).toHaveLength(3)
  })

  it('sends the client secret and the PKCE verifier in the POST body, never in the URL', async () => {
    const before = google.calls.length
    await exchange(await code())
    const call = google.calls.slice(before).find((c) => c.url.endsWith('/token'))!
    expect(call.method).toBe('POST')
    expect(call.url).not.toContain('secret')
  })

  it('a wrong verifier, a replayed code and a wrong secret are GoogleExchangeError without provider text', async () => {
    const c = await code()
    await expect(exchange({ ...c, verifier: 'x'.repeat(43) })).rejects.toBeInstanceOf(GoogleExchangeError)
    const used = await code()
    await exchange(used)
    const replay = await exchange(used).catch((e: Error) => e)
    expect(replay).toBeInstanceOf(GoogleExchangeError)
    expect(String((replay as Error).message)).not.toContain('secret provider text')
    await expect(exchange(await code(), { clientSecret: 'wrong' })).rejects.toBeInstanceOf(GoogleExchangeError)
  })

  it('a token endpoint 5xx is GoogleExchangeError too, and a response without a refresh token is refused', async () => {
    google.failToken(503)
    await expect(exchange(await code())).rejects.toBeInstanceOf(GoogleExchangeError)
    google.failToken(null)
    await expect(exchange(await code({ noRefreshToken: true }))).rejects.toBeInstanceOf(GoogleExchangeError)
  })
})

describe('verifyIdToken (D9)', () => {
  const verify = async (opts: Parameters<FakeGoogle['consent']>[2]) => {
    const { idToken } = await exchange(await code(opts))
    return verifyIdToken(idToken, { endpoints: FAKE_ENDPOINTS, clientId: google.clientId, fetch: google.fetch, nowMs: Date.now() })
  }

  it('returns the sub and the email of a good token', async () => {
    expect(await verify({})).toEqual({ sub: 'sub-1', email: 'ann@example.test' })
  })

  it.each([
    ['the wrong aud', { idToken: { aud: 'another-client' } }],
    ['the wrong iss', { idToken: { iss: 'https://evil.example.test' } }],
    ['an unverified email', { idToken: { emailVerified: false } }],
    ['an expired token', { idToken: { expired: true } }],
  ])('refuses %s', async (_name, opts) => {
    await expect(verify(opts)).rejects.toBeInstanceOf(GoogleExchangeError)
  })

  it('accepts both issuer spellings Google uses, and refuses a token signed by another key', async () => {
    expect(await verify({ idToken: { iss: 'accounts.google.com' } })).toMatchObject({ sub: 'sub-1' })
    const other = await FakeGoogle.create({ clientId: google.clientId })
    const { idToken } = await exchange(await code())
    await expect(verifyIdToken(idToken, { endpoints: FAKE_ENDPOINTS, clientId: google.clientId, fetch: other.fetch, nowMs: Date.now() })).rejects.toBeInstanceOf(GoogleExchangeError)
  })
})
