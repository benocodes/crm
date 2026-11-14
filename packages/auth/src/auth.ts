// The Better Auth composition for the D1 Worker ([[CORE243]] D1, D3, D4, D13, D21). Better Auth is the vault's built-in sign-in and OAuth authorisation server; this module
// only configures it: the plugins (`jwt`, `oauthProvider`, `oauthDeviceAuthorization`, nothing else), the vault's table and column names, UUIDv7 ids, the PBKDF2 hasher, and a
// fail-closed admission policy while the vault has no invitations ([[CORE245]]) and no client-registration policy ([[CORE244]]).
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
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
}

/** A D1 binding, as much of it as Kysely's D1 dialect uses; the Worker passes its `DB`. */
export interface AuthDatabaseLike {
  prepare(query: string): unknown
}

export interface CreateAuthOptions {
  /**
   * TEST ONLY. Admits email sign-up and dynamic client registration. The shipped composition never passes it: until the invitation gate ([[CORE245]]) and the client-registration
   * policy ([[CORE244]]) exist, `/auth` refuses every account creation and every registration ([[CORE243]] P1).
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
const unmapped = getAuthTables({ baseURL: 'https://x.invalid', secret: 'x'.repeat(32), rateLimit: { enabled: true, storage: 'database' }, plugins: composePlugins('https://x.invalid', false) } as BetterAuthOptions)

function schemaFor(key: ModelKey): { modelName: string; fields: Record<string, string> } {
  const table = (unmapped as Record<string, { fields: Record<string, unknown> }>)[key]
  if (!table) throw new Error(`Better Auth has no model ${key}`)
  return { modelName: MODELS[key], fields: Object.fromEntries(Object.keys(table.fields).map((f) => [f, snake(f)])) }
}

function composePlugins(baseURL: string, open: boolean, schema?: (key: ModelKey) => ReturnType<typeof schemaFor>, vaultScopes: readonly string[] = []) {
  const s = schema ?? (() => undefined)
  const scopes = [...AUTH_SCOPES, ...vaultScopes]
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
      resources: [{ identifier: baseURL, allowedScopes: scopes }],
      clientRegistrationDefaultResources: [baseURL],
      clientRegistrationAllowedScopes: scopes,
      allowDynamicClientRegistration: open,
      allowUnauthenticatedClientRegistration: open,
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
    plugins: composePlugins(config.baseURL, open, schemaFor, config.vaultScopes),
  } as BetterAuthOptions
}

/** The Worker's handler for everything under `/auth`. Build once per isolate; it holds the library's own caches. */
export function createAuthHandler(db: AuthDatabaseLike, config: AuthRuntimeConfig, opts: CreateAuthOptions = {}): (req: Request) => Promise<Response> {
  const auth = betterAuth(authOptions(db, config, opts))
  return (req) => auth.handler(req)
}
