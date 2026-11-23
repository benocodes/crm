// The Better Auth composition for the D1 Worker ([[CORE243]] D1, D3, D4, D13, D21). Better Auth is the vault's built-in sign-in and OAuth authorisation server; this module
// only configures it: the plugins (`jwt`, `oauthProvider`, `oauthDeviceAuthorization`, nothing else), the vault's table and column names, UUIDv7 ids, the PBKDF2 hasher, and a
// fail-closed admission policy while the vault has no invitations ([[CORE245]]) and no client-registration policy ([[CORE244]]).
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, addOAuthServerContext, createAuthMiddleware, getOAuthState } from 'better-auth/api'
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
  /** Extra first-party app origins ([[UI255]] D3): appended to `trustedOrigins` after `baseURL`. Already validated by the Worker's composition (D6). Default none. */
  trustedOrigins?: readonly string[]
  /** The vault's scope names (`contacts:read`, ...): joined to the OIDC scopes the provider knows, so an access token can carry them ([[CORE244]] D9). The composition passes the registry's declared scopes. */
  vaultScopes?: readonly string[]
  /** The subset of `vaultScopes` an agent may be granted ([[CORE243]] D11, P6): the only vault scopes a dynamically registered client may hold. Default none (OIDC scopes only). */
  grantableScopes?: readonly string[]
  /** The subset of `grantableScopes` a registration naming no scope holds ([[CORE261]] P2: a scope may be grantable and still not a default). Default: all of `grantableScopes`. */
  defaultScopes?: readonly string[]
  /** The Google client for sign-in ([[CORE294]] D7), already resolved by the Worker's composition (`AUTH_GOOGLE_*`, else the Gmail pair). Absent: Google sign-in is off and Better Auth registers no provider. */
  google?: { clientId: string; clientSecret: string }
}

/** Google sign-in asks for these scopes and no others ([[CORE294]] D7). */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const
/** The OAuth state's server-context key that carries the invitation token across Google's redirect ([[CORE294]] D8, P3). */
const SERVER_CONTEXT_TOKEN = 'invitationToken'

/** [[UI510]] D7: the vault's own pages Better Auth redirects to, under `/app` (the auth bundle's table entries in `@vibase/server-d1`, pinned by its `auth-page-urls.test.ts`). */
export const LOGIN_PAGE_PATH = '/app/sign-in'
export const CONSENT_PAGE_PATH = '/app/consent'
export const DEVICE_PAGE_PATH = '/app/device'
/** The resources the provider issues access tokens for ([[CORE283]] P1): the API origin and the MCP endpoint's canonical URI (RFC 8707). Both name this one Worker. */
export const MCP_RESOURCE_PATH = '/mcp'
export const resourcesFor = (baseURL: string): [string, string] => [baseURL, `${baseURL}${MCP_RESOURCE_PATH}`]
/** Registration policy ([[CORE283]] P6): this many registrations per client IP per window. */
export const REGISTRATION_LIMIT = { window: 60 * 60, max: 10 } as const
/** RFC 8414 path insertion for the issuer `<base>/auth` ([[CORE283]] D12): the document Better Auth builds, served where the standard says it is. */
export const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server/auth'

/** The device user code ([[UI247]] D2): 8 characters from a 32-character alphabet without `I`, `O`, `0` and `1` (40 bits), stored unseparated (the page shows it as `XXXX-XXXX`), valid 30 minutes, polled every 5 seconds. */
export const DEVICE_USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const DEVICE_USER_CODE_LENGTH = 8
export const DEVICE_CODE_EXPIRES_IN = '30m'
export const DEVICE_POLL_INTERVAL = '5s'
/** 256 is a multiple of the alphabet's 32, so a random byte masked to 5 bits is uniform. */
export function generateDeviceUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_USER_CODE_LENGTH))
  return Array.from(bytes, (b) => DEVICE_USER_CODE_ALPHABET[b & 31]!).join('')
}

/** A D1 binding, as much of it as Kysely's D1 dialect uses; the Worker passes its `DB`. */
export interface AuthDatabaseLike {
  prepare(query: string): unknown
}

