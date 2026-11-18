import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI460]] P4: `/connect` is served with `appCsp(issuer)` (the old `connectCsp` is gone), so the pins below are APP_CSP's, with `'unsafe-inline'` in style-src. [[UI297]] D7 (CSP): the policy `/connect` is served under, per provider, through the COMPOSED Worker (an `appCsp` unit test cannot see which issuer the composition hands it).
let w: WorkerPair
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerPair()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const ASSETS = {
  fetch: async () =>
    new Response('<!doctype html><title>connect</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
}
const SELF_ONLY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
const clerkCsp = (i: string) =>
  `default-src 'self'; script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${i} https://*.protect.clerk.com:*; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
const policy = async (env: D1WorkerEnv, fetcher?: typeof fetch): Promise<string> => {
  const res = await composeD1Worker({ ...env, ASSETS }, fetcher ? { fetch: fetcher } : undefined).fetch(
    new Request(`${AUTH_BASE}/connect`),
  )
  expect(res.status).toBe(200)
  return res.headers.get('content-security-policy')!
}

describe('/connect CSP per provider (composed Worker)', () => {
  it('better-auth: the no-issuer APP_CSP: no Clerk host, no challenge host, no /auth path', async () => {
    const csp = await policy({
      DB: w.d1,
      CONTROL_DB: w.control,
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
    })
    expect(csp).toBe(SELF_ONLY)
    expect(csp).not.toMatch(/clerk|challenges\.cloudflare\.com|\/auth|vibase\.test/)
  })
  it('clerk: APP_CSP with the issuer origin and the Clerk hosts (P4)', async () => {
    const csp = await policy(
      { DB: w.d1, CONTROL_DB: w.control, ...kit.env, CLERK_WEBHOOK_SECRET: undefined },
      kit.fetch,
    )
    expect(csp).toBe(clerkCsp(new URL(kit.issuer.issuer).origin))
  })
  it('no provider: APP_CSP (P4)', async () => {
    expect(await policy({ DB: w.d1, CONTROL_DB: w.control })).toBe(SELF_ONLY)
  })
})
