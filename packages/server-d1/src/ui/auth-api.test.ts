// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSession, resetPassword, signIn, signOut, signUp } from './auth-api.js'
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