/** The one refusal code of the sign-up gate ([[CORE287]] P2): missing, unknown, another email, expired, revoked and accepted invitations are all this, so the answer says nothing about which invitations exist. */
export const INVITATION_REQUIRED = 'invitation_required'
/** The body field that carries the raw invitation token on `POST /auth/sign-up/email` ([[CORE287]] P1; Better Auth's body schema passes unknown fields through). */
export const INVITATION_TOKEN_FIELD = 'invitation_token'
/**
 * The request header that carries the raw invitation token on `POST /auth/sign-in/email` ([[CORE302]] P1): Better Auth 1.7.22's sign-in body schema is a strict-stripping `z.object`, so an `invitation_token`
 * field never reaches the hooks there (the sign-up schema passes it through). Read in the session hook, after the credential is proven.
 */
export const INVITATION_TOKEN_HEADER = 'vibase-invitation'

/**
 * What the composition hands the auth package so it can gate and settle accounts without ever reaching the CRM or control database itself ([[CORE259]] D5, [[CORE287]]): the Worker implements it over
 * the control store and the vault's acceptance program.
 */
export interface InvitationAdmission {
  /** The gate: is there a live invitation for this (trimmed, lowercased) email whose token is `token`? Reads only; `false` for every failing cause alike. */
  admits(a: { email: string; token: string }): Promise<boolean>
  /**
   * Called on every session creation (sign-up and sign-in, [[CORE287]] P3, P5) with the Better Auth account behind it. Writes the vault's rows and marks the invitation accepted when the account has no
   * rows yet and a live invitation created no later than the account admitted it; re-admits a removed member whose sign-in carries a live token for its email ([[CORE302]]); otherwise writes nothing.
   * Throws when the write fails: the session is then not created.
   */
  settle(a: {
    subject: string
    email: string
    name: string /** The Better Auth user's `emailVerified` ([[CORE294]] P5): true for a Google-verified account, false for a password sign-up. */
    emailVerified: boolean
    accountCreatedAt: Date /** The invitation token this sign-in carries ([[CORE302]] P1): the `vibase-invitation` header (password) or the OAuth state's server context (Google). Only a re-admission reads it. */
    token?: string
  }): Promise<void>
}

export interface CreateAuthOptions {
  /**
   * Keeps the request that built this instance alive until Better Auth's own initialisation settles (the runtime's `waitUntil`). The library starts that initialisation when the
   * instance is built, and workerd lets a promise settle only in the request that created it: a first request that ends before it settles (the metadata answer no longer waits
   * on the database) leaves every later request awaiting a promise that never settles, which was a 500 on `/auth/oauth2/authorize` (OPS252).
   */
  keepAlive?: (settled: Promise<unknown>) => void
  /**
   * TEST ONLY. Admits email sign-up with no invitation. The shipped composition never passes it: `/auth` admits an account only through `admission` ([[CORE243]] P1, [[CORE287]]).
   * Dynamic client registration is open under the policy of [[CORE283]] P6 whatever this says.
   */
  unsafeOpenAdmissionForTests?: boolean
  /** The invitation gate and acceptance ([[CORE287]]). Without it (and without the test switch) `/auth` refuses every account creation. */
  admission?: InvitationAdmission
  /** Ids of every auth row; UUIDv7 by default, like the vault's. */
  generateId?: () => string
  /**
   * Owner-issued reset links ([[CORE288]] P6, P7): where `sendResetPassword` hands the token it is given. Present (the shipped composition, through `createAuth`), `sendResetPassword` is configured and the
   * public reset-request paths are refused for every HTTP request; only an in-process call that registered a waiter for its address passes. Absent: no `sendResetPassword`, as before.
   */
  resetCaptures?: ResetCaptures
  /**
   * Self-service reset ([[CORE304]] D4): present only when the composition has email. It turns on the HTTP `POST /request-password-reset` (the gate lets it through; `/forget-password` stays refused), the 5 per hour
   * per client IP limit, and is called with the address and token of every reset Better Auth issues for an HTTP request, never for the in-process owner-issued call ([[CORE304]] P1: that token only ever reaches its
   * waiter). Composition builds the message and schedules the send; this package knows no email. It must return at once and never throw.
   */
  deliverResetToken?: (a: { email: string; token: string }) => void
}

