import {
  CALLBACK_PATH,
  parseWebhooksConfig,
  parseTickBudget,
  DEFAULT_TICK_BUDGET,
  TickBudget,
  countFetch,
  sendWebhooks,
  GMAIL_SYNC_CRON,
  RAIL_CRON,
  railTick,
  dispatchWebhooks,
  googleRecording,
  SCOPE_POLICY,
  createApp,
  createProfileCache,
  createGoogleKeyCache,
  createVibaseRegistry,
  parseGmailConfig,
  parsePushConfig,
  renewWatches,
  handleFormIngress,
  siteverifyVerifier,
  discoveryResponse,
  openApiPath,
  createBetterAuthAdapter,
  createWorkspaceAuthAdapter,
  approvalBound,
  defaultGrantScopes,
  grantableScopes,
  logEmailFailure,
  membershipRoleReader,
  parseCliClientId,
  parseOriginList,
  originMatches,
  parsePublishableKey,
  passwordResetMessage,
  passwordResetUrl,
  r2ObjectStore,
  requestDueSyncs,
  runGmailSyncWorkflow,
  workerdStreams,
  workspaceRole,
  type ApiKeyControlRuntime,
  type ApprovalBound,
  type AuditRuntime,
  type AuthAdapter,
  type InvitationsRuntime,
  type OAuthClientsRuntime,
  type MembersRuntime,
  type GmailSyncInstances,
  type GmailSyncParams,
  type GmailSyncRuntime,
  type GmailSyncSummary,
  type ObjectStore,
  type R2BucketLike,
  type RateLimiter,
  type AnyResource,
  type ExtendDeclarations,
  createBuiltIns,
  type Registry,
  type StreamPrimitives,
  type TransportRegistry,
  type WorkflowEventLike,
  type WorkflowStepLike,
} from '@vibase/api'
import { uuidv7, type D1Binding } from '@vibase/storage'
import {
  MIGRATIONS,
  controlAuthDatabase,
  d1Binding,
  openControlDb,
  readAuthJwks,
  readAuthProfile,
  readControlMarker,
  readOAuthClientName,
  readOAuthClientBound,
  acceptInvitation,
  findAdoptableInvitation,
  findLiveInvitationByToken,
  recordResetLinkIssued,
  revokeSubjectCredentials,
  hasLiveInvitationForToken,
  createInvitation,
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClient,
  listOAuthClients,
  updateOAuthClient,
  listControlAudit,
  listInvitations,
  revokeInvitation,
  readControlMigrations,
  webhookStore,
  apiKeyStore,
  readMigrationState,
  runAuthSweep,
  type ControlDb,
  type D1Like,
  type MigrationStatus,
} from '@vibase/storage-d1'
import { readDeployment } from './init-deployment.js'
import { countCalls, countD1 } from './count-d1.js'
import { serveStatic, type AssetsLike } from './static-serving.js'
import { SCHEMA_INVALID, schemaFileHealth, type AttachedSchemaFile } from './schema-file-module.js'
import { gmailTransport } from '@vibase/api'
import {
  AUTH_SERVER_METADATA_PATH,
  CLI_CLIENT_ID,
  createAuth,
  registrationScopes,
  resourcesFor,
  type AuthRuntimeConfig,
  type AuthService,
} from '@vibase/auth'
import { parseBuiltInAuthConfig } from './auth-config.js'
import { invitationAdmission } from './invitation-admission.js'
import { cloudflareEmailSender, parseEmailConfig, type EmailBindingLike } from './email.js'

export interface D1WorkerEnv {
  DB: D1Like
  /**
   * The control-plane database ([[CORE259]] D1): its own compiled migrations and tracker, Better Auth composed on it. Required in every auth mode ([[CORE326]] P1): a missing
   * binding is `500 internal`. Only this composition reads it (D5); the operations receive `DB` alone.
   */
  CONTROL_DB?: D1Like
  AUTH_PROVIDER?: string
  /** `AUTH_PROVIDER=better-auth` only ([[CORE248]] D2): the `send_email` binding (Cloudflare Email Service). With `AUTH_EMAIL_FROM` turns email on; one without the other is a configuration error. */
  EMAIL?: EmailBindingLike
  /** `AUTH_PROVIDER=better-auth` only ([[CORE248]] D2): the sender address on the onboarded domain; required with `EMAIL`. */
  AUTH_EMAIL_FROM?: string
  /** `AUTH_PROVIDER=better-auth` only ([[CORE243]] D6): a Worker secret, at least 32 characters; Better Auth signs cookies and encrypts its signing key with it. */
  AUTH_SECRET?: string
  /** `AUTH_PROVIDER=better-auth` only ([[CORE294]] D7): a Google client for sign-in; both or neither (half is a configuration error). Absent, the Gmail pair (`GOOGLE_CLIENT_*`) is used when complete, else Google sign-in is off. */
  AUTH_GOOGLE_CLIENT_ID?: string
  AUTH_GOOGLE_CLIENT_SECRET?: string
  CLERK_ISSUER?: string
  CLERK_AUTHORIZED_PARTIES?: string
  CLERK_SECRET_KEY?: string
  CLERK_JWT_KEY?: string
  /** Not read on D1 ([[CORE64]] D24): there is no webhook. Kept so an old `.dev.vars` still type-checks. */
  CLERK_WEBHOOK_SECRET?: string
  /** [[API7]] D24: the per-minute invocation's budget of D1 queries plus outbound fetches; an integer 50..1000, default 50 (Workers Free). A bad value runs at 50 and is warned about by name. */
  CRON_TICK_BUDGET?: string
  /** The session-token claim holding the workspace role; default `vibase_role` ([[CORE64]] D8). */
  AUTH_ROLE_CLAIM?: string
  /** The first-party CLI's public OAuth client id ([[CORE77]] D14, D16); optional. Set but blank is a configuration error. */
  AUTH_CLI_CLIENT_ID?: string
  /** The Clerk publishable key, public ([[UI30]] D5): returned by discovery for the connect page; its Frontend API host must be `CLERK_ISSUER`'s. */
  CLERK_PUBLISHABLE_KEY?: string
  CLERK_API_URL?: string
  CORS_ALLOWED_ORIGINS?: string
  /** [[UI255]] D6: comma-separated first-party app origins (better-auth only): trusted by Better Auth and given credentialed CORS on `/auth/*`. */
  AUTH_TRUSTED_ORIGINS?: string
  /** The deployed commit, set by `deploy:remote` (`--var VERSION:<sha>`); `/health` reports it, `dev` when absent. */
  VERSION?: string
  /** The deployed source commit (`--var COMMIT:<sha>`, [[OPS210]] D7); `/health` reports it, `dev` when absent. */
  COMMIT?: string
  /**
   * The Gmail connect surface ([[CHN5]] D58): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET` and `CREDENTIALS_KEY` (base64 of 32 bytes)
   * must all be set for it to be on; `CREDENTIALS_KEY_VERSION` (default 1), `PUBLIC_BASE_URL` (the redirect URI's base; unset: the request's origin)
   * and `CONNECT_RETURN_URL` (unset: the instance's own `/app/accounts` when the app is served, else a built-in result page) are optional. The three secrets are Worker secrets, never printed.
   */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  OAUTH_STATE_SECRET?: string
  CREDENTIALS_KEY?: string
  CREDENTIALS_KEY_VERSION?: string
  /** [[API7]] D13: `true` admits `http://` and loopback webhook targets. Local development and the local E2E only; never in a deployed env's `vars`. */
  WEBHOOK_ALLOW_INSECURE_URLS?: string
  PUBLIC_BASE_URL?: string
  CONNECT_RETURN_URL?: string
  /**
   * Gmail push ([[CHN5]] D87): `GMAIL_TOPIC_NAME` (`projects/<p>/topics/<t>`), `GMAIL_PUSH_SUBSCRIPTION` (`projects/<p>/subscriptions/<s>`), `GMAIL_PUSH_SERVICE_ACCOUNT` (the
   * email Pub/Sub signs its token as) and `PUBLIC_BASE_URL` (the endpoint's origin; `https`) must all be set, with Gmail and the `GMAIL_SYNC` binding, for push to be on.
   * Public values, vars rather than secrets. Partly set: push is off and a startup line names the missing ones.
   */
  GMAIL_TOPIC_NAME?: string
  GMAIL_PUSH_SUBSCRIPTION?: string
  GMAIL_PUSH_SERVICE_ACCOUNT?: string
  /** The R2 bucket of message bodies and file bytes ([[CORE58]] P12). Absent: the two content routes answer `503 objects_unavailable`. */
  BODIES?: R2BucketLike
  /** Workers Static Assets: the built pages (the app at `/app/<page>`, the auth pages) and their files under `/assets/`. Absent: those paths and `/` answer 404. */
  ASSETS?: AssetsLike
  /**
   * The Google recorder's switch ([[CHN5]] D78, [[CHN153]]): an ISO-8601 UTC instant at most 7 days ahead. While the clock is before it, redacted Gmail and token-endpoint
   * exchanges are written to `BODIES` under `_recordings/`. Absent, past, malformed or too far ahead: off (the last two logged by name). A var or a secret; never committed with a value.
   */
  GOOGLE_RECORDING_UNTIL?: string
  /** [[CHN432]] D6: the Turnstile secret for the public form route (a Worker secret). Absent or empty: the route answers `503 challenge_unavailable` and makes no request. */
  TURNSTILE_SECRET_KEY?: string
  /** [[CHN432]] D7: the `ratelimits` bindings of the form route (per IP and form: 10 per 60 s; per form: 60 per 60 s). Absent: that limit is skipped. */
  FORM_IP_LIMITER?: RateLimiter
  FORM_LIMITER?: RateLimiter
  /** The `GmailSyncWorkflow` binding ([[CHN141]] D34). Absent: `connections.sync` answers 501, connect requests no sync, the cron skips Gmail work. */
  GMAIL_SYNC?: GmailSyncInstances
}

