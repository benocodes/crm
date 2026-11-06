import { CALLBACK_PATH, MAIL_SYNC_CRON, googleRecording, SCOPE_POLICY, createApp, createProfileCache, createVaultRegistry, parseGmailConfig, parsePushConfig, renewWatches, discoveryResponse, openApiPath, createWorkspaceAuthAdapter, parseCliClientId, parseOriginList, parsePublishableKey, r2ObjectStore, requestDueSyncs, runMailSync, workerdStreams, workspaceRole, type AuthAdapter, type MailSyncInstances, type MailSyncParams, type MailSyncRuntime, type MailSyncSummary, type R2BucketLike, type Registry, type StreamPrimitives, type TransportRegistry, type WorkflowEventLike, type WorkflowStepLike } from '@vault/api'
import { uuidv7, type D1Binding } from '@vault/storage'
import { MIGRATIONS, d1Binding, readMigrationState, type D1Like, type MigrationStatus } from '@vault/storage-d1'
import { readDeployment } from './init-deployment.js'
import { serveConnect, type AssetsLike } from './connect-serving.js'

export interface D1WorkerEnv {
  DB: D1Like
  AUTH_PROVIDER?: string
  CLERK_ISSUER?: string
  CLERK_AUTHORIZED_PARTIES?: string
  CLERK_SECRET_KEY?: string
  CLERK_JWT_KEY?: string
  /** Not read on D1 ([[CORE64]] D24): there is no webhook. Kept so an old `.dev.vars` still type-checks. */
  CLERK_WEBHOOK_SECRET?: string
  /** The session-token claim holding the workspace role; default `vibase_role` ([[CORE64]] D8). */
  AUTH_ROLE_CLAIM?: string
  /** The first-party CLI's public OAuth client id ([[CORE77]] D14, D16); optional. Set but blank is a configuration error. */
  AUTH_CLI_CLIENT_ID?: string
  /** The Clerk publishable key, public ([[UI30]] D5): returned by discovery for the connect page; its Frontend API host must be `CLERK_ISSUER`'s. */
  CLERK_PUBLISHABLE_KEY?: string
  CLERK_API_URL?: string
  CORS_ALLOWED_ORIGINS?: string
  /** The deployed commit, set by `deploy:remote` (`--var VERSION:<sha>`); `/health` reports it, `dev` when absent. */
  VERSION?: string
  /**
   * The Gmail connect surface ([[CHN5]] D58): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_STATE_SECRET` and `CREDENTIALS_KEY` (base64 of 32 bytes)
   * must all be set for it to be on; `CREDENTIALS_KEY_VERSION` (default 1), `PUBLIC_BASE_URL` (the redirect URI's base; unset: the request's origin)
   * and `CONNECT_RETURN_URL` (unset: a built-in result page) are optional. The three secrets are Worker secrets, never printed.
   */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  OAUTH_STATE_SECRET?: string
  CREDENTIALS_KEY?: string
  CREDENTIALS_KEY_VERSION?: string
  PUBLIC_BASE_URL?: string
  CONNECT_RETURN_URL?: string
  /**
   * Gmail push ([[CHN5]] D87): `GMAIL_TOPIC_NAME` (`projects/<p>/topics/<t>`), `GMAIL_PUSH_SUBSCRIPTION` (`projects/<p>/subscriptions/<s>`), `GMAIL_PUSH_SERVICE_ACCOUNT` (the
   * email Pub/Sub signs its token as) and `PUBLIC_BASE_URL` (the endpoint's origin; `https`) must all be set, with Gmail and the `MAIL_SYNC` binding, for push to be on.
   * Public values, vars rather than secrets. Partly set: push is off and a startup line names the missing ones.
   */
  GMAIL_TOPIC_NAME?: string
  GMAIL_PUSH_SUBSCRIPTION?: string
  GMAIL_PUSH_SERVICE_ACCOUNT?: string
  /** The R2 bucket of message bodies and file bytes ([[CORE58]] P12). Absent: the two content routes answer `503 objects_unavailable`. */
  BODIES?: R2BucketLike
  /** Workers Static Assets: the built `/connect` page ([[UI30]] D2). Absent: `/connect*` answers 404. */
  ASSETS?: AssetsLike
  /**
   * The Google recorder's switch ([[CHN5]] D78, [[CHN153]]): an ISO-8601 UTC instant at most 7 days ahead. While the clock is before it, redacted Gmail and token-endpoint
   * exchanges are written to `BODIES` under `_recordings/`. Absent, past, malformed or too far ahead: off (the last two logged by name). A var or a secret; never committed with a value.
   */
  GOOGLE_RECORDING_UNTIL?: string
  /** The `MailSyncWorkflow` binding ([[CHN141]] D34). Absent: `connections.sync` answers 501, connect requests no sync, the cron skips Gmail work. */
  MAIL_SYNC?: MailSyncInstances
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
export const MIGRATIONS_PENDING = { error: { code: 'migrations_pending', message: 'apply the database migrations first' } }
/** While `behind` or `unknown` the tracker is re-read at most this often ([[CORE61]] D6). */
export const MIGRATION_REREAD_MS = 5_000
const EXPECTED = MIGRATIONS.map((m) => m.name)
const INTERNAL = { error: { code: 'internal', message: 'internal error' } }

/** The binding of the pre-initialisation app: it serves the OpenAPI document only, and a unit reaching it is a defect. */
const NO_UNITS: D1Binding = {
  kind: 'd1',
  runtime: { dialect: 'd1', maxSetSize: 0, execute: () => Promise.reject(new Error('the deployment is not initialised: no unit may run')) },
  organizationId: '',
  authProvider: '',
  authOrgId: '',
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const STRING_VARS = ['AUTH_PROVIDER', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'AUTH_ROLE_CLAIM', 'AUTH_CLI_CLIENT_ID', 'CLERK_PUBLISHABLE_KEY', 'CLERK_API_URL', 'CORS_ALLOWED_ORIGINS', 'VERSION', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY', 'CREDENTIALS_KEY_VERSION', 'PUBLIC_BASE_URL', 'CONNECT_RETURN_URL', 'GOOGLE_RECORDING_UNTIL', 'GMAIL_TOPIC_NAME', 'GMAIL_PUSH_SUBSCRIPTION', 'GMAIL_PUSH_SERVICE_ACCOUNT'] as const

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
  deps: { fetch?: typeof fetch; /** Node tests only ([[AGT8]] D52): operations registered before the queue's, and the transports the runner resolves. The Worker passes neither. */ operations?: (registry: Registry) => void; transports?: TransportRegistry; /** Node tests only: workerd's stream primitives are absent there. */ streams?: StreamPrimitives; clock?: () => Date; newId?: () => string; /** Milliseconds for the migration-state re-read window; defaults to `Date.now`. */ nowMs?: () => number } = {},
): { fetch(req: Request, ctx?: ExecutionContextLike): Promise<Response>; scheduled(controller: ScheduledControllerLike): Promise<void>; runMailSync(event: WorkflowEventLike<MailSyncParams>, step: WorkflowStepLike): Promise<MailSyncSummary> } {
  const vars: Record<string, string | undefined> = {}
  for (const name of STRING_VARS) vars[name] = typeof env[name] === 'string' ? env[name] : undefined

  let authAdapter: AuthAdapter | undefined
  let corsOrigins: readonly string[] = []
  let cliClientId: string | undefined
  let publishableKey: string | undefined
  let configError = false
  try {
    authAdapter = createWorkspaceAuthAdapter(vars, { fetch: deps.fetch, now: deps.clock })
    cliClientId = parseCliClientId(vars)
    // Only with a provider: without one the key is ignored and discovery has no auth to put it in.
    if (authAdapter) publishableKey = parsePublishableKey(vars)
    corsOrigins = parseOriginList(vars.CORS_ALLOWED_ORIGINS, 'CORS_ALLOWED_ORIGINS')
  } catch (err) {
    // The message names a variable ("AUTH_PROVIDER=clerk requires CLERK_JWT_KEY"); no adapter message carries a value.
    configError = true
    console.error(`[d1-worker] invalid auth configuration: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  // [[CHN5]] D58: parsed once; the app logs what is missing or malformed (names only) and gates the Gmail surface on it.
  const gmail = parseGmailConfig(vars)
  // [[CHN5]] D87: push is judged once, by the parser `setup:remote` shares. It is ON only with Gmail and the MAIL_SYNC binding too; the app logs why when it is not.
  const pushParsed = parsePushConfig(vars)
  const pushOn = gmail.config !== null && env.MAIL_SYNC !== undefined && pushParsed.config !== null

  const clock = deps.clock ?? (() => new Date())
  // [[CHN5]] D78: parsed once (a bad value is logged by name, never by value). Off, `fetchFor` hands back `deps.fetch` itself, so nothing is wrapped.
  const recording = googleRecording({ raw: vars.GOOGLE_RECORDING_UNTIL, bucket: env.BODIES, clock, plain: deps.fetch })

  type App = ReturnType<typeof createApp>
  let app: App | undefined
  let cold: App | undefined
  let appBinding: D1Binding | undefined

  // [[CORE64]] D21, D22: the documents read configuration only; built once. A bad configuration (below) still answers 500.
  const discovery = {
    provider: authAdapter ? { name: 'clerk' as const, issuer: vars.CLERK_ISSUER!.trim() } : undefined,
    cliClientId,
    publishableKey,
    declaredScopes: createVaultRegistry().declaredScopes(),
  }

  const nowMs = deps.nowMs ?? (() => Date.now())
  type Migrations = { status: MigrationStatus; applied: string[] }
  let settled: Migrations | undefined
  let latest: (Migrations & { at: number }) | undefined

  /**
   * The migration state ([[CORE61]] D6): remembered for the isolate once `current` or `ahead`; while `behind` or `unknown` it is
   * re-read at most every 5 s; a read that threw is never remembered, so the next request reads again.
   */
  async function migrations(): Promise<Migrations> {
    if (settled) return settled
    const now = nowMs()
    if (latest && now - latest.at < MIGRATION_REREAD_MS) return latest
    const read = await readMigrationState(env.DB, EXPECTED)
    const state = { status: read.status, applied: read.applied }
    if (state.status === 'current' || state.status === 'ahead') settled = state
    latest = read.readFailed ? undefined : { ...state, at: now }
    return state
  }

  /** The app bound to the marker, once the marker exists. Only success is cached. A missing marker table is an absent marker. */
  const buildApp = (binding: D1Binding, googleFetch: typeof fetch | undefined): App =>
    createApp({ storage: () => binding, workspace: { adapter: authAdapter, cliClientId }, gmail: { config: gmail.config, problems: gmail.problems, push: pushParsed.config, pushProblems: pushParsed.problems, ...(googleFetch ? { fetch: googleFetch } : {}), ...(env.MAIL_SYNC ? { instances: env.MAIL_SYNC } : {}) }, corsOrigins, version: vars.VERSION || 'dev', clock: deps.clock, newId: deps.newId, objects: env.BODIES ? r2ObjectStore(env.BODIES) : undefined })

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
  async function syncBinding(): Promise<{ binding: D1Binding; organizationId: string } | { why: string }> {
    let link
    try {
      link = await readDeployment(env.DB)
    } catch (err) {
      if (/no such table/i.test(err instanceof Error ? err.message : '')) return { why: 'the deployment is not initialised' }
      throw err
    }
    if (!link) return { why: 'the deployment is not initialised' }
    if ((await migrations()).status === 'behind') return { why: 'the database is behind its migrations' }
    return { binding: d1Binding(env.DB, link), organizationId: link.organizationId }
  }

  /** Re-resolved by every Workflow step ([[CHN5]] D11): nothing here is ever returned from a step. Throws (retryably) when the deployment cannot sync. */
  async function mailSyncRuntime(googleFetch: typeof fetch | undefined): Promise<MailSyncRuntime> {
    if (!gmail.config) throw new Error('Gmail is not configured on this deployment')
    if (!env.MAIL_SYNC) throw new Error('the MAIL_SYNC Workflow binding is missing')
    if (!env.BODIES) throw new Error('the BODIES bucket is missing')
    const found = await syncBinding()
    if ('why' in found) throw new Error(`mail sync cannot run: ${found.why} (migrations_pending or not initialised)`)
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
        config: { clientId: c.clientId, clientSecret: c.clientSecret, credentialsKey: c.credentialsKey, keyVersion: c.keyVersion, backfillDays: c.backfillDays, attachmentMaxBytes: c.attachmentMaxBytes },
        ...(googleFetch ? { fetch: googleFetch } : {}),
      },
      gate: async () => {
        if ((await migrations()).status === 'behind') throw new Error('migrations_pending: the database is behind this build, apply the migrations first')
      },
      roleOf: profiles
        ? async (subject) => {
            const profile = await profiles.profileOf(subject, clock().getTime())
            return profile ? workspaceRole(profile.role) : null
          }
        : null,
      policy: SCOPE_POLICY,
      declaredScopes: discovery.declaredScopes,
      instances: env.MAIL_SYNC,
    }
  }

  /** The shared `scheduled` handler ([[CHN5]] D14): dispatches on the cron expression; an unknown one is logged, not thrown. */
  async function scheduled(controller: ScheduledControllerLike): Promise<void> {
    if (controller.cron !== MAIL_SYNC_CRON) {
      console.warn(`[cron] unknown cron expression "${controller.cron}": nothing to do`)
      return
    }
    try {
      if (!gmail.config || !env.MAIL_SYNC) {
        console.log(`[cron] ${controller.cron}: Gmail work skipped (Gmail or the MAIL_SYNC binding is not configured)`)
        return
      }
      const found = await syncBinding()
      if ('why' in found) {
        console.log(`[cron] ${controller.cron}: skipped, ${found.why}`)
        return
      }
      const out = await requestDueSyncs({ binding: found.binding, organizationId: found.organizationId, clock, newId, instances: env.MAIL_SYNC })
      console.log(`[cron] ${controller.cron}: requested ${out.requested.length} sync run(s), ${out.failed} could not be started`)
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
            config: { clientId: c.clientId, clientSecret: c.clientSecret, credentialsKey: c.credentialsKey, keyVersion: c.keyVersion },
            topicName: pushParsed.config.topicName,
            ...(cronFetch ? { fetch: cronFetch } : {}),
          })
          console.log(`[cron] ${controller.cron}: watch renewal attempted ${renewed.attempted}, registered ${renewed.registered}`)
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
          migrations: { status: m.status, applied: m.applied.length, expected: EXPECTED.length, latest_applied: latestApplied, latest_expected: EXPECTED.at(-1) ?? null },
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
    runMailSync: (event, step) => {
      const googleFetch = recording.fetchFor({ id: event.instanceId ?? `connection-${event.payload.connection_id}`, start: event.timestamp ?? clock() })
      return runMailSync(event, step, () => mailSyncRuntime(googleFetch))
    },
    async fetch(req) {
      try {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/health') return await health()
        // [[UI30]] D1: the connect page is static: it answers before the migration, marker and configuration gates (its own API calls meet them).
        const page = await serveConnect(req, { assets: env.ASSETS, issuer: discovery.provider?.issuer })
        if (page) return page
        const spec = req.method === 'GET' && (url.pathname === openApiPath('api') || url.pathname === openApiPath('meta'))
        // Exempt from the migration and marker gates, not from a bad configuration (CORE84).
        const doc = discoveryResponse(req, discovery)
        if (doc) return configError ? json(INTERNAL, 500) : doc
        if (!spec && (await migrations()).status === 'behind') return json(MIGRATIONS_PENDING, 503)
        if (configError) return json(INTERNAL, 500)
        const ready = await ensure()
        // D78: the connect callback records under its own request id, so it gets an app whose Gmail `fetch` is a recorder of this one request (only while recording is on).
        // D92: so does a connection's delete (its `users.stop` is a Google call), under its own request id.
        const ownRun = url.pathname === CALLBACK_PATH || (req.method === 'DELETE' && /\/connections\/[^/]+$/.test(url.pathname))
        if (ready && recording.on && appBinding && ownRun) return await buildApp(appBinding, recording.fetchFor({ id: newId(), start: clock() })).fetch(req)
        if (ready) return await ready.fetch(req)
        if (spec) {
          cold ??= createApp({ storage: () => NO_UNITS })
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