/** The tokens `sendResetPassword` hands over, by lowercased address: a waiter is registered only around an in-process call, so nothing else can ever receive or see a token. */
export type ResetCaptures = Map<string, (token: string) => void>
/** The password reset token's lifetime ([[CORE243]] D15): one hour. */
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60
/** [[CORE304]] D4: a whole-hour window, not the library default (3 per 60 s). */
export const RESET_REQUEST_LIMIT = { window: 60 * 60, max: 5 } as const
const RESET_REQUEST_PATHS = new Set(['/request-password-reset', '/forget-password'])

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
const unmapped = getAuthTables({
  baseURL: 'https://x.invalid',
  secret: 'x'.repeat(32),
  rateLimit: { enabled: true, storage: 'database' },
  plugins: composePlugins('https://x.invalid'),
} as BetterAuthOptions)

function schemaFor(key: ModelKey): { modelName: string; fields: Record<string, string> } {
  const table = (unmapped as Record<string, { fields: Record<string, unknown> }>)[key]
  if (!table) throw new Error(`Better Auth has no model ${key}`)
  return { modelName: MODELS[key], fields: Object.fromEntries(Object.keys(table.fields).map((f) => [f, snake(f)])) }
}

/**
 * The scopes a dynamically registered client may name (`allowed`) and the ones a registration naming none is given (`defaults`) ([[CORE283]] P6, [[CORE261]] P2): the OIDC scopes and the grantable vault scopes,
 * never a human-only one. `defaults` is `grantable` unless the composition narrows it. Note: Better Auth persists a client's scopes as the union of both lists, so a scope that is allowed but not a default is
 * accepted when named and is still bound by the consent step; narrowing the default list is what the library's configuration offers.
 */
export function registrationScopes(
  vaultScopes: readonly string[],
  grantable: readonly string[],
  defaults?: readonly string[],
): { allowed: string[]; defaults: string[] } {
  const allowed = [...AUTH_SCOPES, ...grantable.filter((x) => vaultScopes.includes(x))]
  return {
    allowed,
    defaults: [
      ...AUTH_SCOPES,
      ...(defaults ?? grantable).filter((x) => vaultScopes.includes(x) && allowed.includes(x)),
    ],
  }
}

function composePlugins(
  baseURL: string,
  schema?: (key: ModelKey) => ReturnType<typeof schemaFor>,
  vaultScopes: readonly string[] = [],
  grantable: readonly string[] = [],
  defaults: readonly string[] | undefined = undefined,
) {
  const s = schema ?? (() => undefined)
  const scopes = [...AUTH_SCOPES, ...vaultScopes]
  const { allowed: registrable, defaults: defaultScopes } = registrationScopes(vaultScopes, grantable, defaults)
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
      // [[UI246]] D1: the vault's own sign-in page, outside Better Auth's base path.
      loginPage: LOGIN_PAGE_PATH,
      // [[UI247]] D1: the vault's own consent page, outside Better Auth's base path (the signed query rides on it).
      consentPage: CONSENT_PAGE_PATH,
      scopes,
      accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
      // No `allowedScopes` on a resource row: the library seeds rows once and never updates them, so a list there would go stale when a scope is added. The client's own scopes
      // (NULL = the provider's list, for the seeded first-party client) bound a grant instead.
      resources,
      clientRegistrationDefaultResources: resources,
      clientRegistrationAllowedResources: resources,
      clientRegistrationDefaultScopes: defaultScopes,
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
    oauthDeviceAuthorization({
      // [[UI247]] D1, D2: `verification_uri(_complete)` name the vault's page; the library's JSON endpoint `GET /auth/device` stays the page's claim call. The code format is pinned here, not left to a library default.
      verificationUri: `${baseURL}${DEVICE_PAGE_PATH}`,
      userCodeLength: DEVICE_USER_CODE_LENGTH,
      generateUserCode: generateDeviceUserCode,
      expiresIn: DEVICE_CODE_EXPIRES_IN,
      interval: DEVICE_POLL_INTERVAL,
      ...(schema ? { schema: { deviceCode: schema('deviceCode') } } : {}),
    }),
  ]
}

const refusal = () =>
  new APIError('FORBIDDEN', {
    code: INVITATION_REQUIRED,
    message: 'sign-up requires a valid invitation for this email',
  })

