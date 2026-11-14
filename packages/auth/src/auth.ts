// The Better Auth composition for the D1 Worker ([[CORE243]] D1, D3, D4, D13, D21). Better Auth is the vault's built-in sign-in and OAuth authorisation server; this module
// only configures it: the plugins (`jwt`, `oauthProvider`, `oauthDeviceAuthorization`, nothing else), the vault's table and column names, UUIDv7 ids, the PBKDF2 hasher, and a
// fail-closed admission policy while the vault has no invitations ([[CORE245]]) and no client-registration policy ([[CORE244]]).
import { oauthDeviceAuthorization, oauthProvider, oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { getAuthTables } from 'better-auth/db'
import { jwt } from 'better-auth/plugins'
import { D1Dialect } from 'kysely-d1'
import { uuidv7 } from '@vibase/storage'
import { hashPassword, verifyPassword } from './password.js'

/** What the composition needs beyond the database: both are validated by the Worker's composition before they reach here ([[CORE243]] D6, P2). */
export interface AuthRuntimeConfig {
  /** `AUTH_SECRET`: at least 32 characters. Better Auth signs cookies with it and encrypts the private signing key with it. */
  secret: string
  /** `PUBLIC_BASE_URL`, an origin without a path. It is the one base URL, whatever host a request arrives on (D23): the issuer is `<baseURL>/auth`. */
  baseURL: string
  /** The vault's scope names (`contacts:read`, ...): joined to the OIDC scopes the provider knows, so an access token can carry them ([[CORE244]] D9). The composition passes the registry's declared scopes. */
  vaultScopes?: readonly string[]
  /** The subset of `vaultScopes` an agent may be granted ([[CORE243]] D11, P6): the only vault scopes a dynamically registered client may hold. Default none (OIDC scopes only). */
  grantableScopes?: readonly string[]
}

/** The resources the provider issues access tokens for ([[CORE283]] P1): the API origin and the MCP endpoint's canonical URI (RFC 8707). Both name this one Worker. */
export const MCP_RESOURCE_PATH = '/mcp'
export const resourcesFor = (baseURL: string): [string, string] => [baseURL, `${baseURL}${MCP_RESOURCE_PATH}`]
/** Registration policy ([[CORE283]] P6): this many registrations per client IP per window. */
export const REGISTRATION_LIMIT = { window: 60 * 60, max: 10 } as const
/** RFC 8414 path insertion for the issuer `<base>/auth` ([[CORE283]] D12): the document Better Auth builds, served where the standard says it is. */
export const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server/auth'

/** A D1 binding, as much of it as Kysely's D1 dialect uses; the Worker passes its `DB`. */
export interface AuthDatabaseLike {
  prepare(query: string): unknown
}

export interface CreateAuthOptions {
  /**
   * TEST ONLY. Admits email sign-up. The shipped composition never passes it: until the invitation gate ([[CORE245]]) exists, `/auth` refuses every account creation ([[CORE243]] P1).
   * Dynamic client registration is open under the policy of [[CORE283]] P6 whatever this says.
   */
  unsafeOpenAdmissionForTests?: boolean
  /** Ids of every auth row; UUIDv7 by default, like the vault's. */
  generateId?: () => string
}

/** Better Auth's model keys and the vault's table names for them ([[CORE243]] D4): `auth_` prefixed, plural, snake_case. */
const MODELS = {
  user: 'auth_users',
  session: 'auth_sessions',
  account: 'auth_accounts',
  verification: 'auth_verifications',
  jwks: 'auth_jwks',
  oauthClient: 'auth_oauth_clients',
  oauthResource: 'auth_oauth_resources',
  oauthClientResource: 'auth_oauth_client_resources',
  oauthRefreshToken: 'auth_oauth_refresh_tokens',
  oauthAccessToken: 'auth_oauth_access_tokens',
  oauthConsent: 'auth_oauth_consents',
  oauthClientAssertion: 'auth_oauth_client_assertions',
  deviceCode: 'auth_device_codes',
  rateLimit: 'auth_rate_limits',
} as const
type ModelKey = keyof typeof MODELS

/** Every table Better Auth owns here. Machinery ([[CORE243]] D5): not resources, absent from schema discovery and from every operation. */
export const AUTH_TABLES: readonly string[] = Object.values(MODELS)

/** The OIDC scopes this cycle's clients may ask for. The vault's resource scopes join them with token verification ([[CORE244]]). */
export const AUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

/** The claim that marks a session JWT ([[CORE244]] D8): an OAuth access token cannot carry it (the provider fixes the access-token claims), and the API refuses a JWT without it that is not an access token. */
export const SESSION_TOKEN_CLAIM = 'vibase_token'
export const SESSION_TOKEN_VALUE = 'session'
/** Lifetimes ([[CORE244]] D19), in seconds. */
export const SESSION_JWT_SECONDS = 15 * 60
export const ACCESS_TOKEN_SECONDS = 60 * 60
export const BROWSER_SESSION_SECONDS = 7 * 24 * 60 * 60

const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

// What Better Auth would create unmapped, for the plugins composed below. Only the field NAMES are read, to give each one its snake_case column: a field a library upgrade
// adds is mapped the same way, and the schema test fails until a new reviewed migration carries it.
const unmapped = getAuthTables({ baseURL: 'https://x.invalid', secret: 'x'.repeat(32), rateLimit: { enabled: true, storage: 'database' }, plugins: composePlugins('https://x.invalid') } as BetterAuthOptions)

function schemaFor(key: ModelKey): { modelName: string; fields: Record<string, string> } {
  const table = (unmapped as Record<string, { fields: Record<string, unknown> }>)[key]
  if (!table) throw new Error(`Better Auth has no model ${key}`)
  return { modelName: MODELS[key], fields: Object.fromEntries(Object.keys(table.fields).map((f) => [f, snake(f)])) }
}

function composePlugins(baseURL: string, schema?: (key: ModelKey) => ReturnType<typeof schemaFor>, vaultScopes: readonly string[] = [], grantable: readonly string[] = []) {
  const s = schema ?? (() => undefined)
  const scopes = [...AUTH_SCOPES, ...vaultScopes]
  // [[CORE283]] P6: a registered client holds the OIDC scopes and the grantable vault scopes, never a human-only one (the stored client scopes bound every later grant).
  const registrable = [...AUTH_SCOPES, ...grantable.filter((x) => vaultScopes.includes(x))]
  const resources = resourcesFor(baseURL)
  return [
    jwt({
      disableSettingJwtHeader: true,
      // The issuer is `<PUBLIC_BASE_URL>/auth` for both token kinds and the audience is the API origin ([[CORE243]] D23, [[CORE244]] D8): never read from a request.
      jwt: {
        issuer: `${baseURL}/auth`,
        audience: baseURL,
        expirationTime: `${SESSION_JWT_SECONDS}s`,
        // The session JWT carries no profile: the subject, the session id and the kind marker. The role is read from the vault on every request.
        definePayload: (session) => ({ [SESSION_TOKEN_CLAIM]: SESSION_TOKEN_VALUE, sid: session.session.id }),
      },
      ...(schema ? { schema: { jwks: schema('jwks') } } : {}),
    }),
    oauthProvider({
      loginPage: '/auth/sign-in',
      consentPage: '/auth/consent',
      scopes,
      accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
      // No `allowedScopes` on a resource row: the library seeds rows once and never updates them, so a list there would go stale when a scope is added. The client's own scopes
      // (NULL = the provider's list, for the seeded first-party client) bound a grant instead.
      resources,
      clientRegistrationDefaultResources: resources,
      clientRegistrationAllowedResources: resources,
      clientRegistrationDefaultScopes: registrable,
      clientRegistrationAllowedScopes: registrable,
      // Native MCP clients register a loopback `http://127.0.0.1:<port>` redirect and send no application_type: treat those as native (the web rules for any other client).
      clientRegistrationDefaultApplicationType: 'infer',
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      rateLimit: { register: REGISTRATION_LIMIT },
      ...(schema
        ? {
            schema: {
              oauthClient: s('oauthClient'),
              oauthResource: s('oauthResource'),
              oauthClientResource: s('oauthClientResource'),
              oauthRefreshToken: s('oauthRefreshToken'),
              oauthAccessToken: s('oauthAccessToken'),
              oauthConsent: s('oauthConsent'),
              oauthClientAssertion: s('oauthClientAssertion'),
            },
          }
        : {}),
    }),
    oauthDeviceAuthorization({ verificationUri: `${baseURL}/auth/device`, ...(schema ? { schema: { deviceCode: schema('deviceCode') } } : {}) }),
  ]
}

/** [[CORE283]] P6: unauthenticated registration admits public clients only (`token_endpoint_auth_method: none`); an absent method defaults to a confidential one in the library, so it is refused too. */
const publicClientsOnly = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/oauth2/register') return
  const method = (ctx.body as { token_endpoint_auth_method?: unknown } | undefined)?.token_endpoint_auth_method
  if (method !== 'none') throw new APIError('BAD_REQUEST', { error: 'invalid_client_metadata', error_description: 'only public clients may register: token_endpoint_auth_method must be none' })
})

