// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The app is a client-routed SPA (reverses UI460 D7): one mount, discovery and me.get read once, navigation never loads a page.
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
  active_organization: { id: 'o1', role: 'owner', scopes: ['connections:read', 'agents:read'] },
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const DISCOVERY = {
  api: 'https://w.test',
  auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: 'cli', publishable_key: null },
}
const signedIn: Record<string, () => Response> = {
  'GET /.well-known/vibase': () => json(DISCOVERY),
  'GET /auth/get-session': () => json({ user: { id: 'u1' }, session: { id: 's' } }),
  'GET /auth/token': () => json({ token: 't' }),
  'GET /meta/v1/me': () => json(ME),
  'GET /meta/v1/connections': () => json({ data: [], next_cursor: null }),
  'GET /meta/v1/agents': () => json({ data: [], next_cursor: null }),
}
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
const mount = async (path: string) => {
  document.body.innerHTML = '<div id="root"></div>'
  history.replaceState(null, '', path)
  await import('./main.js')
}
const h1 = () => document.querySelector('h1')?.textContent
const navLink = (name: string) =>
  [...document.querySelectorAll<HTMLAnchorElement>('nav a')].find((a) => a.textContent === name)!
const current = () => document.querySelector('nav a[aria-current="page"]')?.textContent
const BOOT = ['GET /.well-known/vibase', 'GET /auth/get-session', 'GET /meta/v1/me']

describe('client-side navigation', () => {
  it('a nav click changes the view and the URL with no page load and no second discovery, session or me.get', async () => {
    const calls = stubFetch(signedIn)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    await mount('/home')
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    const root = document.querySelector('#root')
    const before = calls.filter((c) => BOOT.includes(c)).sort()
    navLink('Agents').click()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
    expect(location.pathname).toBe('/agents')
    navLink('Connected accounts').click()
    await vi.waitFor(() => expect(h1()).toBe('Connected accounts'))
    expect(location.pathname).toBe('/accounts')
    expect(assign).not.toHaveBeenCalled()
    expect(document.querySelector('#root')).toBe(root)
    expect(calls.filter((c) => BOOT.includes(c)).sort()).toEqual(before)
    expect(calls.filter((c) => c === 'GET /.well-known/vibase')).toHaveLength(1)
    expect(calls.filter((c) => c === 'GET /meta/v1/me')).toHaveLength(1)
  })

  it('the shell stays mounted across a click (same nav element)', async () => {
    stubFetch(signedIn)
    await mount('/home')
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    const nav = document.querySelector('nav')
    navLink('Agents').click()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
    expect(document.querySelector('nav')).toBe(nav)
  })

  it('the active nav row and document.title follow the route, including back and forward', async () => {
    stubFetch(signedIn)
    await mount('/home')
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    expect(current()).toBe('Home')
    expect(document.title).toBe('Home · Vibase')
    navLink('Agents').click()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
    expect(current()).toBe('Agents')
    expect(document.title).toBe('Agents · Vibase')
    navLink('Connected accounts').click()
    await vi.waitFor(() => expect(h1()).toBe('Connected accounts'))
    expect(current()).toBe('Connected accounts')
    expect(document.title).toBe('Connected accounts · Vibase')
    history.back()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
    expect(current()).toBe('Agents')
    expect(document.title).toBe('Agents · Vibase')
    history.back()
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    expect(document.title).toBe('Home · Vibase')
    history.forward()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
  })

  it.each([
    ['/home', 'Welcome to your CRM', 'Home'],
    ['/accounts', 'Connected accounts', 'Connected accounts'],
    ['/agents', 'Agents', 'Agents'],
  ])('a direct load of %s draws that page with its row current', async (path, heading, row) => {
    stubFetch(signedIn)
    await mount(path)
    await vi.waitFor(() => expect(h1()).toBe(heading))
    expect(current()).toBe(row)
  })

  it('an unknown path inside the SPA shows a not-found state in the shell with a link home', async () => {
    stubFetch(signedIn)
    await mount('/home')
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    history.pushState(null, '', '/nope')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() => expect(h1()).toBe('Page not found'))
    expect(current()).toBeUndefined()
    expect(document.querySelector<HTMLAnchorElement>('main a')?.getAttribute('href')).toBe('/home')
  })

  it('signed out after navigating: Sign in returns to the CURRENT route, not the one the page loaded on', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    let session = true
    stubFetch({
      ...signedIn,
      'GET /auth/get-session': () => json(session ? { user: { id: 'u1' }, session: { id: 's' } } : null),
      'POST /auth/sign-out': () => {
        session = false
        return json({ success: true })
      },
    })
    await mount('/home')
    await vi.waitFor(() => expect(h1()).toBe('Welcome to your CRM'))
    navLink('Agents').click()
    await vi.waitFor(() => expect(h1()).toBe('Agents'))
    ;[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')!.click()
    const signIn = await vi.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sign in')
      expect(b).toBeTruthy()
      return b!
    })
    signIn.click()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/sign-in?return_to=/agents'))
  })
})
