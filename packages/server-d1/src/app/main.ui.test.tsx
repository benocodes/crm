// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// [[UI460]] D4, D7, P2 (groups 4, 5): the mount reads discovery, builds the seam for the page, sets the title, and draws; nothing is stored, and Sign in never carries the page's query.
afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ME = {
  principal: { id: 'p1', kind: 'user' },
  user: { id: 'u1', email: 'ann@x.test', name: 'Ann', email_verified: true },
  agent: null,
  client_id: null,
  memberships: [{ organization_id: 'o1', organization_name: 'Acme', role: 'owner' }],
  active_organization: { id: 'o1', role: 'owner', scopes: [] },
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const stubFetch = (routes: Record<string, () => Response>) => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input), location.origin).pathname}`
    calls.push(key)
    const r = routes[key]
    if (!r) throw new Error(`unexpected ${key}`)
    return r()
  })
  return calls
}
const DISCOVERY = {
  api: 'https://w.test',
  auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: 'cli', publishable_key: null },
}
const mount = async (path: string) => {
  document.body.innerHTML = '<div id="root"></div>'
  history.replaceState(null, '', path)
  await import('./main.js')
}

describe('the mount', () => {
  it('signed in: sets the title "Home · Vibase" and draws the shell and Home', async () => {
    stubFetch({
      'GET /.well-known/vibase': () => json(DISCOVERY),
      'GET /auth/get-session': () => json({ user: { id: 'u1' }, session: { id: 's' } }),
      'GET /auth/token': () => json({ token: 't' }),
      'GET /meta/v1/me': () => json(ME),
    })
    await mount('/home')
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Welcome to your CRM'))
    expect(document.title).toBe('Home · Vibase')
    expect(document.querySelector('#root')!.tagName).toBe('DIV') // not a landmark: the shell renders <main> (443.40)
    expect(localStorage.length + sessionStorage.length).toBe(0)
  })

  it('signed out: the Sign in card, and the page query is not carried to /sign-in', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    stubFetch({
      'GET /.well-known/vibase': () => json(DISCOVERY),
      'GET /auth/get-session': () => json(null),
    })
    await mount('/home?utm=x&next=/evil')
    const button = await vi.waitFor(() => {
      const b = document.querySelector('button')
      expect(b?.textContent).toBe('Sign in')
      return b!
    })
    expect(assign).not.toHaveBeenCalled() // nothing navigates on load
    button.click()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/sign-in?return_to=/home'))
  })

  it('unreadable discovery: unavailable, and no session or API call', async () => {
    const calls = stubFetch({ 'GET /.well-known/vibase': () => json({}, 500) })
    await mount('/home')
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/unavailable/i))
    expect(calls).toEqual(['GET /.well-known/vibase'])
  })

  it('discovery with no provider: unavailable', async () => {
    const calls = stubFetch({ 'GET /.well-known/vibase': () => json({ auth: null }) })
    await mount('/home')
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/unavailable/i))
    expect(calls).toEqual(['GET /.well-known/vibase'])
  })
})