/**
 * The gate ([[CORE287]] P1, P2): a live invitation for `body.email` whose token is `body.invitation_token`, else the one refusal. Every cause is the same `403`, and nothing is written.
 * Without an `admission` port nothing is admitted.
 */
async function requireInvitation(admission: InvitationAdmission | undefined, body: unknown): Promise<void> {
  const b = (body ?? {}) as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const token = typeof b[INVITATION_TOKEN_FIELD] === 'string' ? (b[INVITATION_TOKEN_FIELD] as string) : ''
  if (!admission || email === '' || token === '' || !(await admission.admits({ email, token }))) throw refusal()
}

/**
 * The Google branch of the backstop ([[CORE294]] D8, P3, P4): a user creation on an OAuth callback is admitted only when the token in the state's SERVER context is live for the Google profile's email AND
 * Google reports that email verified. The token is read from `serverContext` only, never from a top-level state key (client `additionalData`) and never from the callback's query.
 */
async function requireGoogleInvitation(
  admission: InvitationAdmission | undefined,
  user: { email?: unknown; emailVerified?: unknown } | null | undefined,
  state: { serverContext?: Record<string, unknown> },
): Promise<void> {
  const token = state.serverContext?.[SERVER_CONTEXT_TOKEN]
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : ''
  if (
    !admission ||
    email === '' ||
    user?.emailVerified !== true ||
    typeof token !== 'string' ||
    token === '' ||
    !(await admission.admits({ email, token }))
  )
    throw refusal()
}

/** The OAuth state of the current request, or null when there is none (an email sign-up, or a call outside a request). */
async function oauthStateOrNull(): Promise<{ serverContext?: Record<string, unknown> } | null> {
  try {
    return ((await getOAuthState()) as { serverContext?: Record<string, unknown> } | null) ?? null
  } catch {
    return null
  }
}

/** The invitation token a sign-in presents ([[CORE302]] P1): the `vibase-invitation` header (password), else the OAuth state's server context (Google). Only a non-empty string; never a query value. */
async function presentedToken(ctx: { headers?: Headers } | null | undefined): Promise<string | undefined> {
  const header = ctx?.headers?.get(INVITATION_TOKEN_HEADER)
  if (typeof header === 'string' && header !== '') return header
  const fromState = (await oauthStateOrNull())?.serverContext?.[SERVER_CONTEXT_TOKEN]
  return typeof fromState === 'string' && fromState !== '' ? fromState : undefined
}

/**
 * Before-hooks of every endpoint. [[CORE283]] P6: unauthenticated registration admits public clients only (`token_endpoint_auth_method: none`); an absent method defaults to a confidential one in the
 * library, so it is refused too. [[CORE287]]: email sign-up is gated before anything else runs, so an unadmitted request costs no password hash and cannot tell an existing account from an absent one.
 */
