// @vitest-environment happy-dom
// [[UI388]] group 3 (page level): the views on the Better Auth path, through the real session module (P2).
import { beforeEach, describe, expect, it } from 'vitest'
import { run } from './app.js'
import { API, CONFIG, fakeFetch, fakeLocation, settle } from './test-kit.js'

const DISCOVERY = { 'GET /.well-known/vibase': { auth: { provider: 'better-auth' } } }
const SESSION = { user: { email: 'owner@e2e.test' }, session: { id: 's1' } }
const root = () => document.getElementById('app')!
const button = (label: string) => [...root().querySelectorAll('button')].find((b) => b.textContent === label)!
async function start(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch({ ...DISCOVERY, ...routes })
  const l = fakeLocation()
  await run(root(), { config: CONFIG, fetch: f.fetch, location: l.location })
  await settle()
  return { ...f, ...l }
}

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>'
})

describe('Better Auth views', () => {
  it('getSession failing is the unavailable view', async () => {
    await start({ 'GET /auth/get-session': new Response('{}', { status: 500 }) })
    expect(root().textContent).toContain('Sign-in is unavailable')
    expect(button('Sign in')).toBeUndefined()
  })

  it('a null session is the signed-out view with the Sign in button, which signs in with return_to', async () => {
    const t = await start({ 'GET /auth/get-session': null })
    expect(root().textContent).not.toContain('Sign-in is unavailable')
    button('Sign in')!.click()
    await settle()
    expect(t.calls.assign).toHaveLength(1)
    expect(t.calls.assign[0]).toMatch(`${API}/sign-in?return_to=`)
  })

  it('signed in shows the email and calls the API with the session JWT as a Bearer', async () => {
    const t = await start({
      'GET /auth/get-session': SESSION,
      'GET /auth/token': { token: 'jwt-1' },
      'GET /api/v1/action-requests': { data: [], next_cursor: null },
    })
    expect(root().textContent).toContain('owner@e2e.test')
    const list = t.seen.find((r) => r.url.startsWith(`${API}/api/v1/action-requests`))!
    expect(list.headers.authorization).toBe('Bearer jwt-1')
    expect(list.credentials).toBe('omit')
  })

  const signedIn = {
    'GET /auth/get-session': SESSION,
    'GET /auth/token': { token: 'jwt-1' },
    'GET /api/v1/action-requests': { data: [], next_cursor: null },
  }

  it('a refused sign-out does not reload, shows an error, stays signed in, and the error clears on the next action', async () => {
    const t = await start({
      ...signedIn,
      'POST /auth/sign-out': new Response('{"message":"Invalid origin"}', { status: 403 }),
    })
    button('Sign out')!.click()
    await settle()
    expect(t.calls.reload).toBe(0)
    expect(root().querySelector('[role=alert]')?.textContent).toMatch(/sign out/i)
    expect(root().textContent).toContain('owner@e2e.test')
    button('Refresh')!.click()
    await settle()
    expect(root().querySelector('[role=alert]')).toBeNull()
  })

  it('a successful sign-out reloads', async () => {
    const t = await start({ ...signedIn, 'POST /auth/sign-out': { success: true } })
    button('Sign out')!.click()
    await settle()
    expect(t.calls.reload).toBe(1)
  })
})
