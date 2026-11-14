// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createPage } from './controller.js'
import { createApi } from './api.js'
import { selectSeam } from './seam.js'
import type { Discovery } from './types.js'

// [[UI297]] D7: which seam the page builds from the discovery document, and what the page does with it. No Clerk script on `better-auth`.

const PK = ['pk', 'test', btoa('x.clerk.accounts.dev$')].join('_')
const clerk = (publishable_key: string | null): Discovery => ({ auth: { provider: 'clerk', issuer: 'https://x.clerk.accounts.dev', cli_client_id: null, publishable_key } })
const CASES: [string, Discovery | null, 'clerk' | 'better-auth' | null][] = [
  ['clerk with a key', clerk(PK), 'clerk'],
  ['clerk without a key', clerk(null), null],
  ['better-auth', { auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: 'cli', publishable_key: null } }, 'better-auth'],
  ['better-auth with a stray key', { auth: { provider: 'better-auth', issuer: 'https://w.test/auth', cli_client_id: null, publishable_key: PK } }, 'better-auth'],
  ['no auth', { auth: null }, null],
  ['no provider', { auth: { provider: '', issuer: '', cli_client_id: null, publishable_key: null } }, null],
  ['an unknown provider', { auth: { provider: 'okta', issuer: 'https://o.test', cli_client_id: null, publishable_key: PK } }, null],
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
    // The page over this seam: a signed-out start. On better-auth the only traffic is the same-origin session read.
    const page = createPage({ clerk: seam, api: createApi({ origin: 'https://w.test', getToken: async () => null, fetch: async () => new Response('{}') }), origin: 'https://w.test' })
    if (expected === 'better-auth') {
      await page.start()
      expect(page.state().kind).toBe('signed-out')
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
