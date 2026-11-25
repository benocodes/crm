// @vitest-environment happy-dom
// [[DX609]] group 3 (P2): every failure the page shows reads as before the move to the SDK, and a 401 stops polling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './app.js'
import { API, CONFIG, fakeFetch, fakeLocation, settle } from './test-kit.js'

const SIGNED_IN = {
  'GET /.well-known/vibase': { auth: { provider: 'better-auth' } },
  'GET /auth/get-session': { user: { email: 'owner@e2e.test' }, session: { id: 's1' } },
  'GET /auth/token': { token: 'jwt-1' },
}
const root = () => document.getElementById('app')!
const alert = () => root().querySelector('[role=alert]')?.textContent ?? null
let clear: ReturnType<typeof vi.spyOn>

async function start(listRoute: Parameters<typeof fakeFetch>[0][string], extra: Parameters<typeof fakeFetch>[0] = {}) {
  const f = fakeFetch({ ...SIGNED_IN, 'GET /api/v1/action-requests': listRoute, ...extra })
  await run(root(), { config: CONFIG, fetch: f.fetch, location: fakeLocation().location })
  await settle()
  return f
}

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>'
  clear = vi.spyOn(window, 'clearInterval')
})
afterEach(() => vi.restoreAllMocks())

describe('failures read as today', () => {
  it('no token: "Your session has ended. Sign in again." and polling stops', async () => {
    const f = await start({ data: [], next_cursor: null }, { 'GET /auth/token': new Response('{}', { status: 401 }) })
    expect(alert()).toContain('Your session has ended. Sign in again.')
    expect(f.seen.some((s) => s.url.startsWith(`${API}/api/v1/`))).toBe(false)
    expect(clear).toHaveBeenCalled()
  })

  it('an API error body shows its message; a 401 stops polling', async () => {
    await start(Response.json({ error: { code: 'unauthorized', message: 'Token expired' } }, { status: 401 }))
    expect(alert()).toBe('Token expired')
    expect(clear).toHaveBeenCalled()
  })

  it('a 403 shows the message with the scope hint and does not stop polling', async () => {
    await start(Response.json({ error: { code: 'forbidden', message: 'Missing scope' } }, { status: 403 }))
    expect(alert()).toBe(
      "Not allowed: Missing scope. This account needs the action_requests read scope (and the target's write scope to approve).",
    )
    expect(clear).not.toHaveBeenCalled()
  })

  it('an error with no API error body shows "Request failed (<status>)"', async () => {
    await start(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(alert()).toBe('Request failed (502)')
    expect(clear).not.toHaveBeenCalled()
  })

  it('a network failure shows "Vibase could not be reached."', async () => {
    await start(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(alert()).toBe('Vibase could not be reached.')
    expect(clear).not.toHaveBeenCalled()
  })
})
