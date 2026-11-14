// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approveDevice, claimDeviceCode, denyDevice, getClientName, getSession, isFollowable, resetPassword, signIn, signOut, signUp, submitConsent } from './auth-api.js'
import { fakeFetch } from './fake-fetch.js'

// [[UI246]] D3: five same-origin calls to Better Auth with `fetch`; the answer is reduced to a status and a machine code, and a server `message` is never carried.
afterEach(() => vi.unstubAllGlobals())

describe('the five calls', () => {
  it('signUp: POST /auth/sign-up/email, JSON body, cookies included, exactly the given fields', async () => {
    const f = fakeFetch({ 'POST /auth/sign-up/email': { status: 200, json: { user: { email: 'a@x.test', name: 'A' } } } })
    const body = { name: 'A', email: 'a@x.test', password: 'long enough pw', invitation_token: 'tok' }
    const r = await signUp(body)
    expect(r).toEqual({ ok: true, data: { user: { email: 'a@x.test', name: 'A' } } })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.body).toEqual(body)
    expect(f.calls[0]!.init.credentials).toBe('include')
    expect(new Headers(f.calls[0]!.init.headers).get('content-type')).toBe('application/json')
  })

  it('signIn: POST /auth/sign-in/email with { email, password } only', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'a@x.test' } } } })
    expect(await signIn({ email: 'a@x.test', password: 'pw' })).toEqual({ ok: true, data: { user: { email: 'a@x.test' } } })
    expect(f.calls[0]!.body).toEqual({ email: 'a@x.test', password: 'pw' })
    expect(f.calls[0]!.init.credentials).toBe('include')
  })

  it('getSession: GET /auth/get-session; a null body is "no session"', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': { status: 200, json: null } })
    expect(await getSession()).toEqual({ ok: true, data: null })
    expect(f.calls[0]!.init.credentials).toBe('include')
    fakeFetch({ 'GET /auth/get-session': { status: 200, json: { user: { email: 'a@x.test', name: 'A', id: 'u1' }, session: {} } } })
    expect(await getSession()).toEqual({ ok: true, data: { user: { email: 'a@x.test', name: 'A' } } })
  })

  it('signOut: POST /auth/sign-out', async () => {
    const f = fakeFetch({ 'POST /auth/sign-out': { status: 200, json: { success: true } } })
    expect((await signOut()).ok).toBe(true)
    expect(f.requests()).toEqual(['POST /auth/sign-out'])
  })

  it('resetPassword: POST /auth/reset-password with { newPassword, token } only', async () => {
    const f = fakeFetch({ 'POST /auth/reset-password': { status: 200, json: { status: true } } })
    expect((await resetPassword({ newPassword: 'new password 1', token: 'tok' })).ok).toBe(true)
    expect(f.calls[0]!.body).toEqual({ newPassword: 'new password 1', token: 'tok' })
  })
})

