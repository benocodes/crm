import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// [[API625]] ([[API622]] D5, D6, D7, D9, P1 to P3) in workerd: the REAL Worker module (test/entry-mint.ts, `x-test-real-auth` = compose.ts's own `/auth` branch).
// `pending` is the same Worker on a database with no migrations (the gates' 503).
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const CORS_ONLY = 'https://bearer.example.com' // CORS_ALLOWED_ORIGINS only, exact
const CORS_WILD = 'https://a.b.wc.example.com' // CORS_ALLOWED_ORIGINS only, through the wildcard
const BOTH = 'https://both.example.com' // both lists
const TRUSTED = 'https://app.example.com' // AUTH_TRUSTED_ORIGINS only
const NEITHER = 'https://neither.example.com'
const BINDINGS = {
  AUTH_PROVIDER: 'better-auth',
  PUBLIC_BASE_URL: BASE,
  OPEN_ADMISSION: '1',
  AUTH_TRUSTED_ORIGINS: `${TRUSTED},${BOTH}`,
  CORS_ALLOWED_ORIGINS: `${CORS_ONLY},https://*.wc.example.com,${BOTH}`,
  AUTH_GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
  AUTH_GOOGLE_CLIENT_SECRET: 'gsecret-0123456789',
}

let bundle: Bundle
let w: Workerd
let pending: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({ bundle, bindings: BINDINGS, paired: true })
  pending = await startWorkerd({ bundle, bindings: BINDINGS, migrate: false })
}, 120_000)
afterAll(async () => {
  await w?.dispose()
  await pending?.dispose()
  bundle?.dispose()
})

const real = (inst: Workerd, path: string, init: Parameters<Workerd['call']>[1] = {}) =>
  inst.call(path, { ...init, headers: { 'x-test-real-auth': '1', ...init.headers } })

const REGISTER = '/auth/oauth2/register'
const TOKEN = '/auth/oauth2/token'
const METADATA = '/.well-known/oauth-authorization-server/auth'
const CLIENT = {
  client_name: 'Browser app',
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  redirect_uris: ['https://bearer.example.com/cb'],
  scope: 'openid offline_access contacts:read',
}
const BOGUS_CODE = {
  grant_type: 'authorization_code',
  code: 'nope',
  client_id: 'nope',
  redirect_uri: 'https://bearer.example.com/cb',
  code_verifier: 'x'.repeat(50),
}
const register = (inst: Workerd, origin: string, body: unknown = CLIENT) =>
  real(inst, REGISTER, { body, headers: { origin } })
const token = (inst: Workerd, origin: string) => real(inst, TOKEN, { body: BOGUS_CODE, form: true, headers: { origin } })
const preflight = (inst: Workerd, path: string, origin: string) =>
  real(inst, path, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-anything',
    },
  })

const freeAnswer = (res: Response, origin: string) => {
  expect(res.headers.get('access-control-allow-origin')).toBe(origin) // equals the origin: a duplicate would join as "o, o"
  expect(res.headers.get('vary')).toMatch(/origin/i)
  expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  expect(res.headers.get('set-cookie')).toBeNull()
}

