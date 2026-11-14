import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI297]] D7 (CSP): the policy `/connect` is served under, per provider, through the COMPOSED Worker (a `connectCsp` unit test cannot see which issuer the composition hands it).
let w: WorkerPair
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerPair()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const ASSETS = { fetch: async () => new Response('<!doctype html><title>connect</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) }
const SELF_ONLY = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
const clerkCsp = (i: string) =>
  `default-src 'self'; script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com; connect-src 'self' ${i} https://*.protect.clerk.com:*; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
const policy = async (env: D1WorkerEnv, fetcher?: typeof fetch): Promise<string> => {
  const res = await composeD1Worker({ ...env, ASSETS }, fetcher ? { fetch: fetcher } : undefined).fetch(new Request(`${AUTH_BASE}/connect`))
  expect(res.status).toBe(200)
  return res.headers.get('content-security-policy')!
}

describe('/connect CSP per provider (composed Worker)', () => {
  it('better-auth: the no-issuer, self-only policy: no Clerk host, no challenge host, no /auth path', async () => {
    const csp = await policy({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE })
    expect(csp).toBe(SELF_ONLY)
    expect(csp).not.toMatch(/clerk|challenges\.cloudflare\.com|\/auth|vibase\.test/)
  })
  it('clerk: the UI30 D9 policy with the issuer origin, unchanged', async () => {
    const csp = await policy({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined }, kit.fetch)
    expect(csp).toBe(clerkCsp(new URL(kit.issuer.issuer).origin))
  })
  it('no provider: the self-only policy, unchanged', async () => {
    expect(await policy({ DB: w.d1 })).toBe(SELF_ONLY)
  })
})