describe('failures reduce to a status and a code', () => {
  it('carries the string `code` of a JSON body and the status, never the message', async () => {
    fakeFetch({ 'POST /auth/sign-in/email': { status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD', message: '<b>server words</b>' } } })
    const r = await signIn({ email: 'a@x.test', password: 'pw' })
    expect(r).toEqual({ ok: false, status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })
    expect(JSON.stringify(r)).not.toContain('server words')
  })

  it.each([
    ['a non-JSON body', { status: 500, text: 'Internal Server Error' }, { ok: false, status: 500 }],
    ['a JSON body without a code', { status: 429, json: { message: 'Too many requests' } }, { ok: false, status: 429 }],
    ['a non-string code', { status: 400, json: { code: 7 } }, { ok: false, status: 400 }],
  ])('%s: the status alone', async (_n, reply, expected) => {
    fakeFetch({ 'POST /auth/sign-up/email': reply })
    expect(await signUp({ name: 'A', email: 'a@x.test', password: 'long enough pw', invitation_token: 't' })).toEqual(expected)
  })

  it('a network failure is status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await signIn({ email: 'a@x.test', password: 'pw' })).toEqual({ ok: false, status: 0 })
  })
})

// [[UI247]] D6: the two additions to the client (`code` falls back to the OAuth `error`; a success may carry the validated redirect URL) and the calls of the device and consent pages.
describe('the OAuth and device answers (UI247 D6)', () => {
  it('a failure without `code` falls back to the string `error` of an OAuth body, and carries neither error_description nor message', async () => {
    fakeFetch({ 'POST /auth/oauth2/consent': { status: 400, json: { error: 'invalid_signature', error_description: '<b>words</b>', message: 'more words' } } })
    const r = await submitConsent(true, 'a=b')
    expect(r).toEqual({ ok: false, status: 400, code: 'invalid_signature' })
    expect(JSON.stringify(r)).not.toContain('words')
  })

  it('`code` wins over `error` when a body has both', async () => {
    fakeFetch({ 'POST /auth/sign-in/email': { status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD', error: 'x' } } })
    expect(await signIn({ email: 'a@x.test', password: 'pw' })).toEqual({ ok: false, status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })
  })

  it('signIn with an oauthQuery sends it as `oauth_query` and returns the redirect URL of { redirect: true, url }', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: true, url: '/consent?client_id=c&sig=s' } } })
    expect(await signIn({ email: 'a@x.test', password: 'pw', oauthQuery: 'client_id=c&sig=s' })).toEqual({ ok: true, data: { redirect: '/consent?client_id=c&sig=s' } })
    expect(f.calls[0]!.body).toEqual({ email: 'a@x.test', password: 'pw', oauth_query: 'client_id=c&sig=s' })
  })

  it('signIn without an oauthQuery sends no oauth_query key', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: false, user: { email: 'a@x.test' } } } })
    expect(await signIn({ email: 'a@x.test', password: 'pw' })).toEqual({ ok: true, data: { user: { email: 'a@x.test' } } })
    expect(Object.keys(f.calls[0]!.body as object)).toEqual(['email', 'password'])
  })

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'blob:http://localhost/x'])('a redirect to %s is not followed: the call is a failure', async (url) => {
    fakeFetch({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url } } })
    const r = await submitConsent(true, 'a=b')
    expect(r.ok).toBe(false)
    fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: true, url } } })
    expect((await signIn({ email: 'a@x.test', password: 'pw', oauthQuery: 'a=b' })).ok).toBe(false)
  })

  it.each([
    ['https://client.test/cb?code=1', true],
    ['http://127.0.0.1:33418/cb?code=1', true],
    ['/consent?a=b', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['data:text/html,x', false],
    ['', false],
  ])('isFollowable(%s) is %s', (url, expected) => {
    expect(isFollowable(url)).toBe(expected)
  })

  it('submitConsent posts { accept, oauth_query } and no scope', async () => {
    const f = fakeFetch({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url: 'http://127.0.0.1:1/cb?code=c' } } })
    expect(await submitConsent(false, 'client_id=c&sig=s')).toEqual({ ok: true, data: { redirect: 'http://127.0.0.1:1/cb?code=c' } })
    expect(f.calls[0]!.body).toEqual({ accept: false, oauth_query: 'client_id=c&sig=s' })
  })

  it('claimDeviceCode: GET /auth/device?user_code= reduced to { status, clientId, scope }; no client_id stays absent', async () => {
    const f = fakeFetch({ 'GET /auth/device': { status: 200, json: { user_code: 'ABCDEFGH', status: 'pending', client_id: 'vibase-cli', scope: 'openid contacts:read' } } })
    expect(await claimDeviceCode('ABCDEFGH')).toEqual({ ok: true, data: { status: 'pending', clientId: 'vibase-cli', scope: 'openid contacts:read' } })
    expect(f.calls[0]!.path + new URL('http://x' + (f.fn.mock.calls[0]![0] as string)).search).toContain('user_code=ABCDEFGH')
    fakeFetch({ 'GET /auth/device': { status: 200, json: { user_code: 'ABCDEFGH', status: 'pending' } } })
    expect(await claimDeviceCode('ABCDEFGH')).toEqual({ ok: true, data: { status: 'pending' } })
  })

  it('approveDevice and denyDevice post { userCode } to their endpoints', async () => {
    const f = fakeFetch({ 'POST /auth/device/approve': { status: 200, json: { success: true } }, 'POST /auth/device/deny': { status: 200, json: { success: true } } })
    expect((await approveDevice('ABCDEFGH')).ok).toBe(true)
    expect((await denyDevice('ABCDEFGH')).ok).toBe(true)
    expect(f.calls.map((c) => [c.path, c.body])).toEqual([
      ['/auth/device/approve', { userCode: 'ABCDEFGH' }],
      ['/auth/device/deny', { userCode: 'ABCDEFGH' }],
    ])
  })

  it('getClientName reads client_name from /auth/oauth2/public-client?client_id=', async () => {
    const f = fakeFetch({ 'GET /auth/oauth2/public-client': { status: 200, json: { client_id: 'vibase-cli', client_name: 'Vibase CLI', client_uri: 'https://evil.test' } } })
    expect(await getClientName('vibase-cli')).toEqual({ ok: true, data: { name: 'Vibase CLI' } })
    expect(String(f.fn.mock.calls[0]![0])).toContain('client_id=vibase-cli')
  })
})
