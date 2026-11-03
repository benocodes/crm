// A fake Clerk for `setup:remote --auth clerk` tests ([[OPS65]] Tests): Backend API (`api.clerk.com/v1`), the Frontend API and the issuer's
// metadata on one host. Shapes follow `clerk/openapi-specs` `bapi/2026-08-20.yml` (checked 2026-11-03). Any method+path outside the
// desired-state table (D25) is recorded in `violations` and answered 599: a stray request turns the owning test red (D33).
import { generateKeyPairSync } from 'node:crypto'

const b64 = (s: string) => Buffer.from(s).toString('base64')
export const ISSUER_HOST = 'acme-test-12.clerk.accounts.dev'
export const ISSUER = `https://${ISSUER_HOST}`
/** Canary values: they stand for the contents of `.env.<env>` and must never reach an argv, a log line, the config or the process environment. */
// Assembled so a secret scanner does not mistake the canaries for real keys.
export const SK_TEST = ['sk', 'test', 'CANARYsecretKEY0123456789abcdefgh'].join('_')
export const PK_TEST = `pk_test_${b64(`${ISSUER_HOST}$`)}`
export const SK_LIVE_SENTINEL = ['sk', 'live', 'SENTINELfromPROCESSenv0123456789'].join('_')
export const OWNER_EMAIL = 'Owner+clerk_test@Example.com'

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string }
export const jwkFor = (kid: string) => ({ kty: rsa.kty, kid, use: 'sig', alg: 'RS256', n: rsa.n, e: rsa.e })

export interface ClerkApp {
  object: 'oauth_application'
  id: string
  name: string
  client_id: string
  public: boolean
  device_authorization_grant_enabled: boolean
  consent_screen_enabled: boolean
  scopes: string
  client_secret?: string
}
export interface ClerkUser {
  id: string
  object: 'user'
  email_addresses: { email_address: string }[]
  public_metadata: Record<string, unknown>
}
export interface ClerkInvitation {
  object: 'invitation'
  id: string
  email_address: string
  public_metadata: Record<string, unknown>
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  url: string
}