const endpointGate = (
  admission: InvitationAdmission | undefined,
  open: boolean,
  captures: ResetCaptures | undefined,
  selfService: boolean,
  defaultScopes: readonly string[],
) =>
  createAuthMiddleware(async (ctx) => {
    // [[CORE330]]: an authorize request that names no scope (absent, empty or blank) asks for the registration default list, never the client's stored ceiling (the library's own fallback is `client.scopes`, the
    // default plus the allowed list). Filled here, before the library reads it, so the signed `oauth_query` that rides to /sign-in and /consent already carries it; a named scope is never touched.
    if (ctx.path === '/oauth2/authorize') {
      const post = ctx.method === 'POST'
      const source = (post ? ctx.body : ctx.query) as Record<string, unknown> | undefined
      const named = source?.scope
      if (named === undefined || (typeof named === 'string' && named.trim() === '')) {
        const filled = { ...source, scope: defaultScopes.join(' ') }
        return { context: post ? { body: filled } : { query: filled } }
      }
    }
    if (ctx.path === '/sign-up/email' && !open) await requireInvitation(admission, ctx.body)
    // [[CORE288]] P7: with email off there is no self-service reset. The request is refused for every HTTP request (it never creates a verification row, never captures, returns or logs a token); the one
    // in-process call (`issueResetToken`) has no `request` and a waiter registered for its address.
    if (captures && RESET_REQUEST_PATHS.has(ctx.path)) {
      const email =
        typeof (ctx.body as { email?: unknown } | undefined)?.email === 'string'
          ? (ctx.body as { email: string }).email.trim().toLowerCase()
          : ''
      // [[CORE304]] D4: with email on, an HTTP `/request-password-reset` passes; `/forget-password` and everything else keeps today's rule.
      const publicRequest = selfService && ctx.request !== undefined && ctx.path === '/request-password-reset'
      if (!publicRequest && (ctx.request !== undefined || !captures.has(email)))
        throw new APIError('BAD_REQUEST', {
          code: 'RESET_PASSWORD_DISABLED',
          message: 'password reset links are issued by a workspace owner',
        })
    }
    // [[CORE294]] D8, P3: the invitation token of a Google sign-up rides the OAuth state's SERVER context (never a URL), and only a non-empty string is copied.
    if (ctx.path === '/sign-in/social') {
      const token = (ctx.body as Record<string, unknown> | undefined)?.[INVITATION_TOKEN_FIELD]
      if (typeof token === 'string' && token !== '') await addOAuthServerContext({ [SERVER_CONTEXT_TOKEN]: token })
    }
    if (ctx.path !== '/oauth2/register') return
    const body = ctx.body as Record<string, unknown> | undefined
    // What a connector sent, for the operator's log (RFC 7591 metadata is public; no secret rides a registration).
    console.log(
      '[oauth-register]',
      JSON.stringify({
        method: body?.token_endpoint_auth_method ?? null,
        grants: body?.grant_types ?? null,
        scope_count: typeof body?.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean).length : null,
        redirects: body?.redirect_uris ?? null,
        application_type: body?.application_type ?? null,
        client_name: body?.client_name ?? null,
      }),
    )
    // RFC 7591 s2: an omitted `token_endpoint_auth_method` defaults to a secret-based method; this server keeps registering such a client as public (`none`), as before.
    if (body && body.token_endpoint_auth_method === undefined) body.token_endpoint_auth_method = 'none'
    // The library's own registration methods: a connector may ask for a secret (`client_secret_post`/`client_secret_basic`, which Claude web does and which Cloudflare's reference MCP
    // authorization server answers by issuing one) or none. Anything else (`private_key_jwt` needs registered keys) is refused.
    const method = body?.token_endpoint_auth_method
    if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic')
      throw new APIError('BAD_REQUEST', {
        error: 'invalid_client_metadata',
        error_description: 'token_endpoint_auth_method must be one of none, client_secret_post, client_secret_basic',
      })
  })

