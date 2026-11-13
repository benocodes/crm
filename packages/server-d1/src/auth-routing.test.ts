import { fileURLToPath } from 'node:url'
import { BASE, SECRET, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clerkKit } from './test/kit.js'

const ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url))
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }
const PASSWORD = 'a long enough password 123'

// [[CORE243]] D1, D2, P1 in workerd, through the REAL Worker bundle (src/worker.ts) with `nodejs_compat`: Better Auth answers at /auth only for AUTH_PROVIDER=better-auth;
// clerk and unset give 404 not_found in the app's envelope; the shipped composition admits nobody.
let bundle: Bundle
const started: Workerd[] = []
const start = async (bindings: Record<string, string>, opts: { control?: boolean; paired?: boolean } = {}) => {
  // [[CORE259]] D7: the real Worker on better-auth serves only a paired control plane, so the harness pairs the two databases (as bootstrap does) unless a test says otherwise.
  const w = await startWorkerd({ bundle, bindings, paired: opts.paired ?? true, control: opts.control })
  started.push(w)
  return w
}
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
}, 120_000)
afterAll(async () => {
  for (const w of started) await w.dispose()
  bundle?.dispose()
})

const BETTER = { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE }

describe('/auth by provider (D1)', () => {
  it('better-auth: Better Auth answers under /auth (its own /ok and an anonymous session), not the app', async () => {
    const w = await start(BETTER)
    const ok = await w.call('/auth/ok')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
    const session = await w.call('/auth/get-session')
    expect(session.status).toBe(200)
    expect(await session.json()).toBeNull()
    expect((await w.call('/health')).status).toBe(200)
  })

  it('unset and empty AUTH_PROVIDER: /auth/* is 404 not_found in the app envelope', async () => {
    for (const bindings of [{ AUTH_PROVIDER: '' }, {}] as Array<Record<string, string>>) {
      const w = await start(bindings)
      for (const path of ['/auth/ok', '/auth/get-session', '/auth', '/auth/sign-up/email']) {
        const res = await w.call(path)
        expect(res.status, path).toBe(404)
        expect(await res.json(), path).toEqual(NOT_FOUND)
      }
    }
  })

  it('clerk: /auth/* is 404 not_found even with a secret set, and the Clerk-configured Worker still serves /health', async () => {
    const kit = await clerkKit()
    const w = await start({ ...(kit.env as Record<string, string>), AUTH_SECRET: SECRET })
    for (const path of ['/auth/ok', '/auth/get-session']) {
      const res = await w.call(path)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toEqual(NOT_FOUND)
    }
    expect((await w.call('/health')).status).toBe(200)
  })

  it('a non-/auth path that merely starts with the letters is not captured', async () => {
    const w = await start(BETTER)
    expect((await w.call('/authority')).status).not.toBe(200)
    expect(await (await w.call('/authority')).text()).not.toContain('"ok":true')
  })
})

describe('the shipped composition admits nobody (P1)', () => {
  it('refuses sign-up and dynamic client registration, and writes no auth row', async () => {
    const w = await start(BETTER)
    const up = await w.call('/auth/sign-up/email', { body: { name: 'Nobody', email: 'nobody@auth.test', password: PASSWORD } })
    expect(up.status).toBeGreaterThanOrEqual(400)
    expect(up.status).toBeLessThan(500)
    const reg = await w.call('/auth/oauth2/register', {
      body: { client_name: 'Nobody', token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'openid', redirect_uris: ['https://client.test/callback'] },
    })
    expect(reg.status).toBeGreaterThanOrEqual(400)
    expect(reg.status).toBeLessThan(500)
    for (const t of ['auth_users', 'auth_accounts', 'auth_sessions', 'auth_oauth_clients']) {
      expect(await w.controlRows(`select * from ${t}`), t).toEqual([])
      expect(await w.rows(`select * from ${t}`), t).toEqual([])
    }
  })
})

// [[CORE259]] D3, D8: Better Auth is composed on CONTROL_DB. A request that makes it read and write rows (the signing key, created on first use, and the rate limiter's counters; sign-up
// is still refused, P1) lands them in the control database and leaves every CRM auth_* table empty.
describe('Better Auth uses the control database, never the CRM one (D3)', () => {
  const AUTH_TABLES_IN_CRM = ['auth_users', 'auth_sessions', 'auth_accounts', 'auth_verifications', 'auth_jwks', 'auth_oauth_clients', 'auth_oauth_resources', 'auth_oauth_client_resources', 'auth_oauth_refresh_tokens', 'auth_oauth_access_tokens', 'auth_oauth_consents', 'auth_oauth_client_assertions', 'auth_device_codes', 'auth_rate_limits']

  it('/auth/jwks writes the signing key into CONTROL_DB and no CRM auth_* table gains a row', async () => {
    const w = await start(BETTER)
    const res = await w.call('/auth/jwks')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0)
    expect((await w.controlRows<{ id: string }>('select id from auth_jwks')).length).toBeGreaterThan(0)
    for (const t of AUTH_TABLES_IN_CRM) expect(await w.rows(`select * from ${t}`), `CRM ${t}`).toEqual([])
  })

  it('the Worker with no CONTROL_DB binding refuses (500, the log names CONTROL_DB) and /health stays 200', async () => {
    const w = await start(BETTER, { control: false, paired: false })
    for (const path of ['/auth/ok', '/api/v1/contacts']) expect((await w.call(path)).status, path).toBe(500)
    expect((await w.call('/health')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 200))
    expect(w.logs.join('\n')).toContain('CONTROL_DB')
  })
})

describe('configuration in workerd', () => {
  it('a short AUTH_SECRET is 500 internal on a non-health request, /health stays 200, and the runtime log names the variable and not its value', async () => {
    const short = 'too-short-secret'
    const w = await start({ ...BETTER, AUTH_SECRET: short })
    const res = await w.call('/api/v1/contacts')
    expect(res.status).toBe(500)
    expect((await w.call('/auth/ok')).status).toBe(500)
    expect((await w.call('/health')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 200))
    const text = w.logs.join('\n')
    expect(text).toContain('AUTH_SECRET')
    expect(text).not.toContain(short)
  })

  it('a valid configuration makes no outbound request (the harness fails any)', async () => {
    const w = await start(BETTER)
    await w.call('/auth/ok')
    await w.call('/auth/get-session')
    expect(w.logs.filter((l) => /outbound request/.test(l))).toEqual([])
  })
})
