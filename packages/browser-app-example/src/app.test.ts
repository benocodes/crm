// @vitest-environment happy-dom
// DX637 group 2: the page's states (matrix: page state x trigger), driven with an injected fetch, storage and location (P1, P2, P3, P5).
import { beforeEach, describe, expect, it } from 'vitest'
import { run } from './app.js'
import { API, APP, CONFIG, deployment, ISSUER, Mem, settle } from './test-kit.js'

const root = () => document.getElementById('app')!
const button = (label: string) => [...root().querySelectorAll('button')].find((b) => b.textContent === label)
const click = async (label: string) => {
  const b = button(label)
  expect(b, `a "${label}" button`).toBeTruthy()
  b!.click()
  await settle()
}

function page(over: Parameters<typeof deployment>[0] = {}) {
  const dep = deployment(over)
  const store = new Mem()
  const navigated: string[] = []
  const replaced: string[] = []
  async function open(href = `${APP}/`) {
    document.body.innerHTML = '<main id="app"></main>'
    await run(root(), {
      config: CONFIG,
      fetch: dep.fetch,
      location: { href, origin: APP },
      navigate: (u) => void navigated.push(u),
      replaceUrl: (u) => void replaced.push(u),
      sessionStorage: store,
    })
    await settle()
  }
  /** The real flow: click "Sign in", then come back on the callback with the state the page sent. */
  async function signInThrough() {
    await open()
    await click('Sign in')
    const state = new URL(navigated.at(-1)!).searchParams.get('state')!
    await open(`${APP}/callback?code=code-1&state=${state}&iss=${encodeURIComponent(ISSUER)}`)
  }
  const apiCalls = () => dep.seen.filter((s) => s.url.startsWith(`${API}/api/`) || s.url.startsWith(`${API}/meta/`))
  return { dep, store, navigated, replaced, open, signInThrough, apiCalls }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('signed out', () => {
  it('shows "Sign in", and its click navigates to the authorize endpoint for this client and the callback, with no scope (P3, P5)', async () => {
    const p = page()
    await p.open()
    expect(root().textContent).not.toContain('Refresh now')
    await click('Sign in')
    const u = new URL(p.navigated.at(-1)!)
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/oauth2/authorize`)
    expect(u.searchParams.get('client_id')).toBe(CONFIG.clientId)
    expect(u.searchParams.get('redirect_uri')).toBe(`${APP}/callback`)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.has('scope')).toBe(false)
  })
})

describe('the callback', () => {
  it('runs handleRedirect, lands signed in, and replaces the URL with returnTo (P3)', async () => {
    const p = page()
    await p.signInThrough()
    expect(root().textContent).toContain('Sign out')
    expect(p.replaced.at(-1)).toBe('/')
    expect(p.dep.tokenRequests()[0]!.form!.get('grant_type')).toBe('authorization_code')
  })

  it('a handleRedirect rejection shows its code above "Sign in" and "Sign in" clears it (P1)', async () => {
    const p = page()
    await p.open()
    await click('Sign in')
    await p.open(`${APP}/callback?code=code-1&state=not-the-state&iss=${encodeURIComponent(ISSUER)}`)
    expect(root().textContent).toContain('state_mismatch')
    expect(button('Sign in')).toBeTruthy()
    await click('Sign in')
    expect(root().textContent).not.toContain('state_mismatch')
  })
})

describe('signed in', () => {
  it('shows the principal kind, the email and the contacts, every call with a bearer', async () => {
    const p = page()
    await p.signInThrough()
    const text = root().textContent!
    expect(text).toContain('user')
    expect(text).toContain('owner@e2e.test')
    expect(text).toContain('Ada Lovelace')
    expect(text).toContain('Grace Hopper')
    expect(p.apiCalls().length).toBeGreaterThanOrEqual(2)
    for (const c of p.apiCalls()) expect(c.authorization).toBe('Bearer at-1')
  })

  it('a reload stays signed in without another authorize', async () => {
    const p = page()
    await p.signInThrough()
    const before = p.navigated.length
    await p.open()
    expect(root().textContent).toContain('Ada Lovelace')
    expect(p.navigated).toHaveLength(before)
  })

  it('"Refresh now" sends one refresh_token grant and lists again with the new bearer', async () => {
    const p = page()
    await p.signInThrough()
    const tokensBefore = p.dep.tokenRequests().length
    const callsBefore = p.apiCalls().length
    await click('Refresh now')
    const added = p.dep.tokenRequests().slice(tokensBefore)
    expect(added).toHaveLength(1)
    expect(added[0]!.form!.get('grant_type')).toBe('refresh_token')
    expect(added[0]!.form!.get('refresh_token')).toBe('rt-1')
    const after = p.apiCalls().slice(callsBefore)
    expect(after.length).toBeGreaterThanOrEqual(2)
    for (const c of after) expect(c.authorization).toMatch(/^Bearer at-refreshed-/)
    expect(root().textContent).toContain('Ada Lovelace')
  })

  it('"Sign out" clears the token record and shows "Sign in"', async () => {
    const p = page()
    await p.signInThrough()
    await click('Sign out')
    expect(button('Sign in')).toBeTruthy()
    expect(root().textContent).not.toContain('Ada Lovelace')
    expect([...p.store.map.keys()].filter((k) => k.endsWith(':token'))).toEqual([])
  })
})

describe('API errors (P1)', () => {
  it('a 401 signs out: "Sign in" shows with one line saying the deployment signed the app out', async () => {
    const p = page()
    await p.signInThrough()
    p.dep.d.contacts = () => ({ status: 401, body: { error: { code: 'invalid_token', message: 'revoked' } } })
    await click('Refresh now')
    expect(button('Sign in')).toBeTruthy()
    expect(root().textContent).toContain('signed the app out')
    expect([...p.store.map.keys()].filter((k) => k.endsWith(':token'))).toEqual([])
  })

  it('a refresh answered 400 (the client is gone) signs out the same way', async () => {
    const p = page()
    await p.signInThrough()
    p.dep.d.token = () => ({ status: 400, body: { error: 'invalid_client' } })
    await click('Refresh now')
    expect(button('Sign in')).toBeTruthy()
    expect(root().textContent).toContain('signed the app out')
  })

  it('a 403 stays signed in and shows its code; the message clears on the next successful load', async () => {
    const p = page()
    await p.signInThrough()
    p.dep.d.contacts = () => ({ status: 403, body: { error: { code: 'insufficient_scope', message: 'narrowed' } } })
    await click('Refresh now')
    expect(button('Sign out')).toBeTruthy()
    expect(root().textContent).toContain('insufficient_scope')
    expect(root().textContent).not.toContain('signed the app out')
    p.dep.d.contacts = () => ({ body: { data: [{ id: 'c1', name: 'Ada Lovelace' }], next_cursor: null } })
    await click('Refresh now')
    expect(root().textContent).not.toContain('insufficient_scope')
    expect(root().textContent).toContain('Ada Lovelace')
  })

  it('any other error is shown inline with its code and the page stays signed in', async () => {
    const p = page()
    await p.signInThrough()
    p.dep.d.me = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } })
    await click('Refresh now')
    expect(button('Sign out')).toBeTruthy()
    expect(root().textContent).toContain('internal')
  })
})
