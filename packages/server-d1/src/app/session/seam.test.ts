// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { selectSeam } from './seam.js'
import type { Discovery } from './types.js'

// [[UI297]] D7: which seam the page builds from the discovery document, and what the page does with it. No Clerk script on `better-auth`.

const PK = ['pk', 'test', btoa('x.clerk.accounts.dev$')].join('_')
const clerk = (publishable_key: string | null): Discovery => ({
  auth: { provider: 'clerk', issuer: 'https://x.clerk.accounts.dev', cli_client_id: null, publishable_key },
})
const CASES: [string, Discovery | null, 'clerk' | 'better-auth' | null][] = [
  ['clerk with a key', clerk(PK), 'clerk'],
  ['clerk without a key', clerk(null), null],
  [
    'better-auth',
    { auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: 'cli', publishable_key: null } },
    'better-auth',
  ],
  [
    'better-auth with a stray key',
    { auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: null, publishable_key: PK } },
    'better-auth',
  ],
  ['no auth', { auth: null }, null],
  ['no provider', { auth: { provider: '', issuer: '', cli_client_id: null, publishable_key: null } }, null],
  [
    'an unknown provider',
    { auth: { provider: 'okta', issuer: 'https://o.test', cli_client_id: null, publishable_key: PK } },
    null,
  ],
  ['discovery could not be read', null, null],
]

describe('selectSeam', () => {
  it.each(CASES)('%s', async (_n, discovery, expected) => {
    const scripts: string[] = []
    const requests: string[] = []
    const seam = selectSeam(discovery, {
      loadScript: async (src) => void scripts.push(src),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`)
        return new Response('null', { status: 200 })
      }) as typeof fetch,
    })
    if (expected === null) {
      expect(seam).toBeNull()
      return
    }
    expect(seam).not.toBeNull()
    // A signed-out start. On better-auth the only traffic is the same-origin session read.
    if (expected === 'better-auth') {
      await seam!.load()
      expect(seam!.isSignedIn()).toBe(false)
      expect(scripts).toEqual([])
      expect(requests).toEqual(['GET /auth/get-session'])
    }
  })

  it('on clerk the Clerk script is the one loaded (the seam is the Clerk window seam)', async () => {
    const scripts: string[] = []
    ;(window as unknown as { Clerk?: unknown }).Clerk = { load: async () => {}, session: null }
    const seam = selectSeam(clerk(PK), { loadScript: async (src) => void scripts.push(src) })
    await seam!.load()
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('x.clerk.accounts.dev')
    delete (window as unknown as { Clerk?: unknown }).Clerk
  })
})

describe('selectSeam passes the caller’s return paths through (UI460 P2, P3)', () => {
  it('better-auth: Sign in goes to /sign-in?return_to=<returnPath>', async () => {
    const urls: string[] = []
    const seam = selectSeam(
      { auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: null, publishable_key: null } },
      { returnPath: '/home', navigate: (u) => void urls.push(u) },
    )
    await seam!.redirectToSignIn('x')
    expect(urls).toEqual(['/sign-in?return_to=/home'])
  })
  it('clerk: Sign out returns to the signOutReturn it is given', async () => {
    const calls: unknown[] = []
    ;(window as unknown as { Clerk?: unknown }).Clerk = { load: async () => {}, signOut: async (o?: unknown) => void calls.push(o) }
    const seam = selectSeam(clerk(PK), { loadScript: async () => {}, signOutReturn: 'https://w.test/home' })
    await seam!.load()
    await seam!.signOut()
    expect(calls).toEqual([{ redirectUrl: 'https://w.test/home' }])
    delete (window as unknown as { Clerk?: unknown }).Clerk
  })
})
