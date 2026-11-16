// @vitest-environment happy-dom
// [[UI388]] group 1: the provider is chosen from discovery, and only that provider's module is imported (P1, D4).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './app.js'
import { API, CONFIG, fakeFetch, fakeLocation } from './test-kit.js'

// A mock factory runs when its module is first imported, so `evaluated` records which provider modules the app loaded.
const { evaluated, loadSession } = vi.hoisted(() => ({
  evaluated: [] as string[],
  loadSession: vi.fn(async () => ({
    signedIn: false,
    email: null,
    token: async () => null,
    signIn: async () => {},
    signOut: async () => {},
  })),
}))
vi.mock('./clerk.js', () => {
  evaluated.push('clerk')
  return { loadSession }
})
vi.mock('./better-auth.js', () => {
  evaluated.push('better-auth')
  return { loadSession }
})

const DISCOVERY = 'GET /.well-known/vibase'
const root = () => document.getElementById('app')!
async function start(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes)
  await run(root(), { config: CONFIG, fetch: f.fetch, location: fakeLocation().location })
  return f
}

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>'
  evaluated.length = 0
  loadSession.mockClear()
})

describe('provider choice', () => {
  it('clerk imports only the Clerk module', async () => {
    await start({ [DISCOVERY]: { auth: { provider: 'clerk' } } })
    expect(evaluated).toEqual(['clerk'])
    expect(loadSession).toHaveBeenCalledWith(CONFIG, expect.anything())
    expect(root().textContent).toContain('Sign in')
  })

  it('better-auth imports only the Better Auth module', async () => {
    await start({ [DISCOVERY]: { auth: { provider: 'better-auth' } } })
    expect(evaluated).toEqual(['better-auth'])
    expect(root().textContent).toContain('Sign in')
  })

  const unavailable: Array<[string, Parameters<typeof fakeFetch>[0]]> = [
    ['auth null', { [DISCOVERY]: { auth: null } }],
    ['an unknown provider', { [DISCOVERY]: { auth: { provider: 'okta' } } }],
    ['a non-2xx', { [DISCOVERY]: new Response('{"auth":{"provider":"clerk"}}', { status: 503 }) }],
    [
      'a network error',
      {
        [DISCOVERY]: () => {
          throw new TypeError('Failed to fetch')
        },
      },
    ],
    ['a malformed body', { [DISCOVERY]: new Response('<html>nope</html>', { status: 200 }) }],
    ['a body that is not the document', { [DISCOVERY]: ['clerk'] }],
  ]
  it.each(unavailable)('%s shows the unavailable view and imports neither module', async (_name, routes) => {
    await start(routes)
    expect(root().textContent).toContain('Sign-in is unavailable')
    expect(evaluated).toEqual([])
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('reads <apiOrigin>/.well-known/vibase without credentials', async () => {
    const f = await start({ [DISCOVERY]: { auth: { provider: 'clerk' } } })
    expect(f.seen[0]).toMatchObject({ method: 'GET', url: `${API}/.well-known/vibase`, credentials: 'omit' })
  })
})