/** What the runtime hands `fetch` besides the request: only `waitUntil` is used ([[AGT8]] D49). */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

/** What the runtime hands `scheduled` (Cloudflare's `ScheduledController`, reduced to what is read). */
export interface ScheduledControllerLike {
  cron: string
  scheduledTime?: number
}

/** The 503 body of every route but /health and the two OpenAPI documents while the deployment marker is absent. */
export const NOT_INITIALISED = { error: { code: 'not_initialised', message: 'run the bootstrap CLI first' } }
/** The 503 body of every route but /health and the two OpenAPI documents while the database lacks a migration this build expects ([[CORE61]] D4). */
export const MIGRATIONS_PENDING = {
  error: { code: 'migrations_pending', message: 'apply the database migrations first' },
}
/** While `behind` or `unknown` the tracker is re-read at most this often ([[CORE61]] D6). */
export const MIGRATION_REREAD_MS = 5_000
const EXPECTED = MIGRATIONS.map((m) => m.name)
const INTERNAL = { error: { code: 'internal', message: 'internal error' } }
const NO_SUCH_ROUTE = { error: { code: 'not_found', message: 'no such route' } }

/** The binding of the pre-initialisation app: it serves the OpenAPI document only, and a unit reaching it is a defect. */
const NO_UNITS: D1Binding = {
  kind: 'd1',
  runtime: {
    dialect: 'd1',
    maxSetSize: 0,
    execute: () => Promise.reject(new Error('the deployment is not initialised: no unit may run')),
  },
  organizationId: '',
  authProvider: '',
  authOrgId: '',
}

/** [[CHN432]]: the object store of a Worker without the `BODIES` bucket: a form submission cannot be stored, so the handler answers its `503 temporarily_unavailable`. */
const NO_OBJECTS: ObjectStore = {
  put: () => Promise.reject(new Error('the BODIES bucket is missing')),
  putStream: () => Promise.reject(new Error('the BODIES bucket is missing')),
  get: () => Promise.reject(new Error('the BODIES bucket is missing')),
  delete: () => Promise.reject(new Error('the BODIES bucket is missing')),
}
/** [[CHN432]] D1 (432.2): `/f/<one non-empty segment>` is the public form route; `/f` and every deeper path are no route. */
const FORM_ROUTE = /^\/f\/([^/]+)$/

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const STRING_VARS = [
  'AUTH_PROVIDER',
  'AUTH_SECRET',
  'AUTH_GOOGLE_CLIENT_ID',
  'AUTH_GOOGLE_CLIENT_SECRET',
  'AUTH_EMAIL_FROM',
  'CLERK_ISSUER',
  'CLERK_AUTHORIZED_PARTIES',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_KEY',
  'AUTH_ROLE_CLAIM',
  'AUTH_CLI_CLIENT_ID',
  'CLERK_PUBLISHABLE_KEY',
  'CLERK_API_URL',
  'CORS_ALLOWED_ORIGINS',
  'AUTH_TRUSTED_ORIGINS',
  'VERSION',
  'COMMIT',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_STATE_SECRET',
  'CREDENTIALS_KEY',
  'CREDENTIALS_KEY_VERSION',
  'PUBLIC_BASE_URL',
  'CONNECT_RETURN_URL',
  'GOOGLE_RECORDING_UNTIL',
  'GMAIL_TOPIC_NAME',
  'GMAIL_PUSH_SUBSCRIPTION',
  'GMAIL_PUSH_SERVICE_ACCOUNT',
  'WEBHOOK_ALLOW_INSECURE_URLS',
  'CRON_TICK_BUDGET',
] as const

/**
 * [[UI255]] D7: the request headers a credentialed preflight on `/auth/*` allows. Pinned by a test from what a real `better-auth/client` sends (get-session, sign-in, sign-out, token): only the JSON content type
 * is not CORS-safelisted.
 */
export const AUTH_CORS_ALLOW_HEADERS = 'Content-Type'
const AUTH_CORS_METHODS = 'GET, POST'