/** The Better Auth options of the composition. Exported for the schema generator and the tests; the Worker uses `createAuthHandler`. */
export function authOptions(
  db: AuthDatabaseLike,
  config: AuthRuntimeConfig,
  opts: CreateAuthOptions = {},
): BetterAuthOptions {
  const open = opts.unsafeOpenAdmissionForTests === true
  const { admission } = opts
  return {
    baseURL: config.baseURL,
    basePath: '/auth',
    secret: config.secret,
    database: { dialect: new D1Dialect({ database: db as never }), type: 'sqlite' },
    // Only this origin is trusted (D23): never the request's Host. With none configured the list is `[baseURL]` exactly; the extras are the operator's first-party app origins ([[UI255]] D3, D6).
    trustedOrigins: [config.baseURL, ...(config.trustedOrigins ?? [])],
    // Admission is closed (P1) unless the composition hands in the invitation port ([[CORE287]]); sign-up is the only path that creates a user here.
    // [[UI246]] D6: a reset ends every session of that user (it answers a lost or compromised password). [[CORE288]] P6: `sendResetPassword` only hands the token to an in-process waiter (never sends, never logs).
    emailAndPassword: {
      enabled: true,
      disableSignUp: !open && !admission,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      ...(opts.resetCaptures
        ? {
            resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SECONDS,
            sendResetPassword: async (
              { user, token }: { user: { email: string }; token: string },
              request?: Request,
            ) => {
              const address = user.email.trim().toLowerCase()
              // [[CORE304]] P1: only the in-process call (no HTTP `request`) is captured; an HTTP request is delivered by email even while a waiter for its address is registered, and the waiter keeps its own token.
              if (request === undefined) opts.resetCaptures!.get(address)?.(token)
              else opts.deliverResetToken?.({ email: address, token })
            },
          }
        : {}),
    },
    user: schemaFor('user'),
    session: { ...schemaFor('session'), expiresIn: BROWSER_SESSION_SECONDS },
    // [[CORE294]] D8: an existing account is linked to Google only by a Google-verified email equal to its own, with no trusted providers; the local email need not be verified (a password account never is: no verification mail).
    account: {
      ...schemaFor('account'),
      accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: false },
    },
    // [[CORE294]] D7: Google is registered only when the composition hands in a complete client; scopes are exactly `openid email profile`, the redirect URI is Better Auth's `<base>/auth/callback/google`.
    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
              disableDefaultScope: true,
              scope: [...GOOGLE_SCOPES],
            },
          },
        }
      : {}),
    verification: schemaFor('verification'),
    // [[CORE304]] D4, P3: with email on, a reset request is limited to 5 per hour per client IP (the library's default is 3 per minute); keyed by `cf-connecting-ip` like registration, and one shared bucket per path without it.
    rateLimit: {
      enabled: true,
      storage: 'database',
      ...schemaFor('rateLimit'),
      ...(opts.deliverResetToken ? { customRules: { '/request-password-reset': RESET_REQUEST_LIMIT } } : {}),
    },
    advanced: {
      database: { generateId: opts.generateId ?? (() => uuidv7()) },
      // Cloudflare's own header; a client-supplied X-Forwarded-For is not trusted.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
    plugins: composePlugins(
      config.baseURL,
      schemaFor,
      config.vaultScopes,
      config.grantableScopes,
      config.defaultScopes,
    ),
    hooks: {
      before: endpointGate(
        admission,
        open,
        opts.resetCaptures,
        opts.deliverResetToken !== undefined,
        registrationScopes(config.vaultScopes ?? [], config.grantableScopes ?? [], config.defaultScopes).defaults,
      ),
    },
    databaseHooks: {
      user: {
        // The backstop at the point EVERY account creation passes ([[CORE287]] P2): a path the endpoint hook does not name (a later Google sign-in) carries no token and is refused here.
        // [[CORE294]] P4: a creation on the OAuth callback carries the provider's profile and the state; any other creation (email sign-up) is judged on the request body as before.
        create: {
          before: async (
            user: { email?: unknown; emailVerified?: unknown },
            ctx: { body?: unknown } | null | undefined,
          ) => {
            if (open) return
            const state = await oauthStateOrNull()
            if (state) await requireGoogleInvitation(admission, user, state)
            else await requireInvitation(admission, ctx?.body)
          },
        },
      },
      session: {
        // Every successful sign-up and sign-in creates a session: the one place acceptance and repair ([[CORE287]] P3, P5) run, before the session exists, so a failure leaves no cookie.
        create: {
          before: async (
            session: { userId: string },
            ctx:
              | {
                  headers?: Headers
                  context?: {
                    internalAdapter?: {
                      findUserById(id: string): Promise<{
                        id: string
                        email: string
                        name: string
                        emailVerified?: boolean
                        createdAt: Date | string | number
                      } | null>
                    }
                    logger?: { error(...a: unknown[]): void }
                  }
                }
              | null
              | undefined,
          ) => {
            if (!admission) return
            const user = await ctx?.context?.internalAdapter?.findUserById(session.userId)
            if (!user) return
            const token = await presentedToken(ctx)
            try {
              await admission.settle({
                subject: user.id,
                email: user.email,
                name: user.name,
                emailVerified: user.emailVerified === true,
                accountCreatedAt: new Date(user.createdAt),
                ...(token === undefined ? {} : { token }),
              })
            } catch (err) {
              ctx?.context?.logger?.error(
                'invitation acceptance failed',
                err instanceof Error ? err.message : 'unknown error',
              )
              throw new APIError('INTERNAL_SERVER_ERROR', {
                code: 'invitation_acceptance_failed',
                message: 'the account could not be settled; sign in again to retry',
              })
            }
          },
        },
      },
    },
  } as BetterAuthOptions
}

