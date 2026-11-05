import { createApp, createVaultRegistry, parseGmailConfig, discoveryResponse, openApiPath, createWorkspaceAuthAdapter, parseCliClientId, parseOriginList, parsePublishableKey, r2ObjectStore, type AuthAdapter, type R2BucketLike } from '@vault/api'
import type { D1Binding } from '@vault/storage'
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
  /** The R2 bucket of message bodies and file bytes ([[CORE58]] P12). Absent: the two content routes answer `503 objects_unavailable`. */
  BODIES?: R2BucketLike
  /** Workers Static Assets: the built `/connect` page ([[UI30]] D2). Absent: `/connect*` answers 404. */
  ASSETS?: AssetsLike
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

const STRING_VARS = ['AUTH_PROVIDER', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'AUTH_ROLE_CLAIM', 'AUTH_CLI_CLIENT_ID', 'CLERK_PUBLISHABLE_KEY', 'CLERK_API_URL', 'CORS_ALLOWED_ORIGINS', 'VERSION', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY', 'CREDENTIALS_KEY_VERSION', 'PUBLIC_BASE_URL', 'CONNECT_RETURN_URL'] as const

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
  deps: { fetch?: typeof fetch; clock?: () => Date; newId?: () => string; /** Milliseconds for the migration-state re-read window; defaults to `Date.now`. */ nowMs?: () => number } = {},
): { fetch(req: Request): Promise<Response> } {
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

  type App = ReturnType<typeof createApp>
  let app: App | undefined
  let cold: App | undefined

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
    app = createApp({ storage: () => binding, workspace: { adapter: authAdapter, cliClientId }, gmail: { config: gmail.config, problems: gmail.problems, ...(deps.fetch ? { fetch: deps.fetch } : {}) }, corsOrigins, version: vars.VERSION || 'dev', clock: deps.clock, newId: deps.newId, objects: env.BODIES ? r2ObjectStore(env.BODIES) : undefined })
    return app
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