export interface ClerkOptions {
  signUpMode?: 'public' | 'restricted' | 'waitlist'
  /** The Frontend API environment read is refused with this status (a development instance wanting a dev-browser token). */
  fapiEnvironmentStatus?: number
  organizations?: boolean | 402 | 404
  allowedOrigins?: string[]
  settings?: Partial<ClerkState['settings']>
  apps?: Partial<ClerkApp>[]
  users?: ClerkUser[]
  invitations?: ClerkInvitation[]
  /** The custom scope keys the catalog holds; `'all'` accepts any. */
  catalog?: 'all' | string[]
  /** Clerk refuses `device_authorization_grant_enabled: true`. */
  deviceGrantRefused?: boolean
  /** `kid`s of the Backend API's JWKS and of the issuer's. */
  bapiKids?: string[]
  issuerKids?: string[]
  /** The AS metadata's `scopes_supported`; `null`: the document is not served. */
  scopesSupported?: string[] | null
  /** The issuer's metadata cannot be fetched at all (a production domain whose DNS is missing). */
  issuerDown?: boolean
}
export interface ClerkState {
  signUpMode: string
  allowedOrigins: string[]
  settings: { dynamic_oauth_client_registration: boolean; dynamic_client_allowed_scopes: string[]; default_scopes: string[]; oauth_jwt_access_tokens: boolean; aud_claim_enabled: boolean; pkce_required: boolean }
  apps: ClerkApp[]
  users: ClerkUser[]
  invitations: ClerkInvitation[]
  scopesSupported: string[] | null
}
export interface ClerkRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}
export interface FakeClerk {
  state: ClerkState
  requests: ClerkRequest[]
  violations: string[]
  /** Non-`GET` requests: every one is a Clerk write. */
  writes(): ClerkRequest[]
  handles(url: string): boolean
  handle(url: string, init?: RequestInit): Response
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const clerkError = (status: number, code: string, message: string, param?: string) => reply(status, { errors: [{ code, message, long_message: message, meta: param ? { param_name: param } : {} }] })

export function makeClerk(o: ClerkOptions = {}): FakeClerk {
  const state: ClerkState = {
    signUpMode: o.signUpMode ?? 'restricted',
    allowedOrigins: [...(o.allowedOrigins ?? [])],
    settings: { dynamic_oauth_client_registration: false, dynamic_client_allowed_scopes: [], default_scopes: [], oauth_jwt_access_tokens: false, aud_claim_enabled: false, pkce_required: true, ...o.settings },
    apps: (o.apps ?? []).map((a, i) => ({ object: 'oauth_application', id: `oauthapp_${i + 1}`, name: 'Vibase CLI', client_id: `client_${i + 1}`, public: true, device_authorization_grant_enabled: true, consent_screen_enabled: true, scopes: '', ...a })),
    users: [...(o.users ?? [])],
    invitations: [...(o.invitations ?? [])],
    scopesSupported: o.scopesSupported === undefined ? [] : o.scopesSupported,
  }
  const requests: ClerkRequest[] = []
  const violations: string[] = []
  const bapiKids = o.bapiKids ?? ['ins_kid_1']
  const issuerKids = o.issuerKids ?? bapiKids
  let seq = 0

  const customKeysUnknown = (scopes: string) => {
    if (o.catalog === undefined || o.catalog === 'all') return false
    return scopes.split(' ').filter(Boolean).some((s) => s.includes(':') && !(o.catalog as string[]).includes(s))
  }
  const appWrite = (body: Record<string, unknown>): Response | null => {
    if (typeof body.scopes === 'string' && customKeysUnknown(body.scopes)) return clerkError(422, 'form_param_value_invalid', 'scopes: custom scope keys must exist in the instance OAuth scope catalog', 'scopes')
    if (body.device_authorization_grant_enabled === true && o.deviceGrantRefused) return clerkError(422, 'form_param_value_invalid', 'device_authorization_grant_enabled requires the new OAuth IdP and a reachable device verification page', 'device_authorization_grant_enabled')
    return null
  }
  const withoutSecret = ({ client_secret: _s, ...rest }: ClerkApp) => rest

  function handle(url: string, init: RequestInit = {}): Response {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const path = u.pathname
    requests.push({ method, path: path + u.search, headers, body })
    const m = `${method} ${path}`
    const stray = (): Response => {
      violations.push(`${method} ${u.host}${path}`)
      return reply(599, { stray: true })
    }

    if (u.host === ISSUER_HOST) {
      if (o.issuerDown) return reply(522, {})
      if (m === 'GET /.well-known/openid-configuration') return reply(200, { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` })
      if (m === 'GET /.well-known/jwks.json') return reply(200, { keys: issuerKids.map(jwkFor) })
      if (m === 'GET /.well-known/oauth-authorization-server') return state.scopesSupported === null ? reply(404, {}) : reply(200, { issuer: ISSUER, scopes_supported: state.scopesSupported })
      if (m === 'GET /v1/environment') return o.fapiEnvironmentStatus ? reply(o.fapiEnvironmentStatus, { errors: [{ code: 'dev_browser_missing' }] }) : reply(200, { user_settings: { sign_up: { mode: state.signUpMode } } })
      return stray()
    }
    if (u.host !== 'api.clerk.com') return stray()
    if (headers.authorization !== `Bearer ${SK_TEST}`) {
      violations.push(`bad credentials on ${m}`)
      return reply(401, { errors: [{ code: 'authentication_invalid' }] })
    }
    if (m === 'GET /v1/jwks') return reply(200, { keys: bapiKids.map(jwkFor) })
    if (m === 'GET /v1/instance/organization_settings') {
      if (o.organizations === 402 || o.organizations === 404) return reply(o.organizations, { errors: [{ code: 'feature_not_enabled' }] })
      return reply(200, { object: 'organization_settings', enabled: o.organizations === true })
    }
    if (m === 'GET /v1/instance') return reply(200, { object: 'instance', id: 'ins_1', environment_type: 'development', allowed_origins: state.allowedOrigins })
    if (m === 'PATCH /v1/instance') {
      if (Array.isArray(body?.allowed_origins)) state.allowedOrigins = body!.allowed_origins as string[]
      return new Response(null, { status: 204 })
    }
    if (m === 'GET /v1/instance/oauth_application_settings') return reply(200, { object: 'oauth_application_settings', ...state.settings })
    if (m === 'PATCH /v1/instance/oauth_application_settings') {
      Object.assign(state.settings, body)
      return reply(200, { object: 'oauth_application_settings', ...state.settings })
    }
    if (m === 'GET /v1/oauth_applications') {
      const limit = Number(u.searchParams.get('limit') ?? 10)
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const nameQuery = u.searchParams.get('name_query')
      const all = state.apps.filter((a) => nameQuery === null || a.name.toLowerCase().includes(nameQuery.toLowerCase()))
      return reply(200, { data: all.slice(offset, offset + limit).map(withoutSecret), total_count: all.length })
    }
    if (m === 'POST /v1/oauth_applications') {
      const refused = appWrite(body ?? {})
      if (refused) return refused
      const n = ++seq
      const app: ClerkApp = { object: 'oauth_application', id: `oauthapp_new${n}`, name: String(body?.name), client_id: `client_new${n}`, public: body?.public === true, device_authorization_grant_enabled: body?.device_authorization_grant_enabled === true, consent_screen_enabled: body?.consent_screen_enabled === true, scopes: String(body?.scopes ?? ''), client_secret: 'client-secret-canary' }
      state.apps.push(app)
      return reply(200, app)
    }
    const patchApp = /^PATCH \/v1\/oauth_applications\/([^/]+)$/.exec(m)
    if (patchApp) {
      const app = state.apps.find((a) => a.id === patchApp[1])
      if (!app) return reply(404, { errors: [{ code: 'resource_not_found' }] })
      const refused = appWrite(body ?? {})
      if (refused) return refused
      Object.assign(app, body)
      return reply(200, withoutSecret(app))
    }
    if (m === 'GET /v1/users') {
      const email = (u.searchParams.get('email_address') ?? '').toLowerCase()
      return reply(200, state.users.filter((x) => x.email_addresses.some((e) => e.email_address.toLowerCase() === email)))
    }
    const meta = /^PATCH \/v1\/users\/([^/]+)\/metadata$/.exec(m)
    if (meta) {
      const user = state.users.find((x) => x.id === meta[1])
      if (!user) return reply(404, { errors: [{ code: 'resource_not_found' }] })
      Object.assign(user.public_metadata, (body?.public_metadata as Record<string, unknown>) ?? {})
      return reply(200, user)
    }
    if (m === 'GET /v1/invitations') {
      const q = (u.searchParams.get('query') ?? '').toLowerCase()
      const status = u.searchParams.get('status')
      return reply(200, state.invitations.filter((i) => (status === null || i.status === status) && i.email_address.toLowerCase().includes(q)))
    }
    if (m === 'POST /v1/invitations') {
      const inv: ClerkInvitation = { object: 'invitation', id: `inv_new${++seq}`, email_address: String(body?.email_address), public_metadata: (body?.public_metadata as Record<string, unknown>) ?? {}, status: 'pending', url: 'https://accounts.example.dev/sign-up?__clerk_ticket=INVITATION-URL-CANARY' }
      state.invitations.push(inv)
      return reply(200, inv)
    }
    return stray()
  }

  return {
    state,
    requests,
    violations,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    handles: (url) => {
      const h = new URL(url).host
      return h === ISSUER_HOST || h === 'api.clerk.com'
    },
    handle,
  }
}