/** What the Worker holds of the built-in provider: the handler for everything under `/auth`, and the in-process reset-link issue ([[CORE288]] P6). */
export interface AuthService {
  handler: (req: Request) => Promise<Response>
  /**
   * Better Auth's own password-reset request, driven in-process for an owner-issued link: `sendResetPassword` hands over the `token` (never its `url`) and the verification row's expiry is read back.
   * `null` when no account has this email. Calls for one address are serialised; the token is returned to the caller only and never stored or logged here.
   */
  issueResetToken(email: string): Promise<{ token: string; expiresAt: Date } | null>
}

/**
 * The authorization-server metadata, built from config alone (OPS252, hq cutover). The library's own handler runs Better Auth's request machinery, which on a cold isolate made
 * several D1 round trips (3.4 s from a US colo to a European database) and overran the 5 s budget of Claude web's connector check, so Claude never reached registration. This
 * document needs no database. It equals what the library emits for this composition with `shapeMetadata` applied (the discovery test compares them), so a library upgrade that
 * changes the document fails that test instead of drifting.
 */
export function staticAuthServerMetadata(baseURL: string, vaultScopes: readonly string[]): Record<string, unknown> {
  const issuer = `${baseURL}/auth`
  const publicMethods = ['client_secret_basic', 'client_secret_post']
  return {
    scopes_supported: [...AUTH_SCOPES, ...vaultScopes],
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/jwks`,
    registration_endpoint: `${issuer}/oauth2/register`,
    introspection_endpoint: `${issuer}/oauth2/introspect`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token', DEVICE_GRANT],
    token_endpoint_auth_methods_supported: ['none', ...publicMethods],
    introspection_endpoint_auth_methods_supported: publicMethods,
    revocation_endpoint_auth_methods_supported: publicMethods,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: ['EdDSA', 'ES256', 'ES512', 'PS256', 'RS256'],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'sid',
      'scope',
      'azp',
      'name',
      'picture',
      'given_name',
      'family_name',
      'email',
      'email_verified',
    ],
    claims_parameter_supported: true,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
    subject_types_supported: ['public'],
    acr_values_supported: ['0'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    end_session_endpoint: `${issuer}/oauth2/end-session`,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    prompt_values_supported: ['login', 'consent', 'create', 'select_account', 'none'],
    device_authorization_endpoint: `${issuer}/device/code`,
  }
}

function staticMetadataResponse(baseURL: string, vaultScopes: readonly string[]): Response {
  return new Response(JSON.stringify(staticAuthServerMetadata(baseURL, vaultScopes)), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400',
    },
  })
}

/** The built-in provider for the Worker: build once per isolate; it holds the library's own caches. */
export function createAuth(db: AuthDatabaseLike, config: AuthRuntimeConfig, opts: CreateAuthOptions = {}): AuthService {
  const captures: ResetCaptures = opts.resetCaptures ?? new Map()
  const auth = betterAuth(authOptions(db, config, { ...opts, resetCaptures: captures }))
  opts.keepAlive?.(Promise.resolve(auth.$context).catch(() => undefined))
  // RFC 8414 path insertion ([[CORE283]] D12): the library mounts its metadata under `/auth`; the standard URL for the issuer `<base>/auth` is outside the base path.
  const lanes = new Map<string, Promise<unknown>>()
  return {
    handler: async (req) =>
      new URL(req.url).pathname === AUTH_SERVER_METADATA_PATH
        ? staticMetadataResponse(config.baseURL, config.vaultScopes ?? [])
        : auth.handler(req),
    issueResetToken(email) {
      const key = email.trim().toLowerCase()
      const run = (lanes.get(key) ?? Promise.resolve()).then(async () => {
        let token: string | undefined
        captures.set(key, (t) => void (token = t))
        try {
          await auth.api.requestPasswordReset({ body: { email: key } })
        } finally {
          captures.delete(key)
        }
        if (token === undefined) return null
        const { internalAdapter } = (await auth.$context) as unknown as {
          internalAdapter: { findVerificationValue(identifier: string): Promise<{ expiresAt: Date } | null> }
        }
        const row = await internalAdapter.findVerificationValue(`reset-password:${token}`)
        if (!row) return null
        return { token, expiresAt: new Date(row.expiresAt) }
      })
      lanes.set(
        key,
        run.catch(() => undefined),
      )
      return run
    },
  }
}

/** The handler alone, for composition that issues no reset links (and the tests): no `sendResetPassword`, so every reset request is refused by the library. */
export function createAuthHandler(
  db: AuthDatabaseLike,
  config: AuthRuntimeConfig,
  opts: CreateAuthOptions = {},
): (req: Request) => Promise<Response> {
  const auth = betterAuth(authOptions(db, config, opts))
  opts.keepAlive?.(Promise.resolve(auth.$context).catch(() => undefined))
  return (req) =>
    Promise.resolve(
      new URL(req.url).pathname === AUTH_SERVER_METADATA_PATH
        ? staticMetadataResponse(config.baseURL, config.vaultScopes ?? [])
        : auth.handler(req),
    )
}

/** The first-party CLI's fixed client id ([[CORE243]] D10). */
export const CLI_CLIENT_ID = 'vibase-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * Seeds the first-party CLI client and the two resource rows it links to ([[CORE283]] D10, P5), through Better Auth's own adapter so the stored shapes are the library's.
 * Idempotent and convergent: a missing row is created; an existing client has its seeded shape (public, device and refresh grants, linked to both resources, `scopes` NULL so it
 * follows the provider's list) put back, and its `disabled` flag is left alone. Written by bootstrap only (AGENTS.md invariant 5's auth-table exception); the Worker's handler never calls it.
 */
export async function seedFirstPartyClient(
  db: AuthDatabaseLike,
  config: { baseURL: string },
): Promise<{ client: 'created' | 'existing' }> {
  // The secret signs nothing here: the instance exists only to reach the configured adapter (names, JSON encodings, ids).
  const auth = betterAuth(
    authOptions(db, { secret: 'seed-only-secret-never-signs-anything-0123456789', baseURL: config.baseURL }),
  )
  const { adapter } = (await auth.$context) as unknown as { adapter: SeedAdapter }
  const now = new Date()
  for (const identifier of resourcesFor(config.baseURL)) {
    if (!(await adapter.findOne({ model: 'oauthResource', where: [{ field: 'identifier', value: identifier }] }))) {
      await adapter.create({
        model: 'oauthResource',
        data: {
          identifier,
          name: identifier,
          allowedScopes: null,
          dpopBoundAccessTokensRequired: false,
          disabled: false,
          policyVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      })
    }
  }
  const shape = {
    name: 'Vibase CLI',
    tokenEndpointAuthMethod: 'none',
    grantTypes: [DEVICE_GRANT, 'refresh_token'],
    responseTypes: [],
    redirectUris: [],
    scopes: null,
    applicationType: 'native',
  }
  const where = [{ field: 'clientId', value: CLI_CLIENT_ID }]
  const existing = await adapter.findOne({ model: 'oauthClient', where })
  // Updated only when the stored shape differs, so a converged re-run writes nothing (not even `updated_at`).
  const current = existing as Record<string, unknown> | null
  const same =
    current !== null &&
    Object.entries(shape).every(([k, v]) => JSON.stringify(current[k] ?? null) === JSON.stringify(v))
  if (existing) {
    if (!same) await adapter.update({ model: 'oauthClient', where, update: { ...shape, updatedAt: now } })
  } else
    await adapter.create({
      model: 'oauthClient',
      data: { clientId: CLI_CLIENT_ID, ...shape, createdAt: now, updatedAt: now },
    })
  for (const resourceId of resourcesFor(config.baseURL)) {
    const link = [
      { field: 'clientId', value: CLI_CLIENT_ID },
      { field: 'resourceId', value: resourceId },
    ]
    if (!(await adapter.findOne({ model: 'oauthClientResource', where: link })))
      await adapter.create({
        model: 'oauthClientResource',
        data: { clientId: CLI_CLIENT_ID, resourceId, createdAt: now },
      })
  }
  return { client: existing ? 'existing' : 'created' }
}

interface SeedAdapter {
  findOne(o: { model: string; where: Array<{ field: string; value: unknown }> }): Promise<unknown | null>
  create(o: { model: string; data: Record<string, unknown> }): Promise<unknown>
  update(o: {
    model: string
    where: Array<{ field: string; value: unknown }>
    update: Record<string, unknown>
  }): Promise<unknown>
}