/** The Better Auth options of the composition. Exported for the schema generator and the tests; the Worker uses `createAuthHandler`. */
export function authOptions(db: AuthDatabaseLike, config: AuthRuntimeConfig, opts: CreateAuthOptions = {}): BetterAuthOptions {
  const open = opts.unsafeOpenAdmissionForTests === true
  return {
    baseURL: config.baseURL,
    basePath: '/auth',
    secret: config.secret,
    database: { dialect: new D1Dialect({ database: db as never }), type: 'sqlite' },
    // Only this origin is trusted (D23): never the request's Host.
    trustedOrigins: [config.baseURL],
    // Admission is closed (P1). Sign-up is the only path that creates a user here; the invitation gate replaces the refusal ([[CORE245]]).
    emailAndPassword: { enabled: true, disableSignUp: !open, password: { hash: hashPassword, verify: verifyPassword } },
    user: schemaFor('user'),
    session: { ...schemaFor('session'), expiresIn: BROWSER_SESSION_SECONDS },
    account: schemaFor('account'),
    verification: schemaFor('verification'),
    rateLimit: { enabled: true, storage: 'database', ...schemaFor('rateLimit') },
    advanced: {
      database: { generateId: opts.generateId ?? (() => uuidv7()) },
      // Cloudflare's own header; a client-supplied X-Forwarded-For is not trusted.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
    plugins: composePlugins(config.baseURL, schemaFor, config.vaultScopes, config.grantableScopes),
    hooks: { before: publicClientsOnly },
  } as BetterAuthOptions
}

/** The Worker's handler for everything under `/auth`. Build once per isolate; it holds the library's own caches. */
export function createAuthHandler(db: AuthDatabaseLike, config: AuthRuntimeConfig, opts: CreateAuthOptions = {}): (req: Request) => Promise<Response> {
  const auth = betterAuth(authOptions(db, config, opts))
  // RFC 8414 path insertion ([[CORE283]] D12): the library mounts its metadata under `/auth`; the standard URL for the issuer `<base>/auth` is outside the base path.
  const metadata = oauthProviderAuthServerMetadata(auth as never)
  return (req) => (new URL(req.url).pathname === AUTH_SERVER_METADATA_PATH ? metadata(req) : auth.handler(req))
}

/** The first-party CLI's fixed client id ([[CORE243]] D10). */
export const CLI_CLIENT_ID = 'vibase-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * Seeds the first-party CLI client and the two resource rows it links to ([[CORE283]] D10, P5), through Better Auth's own adapter so the stored shapes are the library's.
 * Idempotent and convergent: a missing row is created; an existing client has its seeded shape (public, device and refresh grants, linked to both resources, `scopes` NULL so it
 * follows the provider's list) put back, and its `disabled` flag is left alone. Written by bootstrap only (AGENTS.md invariant 5's auth-table exception); the Worker's handler never calls it.
 */
export async function seedFirstPartyClient(db: AuthDatabaseLike, config: { baseURL: string }): Promise<{ client: 'created' | 'existing' }> {
  // The secret signs nothing here: the instance exists only to reach the configured adapter (names, JSON encodings, ids).
  const auth = betterAuth(authOptions(db, { secret: 'seed-only-secret-never-signs-anything-0123456789', baseURL: config.baseURL }))
  const { adapter } = (await auth.$context) as unknown as { adapter: SeedAdapter }
  const now = new Date()
  for (const identifier of resourcesFor(config.baseURL)) {
    if (!(await adapter.findOne({ model: 'oauthResource', where: [{ field: 'identifier', value: identifier }] }))) {
      await adapter.create({ model: 'oauthResource', data: { identifier, name: identifier, allowedScopes: null, dpopBoundAccessTokensRequired: false, disabled: false, policyVersion: 1, createdAt: now, updatedAt: now } })
    }
  }
  const shape = { name: 'Vibase CLI', tokenEndpointAuthMethod: 'none', grantTypes: [DEVICE_GRANT, 'refresh_token'], responseTypes: [], redirectUris: [], scopes: null, applicationType: 'native' }
  const where = [{ field: 'clientId', value: CLI_CLIENT_ID }]
  const existing = await adapter.findOne({ model: 'oauthClient', where })
  // Updated only when the stored shape differs, so a converged re-run writes nothing (not even `updated_at`).
  const current = existing as Record<string, unknown> | null
  const same = current !== null && Object.entries(shape).every(([k, v]) => JSON.stringify(current[k] ?? null) === JSON.stringify(v))
  if (existing) {
    if (!same) await adapter.update({ model: 'oauthClient', where, update: { ...shape, updatedAt: now } })
  }
  else await adapter.create({ model: 'oauthClient', data: { clientId: CLI_CLIENT_ID, ...shape, createdAt: now, updatedAt: now } })
  for (const resourceId of resourcesFor(config.baseURL)) {
    const link = [{ field: 'clientId', value: CLI_CLIENT_ID }, { field: 'resourceId', value: resourceId }]
    if (!(await adapter.findOne({ model: 'oauthClientResource', where: link }))) await adapter.create({ model: 'oauthClientResource', data: { clientId: CLI_CLIENT_ID, resourceId, createdAt: now } })
  }
  return { client: existing ? 'existing' : 'created' }
}

interface SeedAdapter {
  findOne(o: { model: string; where: Array<{ field: string; value: unknown }> }): Promise<unknown | null>
  create(o: { model: string; data: Record<string, unknown> }): Promise<unknown>
  update(o: { model: string; where: Array<{ field: string; value: unknown }>; update: Record<string, unknown> }): Promise<unknown>
}