describe('API625 group 1: the credential-free preflight (D6, P3)', () => {
  it.each([
    ['register', REGISTER, CORS_ONLY],
    ['register', REGISTER, CORS_WILD],
    ['token', TOKEN, CORS_ONLY],
    ['token', TOKEN, CORS_WILD],
  ])('%s from %s: 204, the four headers exactly, and the same with migrations pending', async (_n, path, origin) => {
    for (const inst of [w, pending]) {
      const res = await preflight(inst, path, origin)
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
      expect(res.headers.get('access-control-allow-methods')).toBe('POST')
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type') // P3: fixed, not the requested list
      expect(res.headers.get('vary')).toBe('Origin')
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })
})

describe('API625 group 2: real answers carry the origin, no credentials (D6, D9)', () => {
  it('register (public client, no cookie) succeeds from a CORS-only origin with the origin and Vary', async () => {
    const res = await register(w, CORS_ONLY)
    expect(res.status, await res.clone().text()).toBe(201)
    freeAnswer(res, CORS_ONLY)
    const wild = await register(w, CORS_WILD)
    expect(wild.status, await wild.clone().text()).toBe(201)
    freeAnswer(wild, CORS_WILD)
  })

  it("token with a bogus code answers the plugin's error with the same headers", async () => {
    const res = await token(w, CORS_ONLY)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(((await res.json()) as { error?: string }).error).toBeTruthy()
    freeAnswer(res, CORS_ONLY)
  })

  it("the plugin's Access-Control-Expose-Headers (if any) survives: the same as the no-origin answer", async () => {
    for (const [path, body, form] of [
      [REGISTER, CLIENT, false],
      [TOKEN, BOGUS_CODE, true],
    ] as const) {
      const base = await real(w, path, { body, form, headers: { origin: '' } })
      const withOrigin = await real(w, path, { body, form, headers: { origin: CORS_ONLY } })
      expect(withOrigin.headers.get('access-control-expose-headers')).toBe(
        base.headers.get('access-control-expose-headers'),
      )
    }
  })

  it('the gates refuse with 503 migrations_pending carrying the origin on both paths', async () => {
    for (const res of [await register(pending, CORS_ONLY), await token(pending, CORS_ONLY)]) {
      expect(res.status).toBe(503)
      freeAnswer(res, CORS_ONLY)
    }
  })
})

// The matrix: path x origin class. `free` = credential-free, `cred` = UI255 D7's credentialed answer, `star` = the plugin's `*`, `none` = no CORS header.
type Kind = 'free' | 'cred' | 'star' | 'none'
const COLUMNS: [string, string][] = [
  ['cors-only exact', CORS_ONLY],
  ['cors-only wildcard', CORS_WILD],
  ['both lists', BOTH],
  ['trusted only', TRUSTED],
  ['neither', NEITHER],
  ['no Origin', ''],
]
const OAUTH_ROW: Kind[] = ['free', 'free', 'cred', 'cred', 'none', 'none']
const CRED_ROW: Kind[] = ['none', 'none', 'cred', 'cred', 'none', 'none']
const ROWS: { name: string; path: string; method: 'GET' | 'POST'; kinds: Kind[]; preflight: boolean }[] = [
  { name: 'register', path: REGISTER, method: 'POST', kinds: OAUTH_ROW, preflight: true },
  { name: 'token', path: TOKEN, method: 'POST', kinds: OAUTH_ROW, preflight: true },
  { name: 'token trailing slash', path: `${TOKEN}/`, method: 'POST', kinds: CRED_ROW, preflight: true },
  { name: 'token sub-path', path: `${TOKEN}/x`, method: 'POST', kinds: CRED_ROW, preflight: true },
  { name: 'register trailing slash', path: `${REGISTER}/`, method: 'POST', kinds: CRED_ROW, preflight: true },
  { name: 'revoke', path: '/auth/oauth2/revoke', method: 'POST', kinds: CRED_ROW, preflight: true },
  { name: 'authorize', path: '/auth/oauth2/authorize', method: 'GET', kinds: CRED_ROW, preflight: true },
  { name: 'userinfo', path: '/auth/oauth2/userinfo', method: 'GET', kinds: CRED_ROW, preflight: true },
  { name: '/auth/token', path: '/auth/token', method: 'GET', kinds: CRED_ROW, preflight: true },
  { name: 'get-session', path: '/auth/get-session', method: 'GET', kinds: CRED_ROW, preflight: true },
  { name: 'metadata document', path: METADATA, method: 'GET', kinds: Array(6).fill('star'), preflight: false },
]

const expectKind = (res: Response, kind: Kind, origin: string, ctx: string) => {
  const acao = res.headers.get('access-control-allow-origin')
  const creds = res.headers.get('access-control-allow-credentials')
  if (kind === 'free') {
    expect(acao, ctx).toBe(origin)
    expect(creds, ctx).toBeNull()
  } else if (kind === 'cred') {
    expect(acao, ctx).toBe(origin)
    expect(creds, ctx).toBe('true')
  } else if (kind === 'star') {
    expect(acao, ctx).toBe('*')
    expect(creds, ctx).toBeNull()
  } else {
    expect(acao, ctx).toBeNull()
    expect(creds, ctx).toBeNull()
  }
}

describe('API625 group 3: narrowness and precedence (D5, D7, P1, P2) and group 4: never credentials (D6)', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      COLUMNS.forEach(([col, origin], i) => {
        const kind = row.kinds[i]!
        it(`real answer from ${col}: ${kind}`, async () => {
          const res = await real(w, row.path, {
            method: row.method,
            body: row.method === 'POST' ? {} : undefined,
            headers: { origin },
          })
          expectKind(res, kind, origin, `${row.name} / ${col}`)
          if (kind === 'free') {
            expect(res.headers.get('vary')).toMatch(/origin/i)
            expect(res.headers.get('set-cookie')).toBeNull()
          }
        })
        if (row.preflight && origin !== '') {
          it(`preflight from ${col}: ${kind}`, async () => {
            const res = await preflight(w, row.path, origin)
            expectKind(res, kind, origin, `${row.name} preflight / ${col}`)
            if (kind === 'free') {
              expect(res.status).toBe(204)
              expect(res.headers.get('access-control-allow-methods')).toBe('POST')
            }
            if (kind === 'cred') expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST')
          })
        }
      })
    })
  }

  it("P2: with no Origin, an unmatched origin, or both-lists origin the register answer's headers are today's (no Vary: Origin added for the first two)", async () => {
    for (const origin of ['', NEITHER]) {
      const res = await register(w, origin)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('vary') ?? '').not.toMatch(/origin/i)
    }
  })
})