/** [[UI255]] D7: a copy of `res` with the credentialed CORS headers for one trusted app origin (`Vary: Origin` added to any existing `Vary`). */
function withAuthCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.append('vary', 'Origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

const OAUTH_REGISTER_PATH = '/auth/oauth2/register'
const OAUTH_TOKEN_PATH = '/auth/oauth2/token'
/** [[CORE673]] P3: the consent page's same-origin read of what the signed-in account may approve; served beside the library's routes, behind the same gates, authenticated by its session cookie. Not a registry operation. */
const CONSENT_BOUND_PATH = '/auth/consent-bound'

/** [[API622]] D6, D9: a copy of `res` with the credential-free CORS answer for a bearer app origin. `set` replaces any `Access-Control-Allow-Origin` (never two); the plugin's other headers (Expose-Headers) are kept. */
function withBearerCors(res: Response, origin: string): Response {
  const headers = new Headers(res.headers)
  headers.set('access-control-allow-origin', origin)
  headers.append('vary', 'Origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * The composition of the open D1 Worker ([[CORE38]] P5), built once per isolate. The deployment marker drives the storage
 * binding (a missing `deployment` table counts as absent): while it is absent every route but `/health` and the two OpenAPI documents is `503 not_initialised`, and an absent marker is
 * never cached, so a bootstrap run after an earlier 503 is picked up by the next request. A bad auth or CORS configuration
 * fails closed: every non-health request is `500 internal`, logged once with the variable's name and never its value.
 * A database `behind` the build's migration manifest answers every other route `503 migrations_pending`, ahead of the marker and
 * auth checks ([[CORE61]] D4). `deps` exists for Node tests; the Worker passes none.
 */
export function composeD1Worker(
  env: D1WorkerEnv,
  deps: {
    fetch?: typeof fetch /** Node tests only ([[AGT8]] D52): operations registered before the queue's, and the transports the runner resolves. The Worker passes neither. */
    operations?: (registry: Registry) => void
    /**
     * [[CORE315]] D23: the custom objects' definitions (`defineCustomObject`), ONE dependency handed to every registry this composition builds: the app's, the rail's and the one that lists the declared scopes. Nothing in production passes
     * any yet (the schema file is attached by T4, #543): the Worker's entry builds none.
     */
    definitions?: readonly AnyResource[]
    /**
     * [[CORE559]] P1: the validated `extend` of the schema file ([[CORE555]]'s validator output), ONE dependency handed to every registry this composition builds, like `definitions`. The Worker's entry passes the attached
     * file's `extend` ([[CORE561]]); a composition with none serves the built-ins as before.
     */
    extend?: ExtendDeclarations
    /**
     * [[CORE543]] D28, D29: the attached schema file as the entry read it. An invalid one answers every route but `/health` `503 schema_invalid`; `/health` reports its digest either way. Its `definitions` are passed in
     * `definitions` above (the entry owns that step, so this composition's many test callers do not change).
     */
    schemaFile?: AttachedSchemaFile
    transports?: TransportRegistry /** Node tests only: workerd's stream primitives are absent there. */
    streams?: StreamPrimitives
    clock?: () => Date
    newId?: () => string /** Milliseconds for the migration-state re-read window; defaults to `Date.now`. */
    nowMs?: () => number
    /**
     * Schedules work past the response ([[CORE304]] D4): the self-service reset send. The Worker entry supplies `cloudflare:workers`' `waitUntil`, Node tests a recorder. Absent, the send simply runs unawaited.
     * Never awaited by the caller, so a send's latency stays out of the answer.
     */
    waitUntil?: (promise: Promise<unknown>) => void
  } = {},
): {
  fetch(req: Request, ctx?: ExecutionContextLike): Promise<Response>
  scheduled(controller: ScheduledControllerLike): Promise<void>
  runGmailSyncWorkflow(event: WorkflowEventLike<GmailSyncParams>, step: WorkflowStepLike): Promise<GmailSyncSummary>
} {
  const vars: Record<string, string | undefined> = {}
  for (const name of STRING_VARS) vars[name] = typeof env[name] === 'string' ? env[name] : undefined

  let authAdapter: AuthAdapter | undefined
  let corsOrigins: readonly string[] = []
  let cliClientId: string | undefined
  let publishableKey: string | undefined
  let configError = false
  // [[CORE243]] D1: Better Auth is mounted at /auth only for this provider; its configuration is read for no other.
  const builtIn = vars.AUTH_PROVIDER?.trim() === 'better-auth'
  let builtInConfig: AuthRuntimeConfig | undefined
  let emailFrom: string | undefined
  let builtInService: AuthService | undefined
  // [[CORE259]] D5: the control handle is opened here, once, and goes to the auth provider and the control gate below; nothing else is handed it.
  const control: ControlDb | undefined = env.CONTROL_DB ? openControlDb(env.CONTROL_DB) : undefined
  try {
    // [[CORE259]] D6, [[CORE326]] P1: every instance, whatever `AUTH_PROVIDER`, has a control-plane database; without the binding the Worker fails closed like a bad variable (the message names the binding).
    if (!control) throw new Error('the CONTROL_DB binding (the control-plane database) is required in every auth mode')
    if (builtIn) builtInConfig = parseBuiltInAuthConfig(vars)
    // [[CORE248]] D2: read for the built-in provider only; half a pair or a malformed address fails closed like every auth variable.
    if (builtIn) emailFrom = parseEmailConfig({ EMAIL: env.EMAIL, AUTH_EMAIL_FROM: vars.AUTH_EMAIL_FROM })?.from
    authAdapter = createWorkspaceAuthAdapter(vars, { fetch: deps.fetch, now: deps.clock })
    // [[CORE244]] D8, D9, D23: the built-in provider's tokens are verified in-process against the provider's published signing keys; the issuer and audience come from `PUBLIC_BASE_URL`, never a request. The reads go
    // through the control store (the one place besides this composition that holds the handle, [[CORE259]] D5).
    if (builtIn && builtInConfig && control) {
      authAdapter = createBetterAuthAdapter({
        issuer: `${builtInConfig.baseURL}/auth`,
        // [[CORE283]] P1: the API origin and the MCP endpoint's URI are both this Worker.
        audience: resourcesFor(builtInConfig.baseURL),
        readKeys: () => readAuthJwks(control),
        readProfile: (subject) => readAuthProfile(control, subject),
        readClientName: (clientId) => readOAuthClientName(control, clientId),
        // [[CORE639]] D5: the live client read the authenticator caches for 60 s.
        readClient: (clientId) => readOAuthClientBound(control, clientId),
        now: deps.clock,
      })
    }
    // [[CORE244]] P3: the first-party CLI's client id defaults to `vibase-cli` on the built-in provider (the row itself is seeded by [[CORE283]]).
    cliClientId = parseCliClientId(vars) ?? (builtIn ? 'vibase-cli' : undefined)
    // Only with a provider: without one the key is ignored and discovery has no auth to put it in. The built-in provider has no publishable key, and its discovery is [[CORE283]]'s.
    if (authAdapter && !builtIn) publishableKey = parsePublishableKey(vars)
    corsOrigins = parseOriginList(vars.CORS_ALLOWED_ORIGINS, 'CORS_ALLOWED_ORIGINS', { allowWildcard: true })
  } catch (err) {
    // The message names a variable ("AUTH_PROVIDER=clerk requires CLERK_JWT_KEY"); no adapter message carries a value.
    configError = true
    console.error(`[d1-worker] invalid auth configuration: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  // [[CHN5]] D58: parsed once; the app logs what is missing or malformed (names only) and gates the Gmail surface on it.
  const gmail = parseGmailConfig(vars)
  // [[API7]] D12, D13: read from `CREDENTIALS_KEY` on its own, so webhooks do not depend on the Google variables above.
  const parsedWebhooks = parseWebhooksConfig(vars)
  // [[CORE337]] P5: the subscriptions, their dispatch and the sender run on the control store; the port is the one handle composition gives the API package.
  const webhooks = {
    ...parsedWebhooks,
    runtime: { ...parsedWebhooks.runtime, port: control ? webhookStore(control) : null },
  }
  // [[CHN5]] D87: push is judged once, by the parser `setup:remote` shares. It is ON only with Gmail and the GMAIL_SYNC binding too; the app logs why when it is not.
  const pushParsed = parsePushConfig(vars)
  const pushOn = gmail.config !== null && env.GMAIL_SYNC !== undefined && pushParsed.config !== null

  const clock = deps.clock ?? (() => new Date())
  // [[AGT8]] D52/D70: the real Gmail transport is shared by waitUntil and cron; test transports only arrive through `deps`.
  const transportsFor = (
    binding: D1Binding,
    counted?: { fetch: typeof fetch; bodies: R2BucketLike; instances: GmailSyncInstances | undefined },
  ): TransportRegistry => {
    if (deps.transports) return deps.transports
    if (!gmail.config || !env.BODIES) return {}
    const instances = counted ? counted.instances : env.GMAIL_SYNC
    return {
      gmail: gmailTransport({
        binding,
        organizationId: binding.organizationId,
        config: gmail.config,
        objects: r2ObjectStore(counted ? counted.bodies : env.BODIES),
        clock,
        newId: deps.newId ?? (() => uuidv7(clock())),
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        ...((counted?.fetch ?? deps.fetch) ? { fetch: (counted?.fetch ?? deps.fetch)! } : {}),
        ...(instances ? { instances } : {}),
      }),
    }
  }
  // [[CHN5]] D78: parsed once (a bad value is logged by name, never by value). Off, `fetchFor` hands back `deps.fetch` itself, so nothing is wrapped.
  const recording = googleRecording({ raw: vars.GOOGLE_RECORDING_UNTIL, bucket: env.BODIES, clock, plain: deps.fetch })

  type App = ReturnType<typeof createApp>
  let app: App | undefined
  let cold: App | undefined
  let appBinding: D1Binding | undefined

  // [[CORE64]] D21, D22: the documents read configuration only; built once. A bad configuration (below) still answers 500.
  const discovery = {
    provider: builtIn
      ? builtInConfig && authAdapter
        ? {
            name: 'better-auth' as const,
            issuer: `${builtInConfig.baseURL}/auth`,
            baseUrl: builtInConfig.baseURL,
            signInMethods: builtInConfig.google ? (['password', 'google'] as const) : (['password'] as const),
            // [[CORE304]] D2: self-service reset exists exactly when email is on.
            selfServiceReset: emailFrom !== undefined,
          }
        : undefined
      : authAdapter
        ? { name: 'clerk' as const, issuer: vars.CLERK_ISSUER!.trim() }
        : undefined,
    cliClientId,
    publishableKey,
    declaredScopes: createVibaseRegistry({
      ...(deps.definitions ? { definitions: deps.definitions } : {}),
      ...(deps.extend ? { extend: deps.extend } : {}),
    }).declaredScopes(),
  }

  const nowMs = deps.nowMs ?? (() => Date.now())
  type Migrations = { status: MigrationStatus; applied: string[] }
  let settled: Migrations | undefined
  let latest: (Migrations & { at: number }) | undefined

  /**
   * The migration state ([[CORE61]] D6): remembered for the isolate once `current` or `ahead`; while `behind` or `unknown` it is
   * re-read at most every 5 s; a read that threw is never remembered, so the next request reads again.
   */
  async function migrations(db: D1Like = env.DB): Promise<Migrations> {
    if (settled) return settled
    const now = nowMs()
    if (latest && now - latest.at < MIGRATION_REREAD_MS) return latest
    const read = await readMigrationState(db, EXPECTED)
    const state = { status: read.status, applied: read.applied }
    if (state.status === 'current' || state.status === 'ahead') settled = state
    latest = read.readFailed ? undefined : { ...state, at: now }
    return state
  }

  /**
   * The control plane's migration state ([[CORE259]] D4, D6): the same per-isolate memory as the CRM database's (`current` or `ahead` is remembered; `behind` or `unknown` is re-read at most every
   * 5 s; a failed read is not remembered). Unlike the CRM gate, an `unknown` tracker (no `d1_migrations`: nobody has applied the control migrations) refuses too: an unmigrated control
   * plane has no `control_deployment` and no auth tables, and a real database always has the tracker (wrangler creates it).
   */
  let controlSettled: boolean | undefined
  let controlLatest: { at: number; ok: boolean } | undefined
  async function controlMigrated(c: ControlDb): Promise<boolean> {
    if (controlSettled) return true
    const now = nowMs()
    if (controlLatest && now - controlLatest.at < MIGRATION_REREAD_MS) return controlLatest.ok
    const read = await readControlMigrations(c)
    const ok = read.status === 'current' || read.status === 'ahead'
    if (ok) controlSettled = true
    controlLatest = read.readFailed ? undefined : { at: now, ok }
    return ok
  }
  /**
   * The control gate, every auth mode ([[CORE259]] D6, D7, [[CORE326]] P1): `503 migrations_pending` while the control migrations are behind, `503 not_initialised` while the CRM database has no
   * marker to pair with, `500 internal` (log `control database not paired`) when the control marker is missing or names another organisation. A pairing that held is remembered for the isolate (the
   * marker is written once and never changes); a refusal is never cached, so bootstrap's marker is picked up by the next request. `undefined` means go on.
   */
  let paired = false
  type ControlCondition = 'ok' | 'migrations_pending' | 'not_initialised' | 'not_paired'
  /**
   * The conditions the control gate judges, as a reason ([[CORE337]] P2 reuses them for the tick): `c` and `crm` are the handles to ask through (the tick passes its counted ones, so every query counts
   * against its budget). A pairing that held is remembered and costs no query.
   */
  async function controlCondition(c: ControlDb, crm: D1Like): Promise<ControlCondition> {
    if (paired) return 'ok'
    if (!(await controlMigrated(c))) return 'migrations_pending'
    let link
    try {
      link = await readDeployment(crm)
    } catch (err) {
      if (/no such table/i.test(err instanceof Error ? err.message : '')) return 'not_initialised'
      throw err
    }
    if (!link) return 'not_initialised'
    const marker = await readControlMarker(c)
    if (!marker || marker.organizationId !== link.organizationId) return 'not_paired'
    paired = true
    return 'ok'
  }
  async function controlGate(): Promise<Response | undefined> {
    if (!control || paired) return undefined
    const why = await controlCondition(control, env.DB)
    if (why === 'migrations_pending') return json(MIGRATIONS_PENDING, 503)
    if (why === 'not_initialised') return json(NOT_INITIALISED, 503)
    if (why === 'not_paired') {
      console.error('[d1-worker] control database not paired: its marker is missing or names another organisation')
      return json(INTERNAL, 500)
    }
    return undefined
  }

  async function approvalBoundOf(subject: string): Promise<ApprovalBound> {
    const link = await readDeployment(env.DB)
    if (!link) throw new Error('the deployment is not initialised')
    return approvalBound(
      d1Binding(env.DB, link),
      { provider: 'better-auth', subject, organizationId: link.organizationId },
      dcrScopeInputs.grantableScopes,
      discovery.declaredScopes,
    )
  }
  /** [[CORE673]] P3: `{ kind, scopes }` of the session's account, the one function the consent hook calls (`approvalBoundOf`). `401` with no session (nothing is read); a failing read is `500`, never a partial list. */
  async function consentBound(req: Request): Promise<Response> {
    try {
      const subject = await builtInAuth().sessionSubject(req.headers)
      if (subject === null) return json({ error: { code: 'unauthorized', message: 'sign in first' } }, 401)
      const res = json(await approvalBoundOf(subject), 200)
      res.headers.set('cache-control', 'no-store')
      return res
    } catch (err) {
      console.error('[consent-bound]', err instanceof Error ? err.name : 'error')
      return json(INTERNAL, 500)
    }
  }
  /** The app bound to the marker, once the marker exists. Only success is cached. A missing marker table is an absent marker. */
  /**
   * The built-in provider ([[CORE259]] D3: composed on the control-plane database, never on `DB`), built once per isolate: the `/auth` handler and the in-process reset-link issue share one instance.
   * [[CORE287]]: the gate and acceptance. The port is the only way the auth package reaches the vault; the CRM binding is resolved per call from the deployment row. Only called once `builtInConfig` and `control` exist.
   */
  function builtInAuth(): AuthService {
    builtInService ??= createAuth(
      controlAuthDatabase(control!),
      {
        ...builtInConfig!,
        ...dcrScopeInputs,
      },
      {
        // OPS252: the request that builds the provider stays alive until its initialisation settles (see `keepAlive`).
        ...(deps.waitUntil ? { keepAlive: deps.waitUntil } : {}),
        // [[CORE304]] D4: with email on, a reset requested over HTTP is built into the reset message and SCHEDULED (never awaited: the answer's timing must not reveal whether the address has an account). A failure is
        // logged by event name and error code only (P2). Owner-issued links never reach here (P1).
        ...(emailFrom !== undefined && env.EMAIL
          ? {
              deliverResetToken: ({ email, token }: { email: string; token: string }) => {
                const sender = cloudflareEmailSender(env.EMAIL!, emailFrom!)
                const send = Promise.resolve()
                  .then(() =>
                    sender.send({
                      to: email,
                      ...passwordResetMessage({
                        host: new URL(builtInConfig!.baseURL).host,
                        url: passwordResetUrl(builtInConfig!.baseURL, token),
                      }),
                    }),
                  )
                  .catch((err: unknown) => logEmailFailure('password_reset_send_failed', err))
                if (deps.waitUntil) deps.waitUntil(send)
              },
            }
          : {}),
        admission: invitationAdmission({
          store: {
            hasLive: (a) => hasLiveInvitationForToken(control!, a),
            findAdoptable: (a) => findAdoptableInvitation(control!, a),
            findLiveByToken: (a) => findLiveInvitationByToken(control!, a),
            accept: (a) => acceptInvitation(control!, a),
          },
          crm: async () => {
            const link = await readDeployment(env.DB)
            if (!link) throw new Error('the deployment is not initialised')
            return d1Binding(env.DB, link)
          },
          clock,
          newId,
        }),
        // [[CORE577]] D10, P3: the OAuth client endpoints are the owners'; the role is the live membership of the session's subject, read from the CRM database on each call (no cache, like every role re-check).
        clientOwner: async (subject) => {
          const link = await readDeployment(env.DB)
          if (!link) return false
          return (await membershipRoleReader(d1Binding(env.DB, link), 'better-auth')(subject)) === 'owner'
        },
        // [[CORE673]] ([[CORE666]] D11, generalising [[CORE662]]): what the signed-in account may approve, the one read the consent hook and `GET /auth/consent-bound` share (closed on a failing read: the auth package refuses the approval).
        approvalBound: approvalBoundOf,
      },
    )
    return builtInService
  }

  // [[CORE627]] D10: the one set of inputs Better Auth derives its dynamic-registration ceiling and defaults from (`registrationScopes`); the first-party client operations take the same value, not a recomputation.
  const dcrScopeInputs = {
    vaultScopes: discovery.declaredScopes,
    grantableScopes: grantableScopes(discovery.declaredScopes),
    defaultScopes: defaultGrantScopes(discovery.declaredScopes),
  }
  // [[CORE627]] D2, D10: the first-party OAuth client operations' port over the control store; Better Auth only (the Postgres server and Clerk hand none and answer 501).
  const oauthClients: OAuthClientsRuntime | null =
    control && builtInConfig
      ? (() => {
          const reg = registrationScopes(
            dcrScopeInputs.vaultScopes,
            dcrScopeInputs.grantableScopes,
            dcrScopeInputs.defaultScopes,
          )
          return {
            port: {
              create: (a) => createOAuthClient(control, a),
              list: (a) => listOAuthClients(control, a),
              get: (a) => getOAuthClient(control, a),
              delete: (a) => deleteOAuthClient(control, a),
              update: (a) => updateOAuthClient(control, a),
            },
            allowedScopes: reg.allowed,
            resources: resourcesFor(builtInConfig.baseURL),
            // [[CORE628]] P1: the list the REST app gets, not a second parse; the warning reads no other.
            corsOrigins,
            apiOrigin: new URL(builtInConfig.baseURL).origin,
          }
        })()
      : null
  // [[CORE245]] P2: the invitation operations' port over the control store, needs `builtInConfig` (Better Auth, [[CORE326]] P3); `control` itself exists in every mode; `PUBLIC_BASE_URL` names the invitation URL's origin.
  const invitations: InvitationsRuntime | null =
    control && builtInConfig
      ? {
          port: {
            create: (a) => createInvitation(control, a),
            list: (a) => listInvitations(control, a),
            revoke: (a) => revokeInvitation(control, a),
          },
          publicBaseUrl: builtInConfig.baseURL,
          ...(emailFrom !== undefined && env.EMAIL ? { email: cloudflareEmailSender(env.EMAIL, emailFrom) } : {}),
        }
      : null
  // [[CORE288]] P5, P6: the membership writes' port over the control store and the built-in provider; the reset URL's origin is `PUBLIC_BASE_URL`.
  const members: MembersRuntime | null =
    control && builtInConfig
      ? {
          port: {
            revokeCredentials: (a) => revokeSubjectCredentials(control, a),
            issueResetLink: async (a) => {
              const issued = await builtInAuth().issueResetToken(a.email)
              if (!issued) return null
              const expiresAt = issued.expiresAt.toISOString()
              // The audit row comes before the answer: a link nobody can account for is never returned. A failure here leaves an unreturned verification row, inert until it expires.
              await recordResetLinkIssued(control, {
                auditId: a.auditId,
                actorId: a.actorId,
                subject: a.subject,
                expiresAt,
                now: a.now,
              })
              return { token: issued.token, expiresAt }
            },
          },
          publicBaseUrl: builtInConfig.baseURL,
        }
      : null
  // [[CORE261]] P1: the audit log's read port over the control store, on every D1 composition ([[CORE326]] P3).
  const audit: AuditRuntime | null = control ? { port: { list: (a) => listControlAudit(control, a) } } : null
  // [[CORE350]] P5: API keys are looked up in the control plane only ([[CORE329]]); the port is the one handle composition gives the API package for them.
  // [[CORE351]] P5: the same store serves the four `api_keys.*` operations.
  const apiKeys: ApiKeyControlRuntime | null = control
    ? (() => {
        const store = apiKeyStore(control)
        return { port: store, store }
      })()
    : null
  // [[CORE577]] D21: ONE Google key cache for this Worker (an isolate), whichever app serves a request: the recorder's per-request apps share it. It fetches the keys plainly, never through the recorder.
  const googleKeys = createGoogleKeyCache({ fetch: deps.fetch ?? ((input, init) => fetch(input, init)), now: clock })
  const buildApp = (binding: D1Binding, googleFetch: typeof fetch | undefined): App =>
    createApp({
      storage: () => binding,
      invitations,
      oauthClients,
      members,
      audit,
      apiKeys,
      workspace: { adapter: authAdapter, cliClientId },
      gmail: {
        // [[CORE572]] P2: the callback's session mode is named per auth provider, never inferred. Better Auth: the browser must hold the starter's live session (the reader is Better Auth's own lookup over `CONTROL_DB`).
        // Clerk and none: state-only (D9, an accepted gap: there is no same-origin session to read).
        session: builtIn
          ? { mode: 'better-auth', read: (headers) => builtInAuth().sessionSubject(headers) }
          : { mode: 'state-only' },
        ...(builtIn ? { roleOf: membershipRoleReader(binding, 'better-auth') } : {}),
        config: gmail.config,
        problems: gmail.problems,
        // [[UI469]] D5: with the app served, an unset CONNECT_RETURN_URL returns the connect flow to the instance's own Connected accounts page.
        ...(env.ASSETS ? { defaultReturnPath: '/app/accounts' } : {}),
        push: pushParsed.config,
        pushProblems: pushParsed.problems,
        ...(googleFetch ? { fetch: googleFetch } : {}),
        keys: googleKeys,
        ...(env.GMAIL_SYNC ? { instances: env.GMAIL_SYNC } : {}),
      },
      webhooks,
      corsOrigins,
      version: vars.VERSION || 'dev',
      clock: deps.clock,
      newId: deps.newId,
      objects: env.BODIES ? r2ObjectStore(env.BODIES) : undefined,
      executions: { transports: transportsFor(binding) },
      ...(deps.operations ? { extraOperations: deps.operations } : {}),
      ...(deps.definitions ? { definitions: deps.definitions } : {}),
      ...(deps.extend ? { extend: deps.extend } : {}),
    })

  async function ensure(): Promise<App | undefined> {
    if (app) return app
    let link
    try {
      link = await readDeployment(env.DB)
    } catch (err) {
      if (/no such table/i.test(err instanceof Error ? err.message : '')) return undefined
      throw err
    }
    if (!link) return undefined
    const binding = d1Binding(env.DB, link)
    app = buildApp(binding, deps.fetch)
    appBinding = binding
    return app
  }
  const newId = deps.newId ?? (() => uuidv7(clock()))
  const profiles = authAdapter ? createProfileCache(authAdapter) : null

  /** The database, once it is initialised and not behind ([[CHN5]] D37): null otherwise, with the reason in `why`. */
  async function syncBinding(
    db: D1Like = env.DB,
  ): Promise<{ binding: D1Binding; organizationId: string } | { why: string }> {
    let link
    try {
      link = await readDeployment(db)
    } catch (err) {
      if (/no such table/i.test(err instanceof Error ? err.message : ''))
        return { why: 'the deployment is not initialised' }
      throw err
    }
    if (!link) return { why: 'the deployment is not initialised' }
    if ((await migrations(db)).status === 'behind') return { why: 'the database is behind its migrations' }
    return { binding: d1Binding(db, link), organizationId: link.organizationId }
  }

  /** [[CORE559]] P2: the built-ins composed with the deployment's `extend` (undefined when it has none), created once per composition; the Gmail sync runtime and the form ingress context receive it so their contact events carry the extension fields. */
  const builtIns = deps.extend ? createBuiltIns(deps.extend) : undefined

  /** Re-resolved by every Workflow step ([[CHN5]] D11): nothing here is ever returned from a step. Throws (retryably) when the deployment cannot sync. */
  async function gmailSyncRuntime(googleFetch: typeof fetch | undefined): Promise<GmailSyncRuntime> {
    if (!gmail.config) throw new Error('Gmail is not configured on this deployment')
    if (!env.GMAIL_SYNC) throw new Error('the GMAIL_SYNC Workflow binding is missing')
    if (!env.BODIES) throw new Error('the BODIES bucket is missing')
    const found = await syncBinding()
    if ('why' in found) throw new Error(`Gmail sync cannot run: ${found.why} (migrations_pending or not initialised)`)
    const c = gmail.config
    return {
      pages: {
        binding: found.binding,
        organizationId: found.organizationId,
        objects: r2ObjectStore(env.BODIES),
        streams: deps.streams ?? workerdStreams(),
        clock,
        newId,
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        ...(builtIns ? { builtIns } : {}),
        config: {
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          credentialsKey: c.credentialsKey,
          keyVersion: c.keyVersion,
          backfillDays: c.backfillDays,
          attachmentMaxBytes: c.attachmentMaxBytes,
        },
        ...(googleFetch ? { fetch: googleFetch } : {}),
      },
      gate: async () => {
        if ((await migrations()).status === 'behind')
          throw new Error('migrations_pending: the database is behind this build, apply the migrations first')
      },
      // [[CORE244]] D7: on the built-in provider the role re-check is the live membership; on Clerk, the cached profile.
      roleOf: builtIn
        ? membershipRoleReader(found.binding, 'better-auth')
        : profiles
          ? async (subject) => {
              const profile = await profiles.profileOf(subject, clock().getTime())
              return profile ? workspaceRole(profile.role) : null
            }
          : null,
      policy: SCOPE_POLICY,
      declaredScopes: discovery.declaredScopes,
      instances: env.GMAIL_SYNC,
    }
  }

  /**
   * The per-minute tick ([[AGT8]] D54, [[API7]] D6): the expiry sweep, then the runner sweep, then webhook dispatch ([[API219]]), then the webhook sender ([[API220]]), behind the same gates as the
   * Gmail tick (initialised, not behind its migrations). The three are independent: one failing does not stop the others, and the first failure is rethrown after all ran. Dispatch needs no
   * CREDENTIALS_KEY (rows are written whatever the key); the sender idles without it. All of them share one budget of D1 queries plus outbound fetches ([[API7]] D24, `CRON_TICK_BUDGET`).
   */
  let railRegistry: Registry | undefined
  async function railScheduled(controller: ScheduledControllerLike): Promise<void> {
    // [[API7]] D24: ONE budget of D1 queries plus outbound fetches for the whole invocation. A counting D1 and a counting fetch are what every phase is handed (the marker read below included), so the
    // rail's own traffic is counted without being planned against; dispatch and the sender ask `remaining()` before each unit.
    const tickBudget = parseTickBudget(vars.CRON_TICK_BUDGET)
    if (tickBudget.problem)
      console.warn(
        `[cron] ${controller.cron}: ${tickBudget.problem} must be an integer from 50 to 1000: running at ${DEFAULT_TICK_BUDGET}`,
      )
    const budget = new TickBudget(tickBudget.limit)
    const db = countD1(env.DB, budget)
    // [[CORE337]] P2: every control query of the tick is counted against the same budget.
    const controlCounted = env.CONTROL_DB ? openControlDb(countD1(env.CONTROL_DB, budget)) : undefined
    const outbound = countFetch(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (deps.fetch ?? fetch)(input, init),
      budget,
    ) as typeof fetch
    const tickStart = clock()
    const found = await syncBinding(db)
    if ('why' in found) {
      console.log(`[cron] ${controller.cron}: skipped, ${found.why}`)
      return
    }
    railRegistry ??= createVibaseRegistry({
      ...(deps.operations ? { operations: deps.operations } : {}),
      ...(deps.definitions ? { definitions: deps.definitions } : {}),
      ...(deps.extend ? { extend: deps.extend } : {}),
    })
    let failure: unknown
    try {
      const out = await railTick({
        binding: found.binding,
        registry: railRegistry,
        transports: transportsFor(found.binding, {
          fetch: outbound,
          bodies: countCalls(
            env.BODIES ?? ({} as R2BucketLike),
            ['get', 'put', 'delete', 'createMultipartUpload'],
            budget,
          ),
          instances: env.GMAIL_SYNC ? countCalls(env.GMAIL_SYNC, ['create'], budget) : undefined,
        }),
        clock,
        newId,
        ...(deps.transports ? {} : { dueLimit: 2 }),
      })
      console.log(
        `[cron] ${controller.cron}: rail expired ${out.expired} request(s), attempted ${out.attempted} execution(s)`,
      )
    } catch (err) {
      console.error(`[cron] ${controller.cron}: failed: ${err instanceof Error ? err.name : 'error'}`)
      failure = err
    }
    // [[CORE337]] P2: webhook dispatch and the sender run only when the request path's control conditions hold (binding, control migrations current or ahead, the marker paired with the CRM's); otherwise both
    // are skipped with one line naming the reason. The sweeps above and below run as they do.
    let tickPort: ReturnType<typeof webhookStore> | null = null
    try {
      const why = controlCounted ? await controlCondition(controlCounted, db) : 'no_binding'
      if (why === 'ok' && controlCounted) tickPort = webhookStore(controlCounted)
      else console.log(`[cron] ${controller.cron}: webhooks skipped, control plane: ${why}`)
    } catch (err) {
      console.error(
        `[cron] ${controller.cron}: webhooks skipped, control check failed: ${err instanceof Error ? err.name : 'error'}`,
      )
      failure ??= err
    }
    if (tickPort) {
      try {
        // At most half of what the rail left (D24); the sender takes the rest.
        const out = await dispatchWebhooks({
          binding: found.binding,
          port: tickPort,
          registry: railRegistry,
          clock,
          newId,
          budget: budget.slice(Math.floor(budget.remaining() / 2)),
        })
        const trouble = [
          out.unknownCursor > 0 ? `${out.unknownCursor} with an unknown cursor` : '',
          out.failed > 0 ? `${out.failed} not dispatched` : '',
          out.deferred > 0 ? `${out.deferred} deferred` : '',
        ].filter(Boolean)
        console.log(
          `[cron] ${controller.cron}: webhooks dispatched ${out.events} event(s) for ${out.subscriptions} subscription(s)${trouble.length > 0 ? ` (${trouble.join(', ')})` : ''}`,
        )
      } catch (err) {
        console.error(
          `[cron] ${controller.cron}: webhook dispatch failed: ${err instanceof Error ? err.name : 'error'}`,
        )
        failure ??= err
      }
      try {
        const out = await sendWebhooks({
          binding: found.binding,
          port: tickPort,
          registry: railRegistry,
          clock,
          newId,
          fetch: outbound,
          key: webhooks.runtime.key?.bytes ?? null,
          budget,
          startedAt: tickStart,
        })
        if (!out.noKey)
          console.log(
            `[cron] ${controller.cron}: webhooks sent ${out.sent}, failed ${out.failed}, dead ${out.dead}, cancelled ${out.cancelled}, deferred ${out.deferred}`,
          )
      } catch (err) {
        console.error(`[cron] ${controller.cron}: webhook send failed: ${err instanceof Error ? err.name : 'error'}`)
        failure ??= err
      }
    }
    // [[CORE259]] D10, [[CORE289]] P5: the repair sweep of the built-in provider's control plane, behind the same gates, independent of the work above (it never stops it, and it runs whatever failed).
    // It reads the CRM through the tick's counted D1 and writes the control database only; no audit row, no event.
    if (builtIn && control) {
      try {
        const out = await runAuthSweep(control, db, clock, {
          firstPartyClientIds: [CLI_CLIENT_ID, ...(cliClientId ? [cliClientId] : [])],
        })
        if (out.revoked > 0 || out.deleted > 0)
          console.log(
            `[cron] ${controller.cron}: auth sweep revoked ${out.revoked} subject(s), deleted ${out.deleted} account(s)`,
          )
        if (out.expiredDeviceCodes > 0 || out.unusedClients > 0)
          console.log(
            `[cron] ${controller.cron}: auth sweep removed ${out.expiredDeviceCodes} expired device code(s), ${out.unusedClients} unused client(s)`,
          )
      } catch (err) {
        console.error(`[cron] ${controller.cron}: auth sweep failed: ${err instanceof Error ? err.name : 'error'}`)
        failure ??= err
      }
    }
    if (failure) throw failure
  }

  /** The shared `scheduled` handler ([[CHN5]] D14, [[AGT8]] D54): dispatches on the cron expression; an unknown one is logged, not thrown. */
  async function scheduled(controller: ScheduledControllerLike): Promise<void> {
    if (controller.cron === RAIL_CRON) return railScheduled(controller)
    if (controller.cron !== GMAIL_SYNC_CRON) {
      console.warn(`[cron] unknown cron expression "${controller.cron}": nothing to do`)
      return
    }
    try {
      if (!gmail.config || !env.GMAIL_SYNC) {
        console.log(`[cron] ${controller.cron}: Gmail work skipped (Gmail or the GMAIL_SYNC binding is not configured)`)
        return
      }
      const found = await syncBinding()
      if ('why' in found) {
        console.log(`[cron] ${controller.cron}: skipped, ${found.why}`)
        return
      }
      const out = await requestDueSyncs({
        binding: found.binding,
        organizationId: found.organizationId,
        clock,
        newId,
        instances: env.GMAIL_SYNC,
      })
      console.log(
        `[cron] ${controller.cron}: requested ${out.requested.length} sync run(s), ${out.failed} could not be started`,
      )
      // [[CHN5]] D89: watch renewal, after the sync requests, so nothing it does can hold them back. Its failures are per connection and logged by class; this
      // catch is for the read of the candidates. Off unless push is on; the Google calls are recorded under this tick's own run name (D92).
      if (pushOn && gmail.config && pushParsed.config) {
        const at = controller.scheduledTime ?? clock().getTime()
        try {
          const c = gmail.config
          const cronFetch = recording.fetchFor({ id: `cron-${at}`, start: new Date(at) })
          const renewed = await renewWatches({
            binding: found.binding,
            organizationId: found.organizationId,
            clock,
            newId,
            randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
            config: {
              clientId: c.clientId,
              clientSecret: c.clientSecret,
              credentialsKey: c.credentialsKey,
              keyVersion: c.keyVersion,
            },
            topicName: pushParsed.config.topicName,
            ...(cronFetch ? { fetch: cronFetch } : {}),
          })
          console.log(
            `[cron] ${controller.cron}: watch renewal attempted ${renewed.attempted}, registered ${renewed.registered}`,
          )
        } catch (err) {
          console.error(`[cron] ${controller.cron}: watch renewal failed: ${err instanceof Error ? err.name : 'error'}`)
        }
      }
    } catch (err) {
      console.error(`[cron] ${controller.cron}: failed: ${err instanceof Error ? err.name : 'error'}`)
      throw err
    }
  }

  async function health(): Promise<Response> {
    try {
      await env.DB.prepare('SELECT 1').first()
      const initialised = (await ensure()) !== undefined
      const m = await migrations()
      const latestApplied = m.applied.length > 0 ? [...m.applied].sort().at(-1)! : null
      return json(
        {
          status: 'ok',
          initialised,
          version: vars.VERSION || 'dev',
          commit: vars.COMMIT || 'dev',
          migrations: {
            status: m.status,
            applied: m.applied.length,
            expected: EXPECTED.length,
            latest_applied: latestApplied,
            latest_expected: EXPECTED.at(-1) ?? null,
          },
          // [[CORE543]] P1: null when no objects are declared, else the digest of the attached file's bytes and the object names; `{digest, error}` for a file this Worker could not load.
          schema: await schemaFileHealth(deps.schemaFile),
        },
        200,
      )
    } catch {
      return json({ status: 'unavailable' }, 503)
    }
  }

  return {
    scheduled,
    // One recorder per run() call, named by the Workflow instance ([[CHN5]] D78); its caps are seeded from R2's index, so a replayed run() does not exceed them.
    runGmailSyncWorkflow: (event, step) => {
      const googleFetch = recording.fetchFor({
        id: event.instanceId ?? `connection-${event.payload.connection_id}`,
        start: event.timestamp ?? clock(),
      })
      return runGmailSyncWorkflow(event, step, () => gmailSyncRuntime(googleFetch))
    },
    async fetch(req, ctx) {
      try {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/health') return await health()
        // [[CORE315]] D28: an attached file this Worker cannot load fails every other route closed, before anything is served.
        if (deps.schemaFile?.error) return json(SCHEMA_INVALID, 503)
        // [[UI510]] D5: the one static entry for `/`, `/app/*` and `/assets/*`: the app's pages exist for every provider (with Clerk's hosts in the policy on Clerk), the auth pages and `/assets/ui/` only for the built-in provider;
        // all of it answers before every gate.
        const staticAnswer = await serveStatic(req, {
          assets: env.ASSETS,
          issuer: discovery.provider?.name === 'clerk' ? discovery.provider.issuer : undefined,
          builtIn,
        })
        if (staticAnswer) return staticAnswer
        // [[CORE243]] D1: `/auth/*` exists only for the built-in provider; for clerk and unset it is no route at all, before every gate. For better-auth it passes the migration gate
        // and the configuration gate, then the control gate ([[CORE259]] D6, D7: the auth tables live in the control-plane database, which must be migrated and paired with this
        // CRM database). It still touches no vault table (CORE243 D5).
        if (
          url.pathname === '/auth' ||
          url.pathname.startsWith('/auth/') ||
          (builtIn && url.pathname === AUTH_SERVER_METADATA_PATH)
        ) {
          if (!builtIn) return json(NO_SUCH_ROUTE, 404)
          if (configError || !builtInConfig) return json(INTERNAL, 500)
          // [[UI255]] D7: a trusted app origin (AUTH_TRUSTED_ORIGINS) gets credentialed CORS on `/auth` only. The preflight is answered here, before the gates (P1: only the preflight short-circuits them);
          // every other answer on this branch, the gates' own refusals included, carries the headers so the app can read why it failed. Any other origin, or none: no CORS header.
          const origin = req.headers.get('origin')
          const trusted =
            origin !== null &&
            (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) &&
            originMatches(builtInConfig.trustedOrigins ?? [], origin)
              ? origin
              : null
          if (trusted !== null && req.method === 'OPTIONS')
            return new Response(null, {
              status: 204,
              headers: {
                'access-control-allow-origin': trusted,
                'access-control-allow-credentials': 'true',
                'access-control-allow-methods': AUTH_CORS_METHODS,
                'access-control-allow-headers': AUTH_CORS_ALLOW_HEADERS,
                vary: 'Origin',
              },
            })
          // [[API622]] D5, D6, D7: a bearer app's origin (CORS_ALLOWED_ORIGINS, not a trusted one: D7 keeps the credentialed answer) gets a credential-free answer on exactly the OAuth register and token paths (P1: the
          // pathname, literally). The preflight is fixed (P3) and answered before the gates; every other answer carries the origin. Never Allow-Credentials.
          const bearer =
            trusted === null &&
            origin !== null &&
            (url.pathname === OAUTH_REGISTER_PATH || url.pathname === OAUTH_TOKEN_PATH) &&
            originMatches(corsOrigins, origin)
              ? origin
              : null
          if (bearer !== null && req.method === 'OPTIONS')
            return new Response(null, {
              status: 204,
              headers: {
                'access-control-allow-origin': bearer,
                'access-control-allow-methods': 'POST',
                'access-control-allow-headers': AUTH_CORS_ALLOW_HEADERS,
                vary: 'Origin',
              },
            })
          const answer = async (): Promise<Response> => {
            if ((await migrations()).status === 'behind') return json(MIGRATIONS_PENDING, 503)
            const refused = await controlGate()
            if (refused) return refused
            // [[CORE259]] D3: Better Auth is composed on the control-plane database, never on `DB`.
            if (req.method === 'GET' && url.pathname === CONSENT_BOUND_PATH) return await consentBound(req)
            return await builtInAuth().handler(req)
          }
          const res = await answer()
          if (bearer !== null) return withBearerCors(res, bearer)
          return trusted === null ? res : withAuthCors(res, trusted)
        }
        const spec =
          req.method === 'GET' && (url.pathname === openApiPath('api') || url.pathname === openApiPath('meta'))
        // Exempt from the migration and marker gates, not from a bad configuration (CORE84).
        const doc = discoveryResponse(req, discovery)
        if (doc) return configError ? json(INTERNAL, 500) : doc
        if (!spec && (await migrations()).status === 'behind') return json(MIGRATIONS_PENDING, 503)
        if (configError) return json(INTERNAL, 500)
        if (!spec) {
          const refused = await controlGate()
          if (refused) return refused
        }
        const ready = await ensure()
        // [[CHN432]] D1, P1: the public form route (CHN421 D1). It sits after the migration, configuration, control and marker gates and before the app and its authentication: the handler owns its answers, its CORS headers and
        // its failures (it never throws), so nothing is added here. Any other `/f` path is no route.
        if (ready && appBinding && (url.pathname === '/f' || url.pathname.startsWith('/f/'))) {
          const form = FORM_ROUTE.exec(url.pathname)
          if (!form) return json(NO_SUCH_ROUTE, 404)
          // P2 (432.3): the connecting IP is `CF-Connecting-IP`, absent when missing or empty; no other header is trusted for it.
          const ip = req.headers.get('cf-connecting-ip')
          return await handleFormIngress(
            {
              ctx: {
                binding: appBinding,
                organizationId: appBinding.organizationId,
                objects: env.BODIES ? r2ObjectStore(env.BODIES) : NO_OBJECTS,
                streams: deps.streams ?? workerdStreams(),
                clock,
                newId,
                randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
                ...(builtIns ? { builtIns } : {}),
              },
              turnstile: siteverifyVerifier({
                secret: typeof env.TURNSTILE_SECRET_KEY === 'string' ? env.TURNSTILE_SECRET_KEY : undefined,
                ...(deps.fetch ? { fetch: deps.fetch } : {}),
              }),
              ipLimiter: env.FORM_IP_LIMITER,
              formLimiter: env.FORM_LIMITER,
              log: (message, err) => console.error(`[d1-worker] ${message}`, err instanceof Error ? err.name : 'error'),
            },
            req,
            { publicId: form[1]!, ip: ip === null || ip === '' ? undefined : ip },
          )
        }
        // D78: the connect callback records under its own request id, so it gets an app whose Gmail `fetch` is a recorder of this one request (only while recording is on).
        // D92: so does a connection's delete (its `users.stop` is a Google call), under its own request id.
        const ownRun =
          url.pathname === CALLBACK_PATH || (req.method === 'DELETE' && /\/connections\/[^/]+$/.test(url.pathname))
        if (ready && recording.on && appBinding && ownRun)
          return await buildApp(appBinding, recording.fetchFor({ id: newId(), start: clock() })).fetch(
            req,
            undefined,
            ctx as never,
          )
        if (ready) return await ready.fetch(req, undefined, ctx as never)
        if (spec) {
          cold ??= createApp({
            storage: () => NO_UNITS,
            ...(deps.definitions ? { definitions: deps.definitions } : {}),
            ...(deps.extend ? { extend: deps.extend } : {}),
          })
          return await cold.fetch(req)
        }
        return json(NOT_INITIALISED, 503)
      } catch (err) {
        console.error('[d1-worker] unhandled', err instanceof Error ? err.message : 'unknown error')
        return json(INTERNAL, 500)
      }
    },
  }
}
