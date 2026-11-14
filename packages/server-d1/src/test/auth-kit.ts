// Test support ([[CORE244]]): the REAL Better Auth composition (open admission, the test switch) on a control-plane database in Node, minting the tokens the Worker under test then verifies.
// `test/` is exempt from the control-boundary check; production code never gets a handle like this.
import { createAuthHandler } from '@vibase/auth'
import type { D1Like } from '@vibase/storage-d1'

export const AUTH_BASE = 'https://vibase.test'
export const AUTH_SECRET = 'test-auth-secret-0123456789-abcdefghij-klmnop'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export interface AuthKit {
  call(path: string, init?: { body?: unknown; form?: boolean; cookie?: string; method?: string }): Promise<Response>
  /** A Better Auth account and its browser session cookie. */
  signUp(email: string, name?: string): Promise<{ userId: string; cookie: string }>
  /** The 15-minute session JWT of a cookie (`/auth/token`). */
  sessionJwt(cookie: string): Promise<string>
  /** A public client with the device grant (open DCR, test admission only); its client id. */
  registerClient(name: string): Promise<string>
  /** The device grant end to end for a signed-in cookie: the token endpoint's whole answer (`access_token`, `id_token` with `openid`, ...). */
  deviceTokens(cookie: string, clientId: string, scope: string): Promise<{ access_token: string; id_token?: string; refresh_token?: string; expires_in: number }>
}

/** The real Better Auth composition (test admission) on a control-plane database, in this process. */
export function authKit(control: D1Like, over: { base?: string; secret?: string; scopes?: readonly string[] } = {}): AuthKit {
  const base = over.base ?? AUTH_BASE
  const handler = createAuthHandler(control, { secret: over.secret ?? AUTH_SECRET, baseURL: base, vaultScopes: over.scopes ?? [] }, { unsafeOpenAdmissionForTests: true })
  let n = 0
  return authKitOver(
    (path, init = {}) =>
      handler(
        new Request(base + path, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: { origin: base, 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`, ...(init.body === undefined ? {} : { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}) },
          body: init.body === undefined ? undefined : init.form ? new URLSearchParams(init.body as Record<string, string>).toString() : JSON.stringify(init.body),
        }),
      ),
    base,
    over.scopes ?? [],
  )
}

/** The same flows over any transport that reaches `/auth/*` with test admission: a Worker in workerd, for instance. */
export function authKitOver(call: AuthKit['call'], base: string, vaultScopes: readonly string[]): AuthKit {
  const ok = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.clone().text()}`)
    return res
  }
  return {
    call,
    async signUp(email, name = 'Test User') {
      const res = await ok(await call('/auth/sign-up/email', { body: { name, email, password: 'a long enough password 123' } }), 'sign-up')
      const cookie = res.headers.get('set-cookie')!.split(';')[0]!
      const body = (await res.json()) as { user: { id: string } }
      return { userId: body.user.id, cookie }
    },
    async sessionJwt(cookie) {
      const res = await ok(await call('/auth/token', { cookie }), 'token')
      return ((await res.json()) as { token: string }).token
    },
    async registerClient(name) {
      const res = await ok(
        await call('/auth/oauth2/register', {
          body: { client_name: name, token_endpoint_auth_method: 'none', resources: [base], grant_types: ['authorization_code', DEVICE_GRANT, 'refresh_token'], response_types: ['code'], scope: ['openid', 'offline_access', ...vaultScopes].join(' '), redirect_uris: ['https://client.test/callback'] },
        }),
        'register',
      )
      return ((await res.json()) as { client_id: string }).client_id
    },
    async deviceTokens(cookie, clientId, scope) {
      const codes = (await (await ok(await call('/auth/device/code', { body: { client_id: clientId, scope, resource: base } }), 'device code')).json()) as { device_code: string; user_code: string }
      await ok(await call(`/auth/device?user_code=${encodeURIComponent(codes.user_code)}`, { cookie }), 'device verify')
      await ok(await call('/auth/device/approve', { cookie, body: { userCode: codes.user_code } }), 'device approve')
      const res = await ok(await call('/auth/oauth2/token', { form: true, body: { grant_type: DEVICE_GRANT, device_code: codes.device_code, client_id: clientId, resource: base } }), 'device token')
      return (await res.json()) as never
    },
  }
}

/**
 * Gives a registered client another client id, as the seeded `vibase-cli` row will have ([[CORE283]] seeds it for real). Two statements in one batch with deferred foreign keys: the client row
 * and the row that links it to the API resource.
 */
export async function renameClient(control: D1Like, from: string, to: string): Promise<void> {
  const now = new Date().toISOString()
  await control.batch([
    control.prepare('pragma defer_foreign_keys = on'),
    control.prepare('update auth_oauth_clients set client_id = ?, updated_at = ? where client_id = ?').bind(to, now, from),
    control.prepare('update auth_oauth_client_resources set client_id = ? where client_id = ?').bind(to, from),
  ])
}
