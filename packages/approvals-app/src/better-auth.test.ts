// @vitest-environment happy-dom
// [[UI388]] groups 2 and 3 (session level): the Better Auth session on the real `better-auth/client` + `jwtClient`, against a fake `fetch` (P2, P3, D2).
import { describe, expect, it } from 'vitest'
import { loadSession } from './better-auth.js'
import { API, APP_URL, CONFIG, fakeFetch, fakeLocation } from './test-kit.js'

const SESSION = { user: { email: 'owner@e2e.test' }, session: { id: 's1' } }
const open = (routes: Parameters<typeof fakeFetch>[0], href = APP_URL) => {
  const f = fakeFetch(routes)
  const l = fakeLocation(href)
  return { ...f, ...l, session: loadSession(CONFIG, { fetch: f.fetch, location: l.location }) }
}

describe('signed in', () => {
  it('reads signedIn and email from /auth/get-session, credentialed, under the API origin', async () => {
    const t = open({ 'GET /auth/get-session': SESSION })
    const s = await t.session
    expect(s.signedIn).toBe(true)
    expect(s.email).toBe('owner@e2e.test')
    expect(t.seen.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${API}/auth/get-session`])
    expect(t.seen.every((r) => r.credentials === 'include')).toBe(true)
  })

  it('token() fetches /auth/token on every call (two calls, two requests), credentialed', async () => {
    let n = 0
    const t = open({
      'GET /auth/get-session': SESSION,
      'GET /auth/token': () => Response.json({ token: `jwt-${++n}` }),
    })
    const s = await t.session
    expect(await s.token()).toBe('jwt-1')
    expect(await s.token()).toBe('jwt-2')
    const tokens = t.seen.filter((r) => r.url === `${API}/auth/token`)
    expect(tokens).toHaveLength(2)
    expect(tokens.every((r) => r.credentials === 'include')).toBe(true)
  })

  it('token() is null when the SDK returns an error (P2)', async () => {
    const t = open({
      'GET /auth/get-session': SESSION,
      'GET /auth/token': new Response('{"message":"x"}', { status: 401 }),
    })
    expect(await (await t.session).token()).toBeNull()
  })

  it('token() is null when the SDK throws on a network error (P2)', async () => {
    const t = open({
      'GET /auth/get-session': SESSION,
      'GET /auth/token': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await (await t.session).token()).toBeNull()
  })
})

describe('signed out', () => {
  it('a null session is signed out, and token() is null', async () => {
    const t = open({ 'GET /auth/get-session': null, 'GET /auth/token': { token: 'must-not-be-used' } })
    const s = await t.session
    expect(s.signedIn).toBe(false)
    expect(s.email).toBeNull()
    expect(await s.token()).toBeNull()
  })

  it('getSession failing (non-2xx) rejects, which the page shows as unavailable (P2)', async () => {
    const t = open({ 'GET /auth/get-session': new Response('{"message":"boom"}', { status: 500 }) })
    await expect(t.session).rejects.toThrow()
  })

  it('getSession failing (network) rejects (P2)', async () => {
    const t = open({
      'GET /auth/get-session': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(t.session).rejects.toThrow()
  })
})

describe('sign in and sign out', () => {
  it('signIn() navigates to the vault /sign-in with the current URL, fragment dropped, as return_to (P3)', async () => {
    const t = open({ 'GET /auth/get-session': null }, 'http://localhost:8788/?tab=failed&x=a b#frag')
    await (await t.session).signIn()
    expect(t.calls.assign).toEqual([
      `${API}/app/sign-in?return_to=${encodeURIComponent('http://localhost:8788/?tab=failed&x=a%20b')}`,
    ])
  })

  it('signOut() posts /auth/sign-out credentialed, then reloads', async () => {
    const t = open({ 'GET /auth/get-session': SESSION, 'POST /auth/sign-out': { success: true } })
    await (await t.session).signOut()
    const out = t.seen.filter((r) => r.method === 'POST')
    expect(out.map((r) => r.url)).toEqual([`${API}/auth/sign-out`])
    expect(out[0]!.credentials).toBe('include')
    expect(t.calls.reload).toBe(1)
  })

  it('a refused sign-out (403) rejects and does not reload (P2)', async () => {
    const t = open({
      'GET /auth/get-session': SESSION,
      'POST /auth/sign-out': new Response('{"message":"Invalid origin"}', { status: 403 }),
    })
    await expect((await t.session).signOut()).rejects.toThrow()
    expect(t.calls.reload).toBe(0)
  })

  it('a sign-out that fails on the network rejects and does not reload (P2)', async () => {
    const t = open({
      'GET /auth/get-session': SESSION,
      'POST /auth/sign-out': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect((await t.session).signOut()).rejects.toThrow()
    expect(t.calls.reload).toBe(0)
  })
})
