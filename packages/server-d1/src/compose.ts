import { createApp, createAuthAdapter, parseOriginList, r2ObjectStore, type AuthAdapter, type R2BucketLike } from '@vault/api'
import type { D1Binding } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { readDeployment } from './init-deployment.js'

export interface D1WorkerEnv {
  DB: D1Like
  AUTH_PROVIDER?: string
  CLERK_ISSUER?: string
  CLERK_AUTHORIZED_PARTIES?: string
  CLERK_SECRET_KEY?: string
  CLERK_JWT_KEY?: string
  CLERK_WEBHOOK_SECRET?: string
  CLERK_API_URL?: string
  CORS_ALLOWED_ORIGINS?: string
  /** The deployed commit, set by `deploy:remote` (`--var VERSION:<sha>`); `/health` reports it, `dev` when absent. */
  VERSION?: string
  /** The R2 bucket of message bodies and file bytes ([[CORE58]] P12). Absent: the two content routes answer `503 objects_unavailable`. */
  BODIES?: R2BucketLike
}

/** The 503 body of every route but /health and /openapi.json while the deployment marker is absent. */
export const NOT_INITIALISED = { error: { code: 'not_initialised', message: 'run the bootstrap CLI first' } }
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

const STRING_VARS = ['AUTH_PROVIDER', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'CLERK_WEBHOOK_SECRET', 'CLERK_API_URL', 'CORS_ALLOWED_ORIGINS', 'VERSION'] as const

/**
 * The composition of the open D1 Worker ([[CORE38]] P5), built once per isolate. The deployment marker drives the storage
 * binding: while it is absent every route but `/health` and `/openapi.json` is `503 not_initialised`, and an absent marker is
 * never cached, so a bootstrap run after an earlier 503 is picked up by the next request. A bad auth or CORS configuration
 * fails closed: every non-health request is `500 internal`, logged once with the variable's name and never its value.
 * `deps` exists for Node tests; the Worker passes none.
 */
export function composeD1Worker(
  env: D1WorkerEnv,
  deps: { fetch?: typeof fetch; clock?: () => Date; newId?: () => string } = {},
): { fetch(req: Request): Promise<Response> } {
  const vars: Record<string, string | undefined> = {}
  for (const name of STRING_VARS) vars[name] = typeof env[name] === 'string' ? env[name] : undefined

  let authAdapter: AuthAdapter | undefined
  let corsOrigins: readonly string[] = []
  let configError = false
  try {
    authAdapter = createAuthAdapter(vars, { fetch: deps.fetch, now: deps.clock })
    corsOrigins = parseOriginList(vars.CORS_ALLOWED_ORIGINS, 'CORS_ALLOWED_ORIGINS')
  } catch (err) {
    // The message names a variable ("AUTH_PROVIDER=clerk requires CLERK_JWT_KEY"); no adapter message carries a value.
    configError = true
    console.error(`[d1-worker] invalid auth configuration: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  type App = ReturnType<typeof createApp>
  let app: App | undefined
  let cold: App | undefined

  /** The app bound to the marker, once the marker exists. Only success is cached. */
  async function ensure(): Promise<App | undefined> {
    if (app) return app
    const link = await readDeployment(env.DB)
    if (!link) return undefined
    const binding = d1Binding(env.DB, link)
    app = createApp({ storage: () => binding, authAdapter, corsOrigins, clock: deps.clock, newId: deps.newId, objects: env.BODIES ? r2ObjectStore(env.BODIES) : undefined })
    return app
  }

  async function health(): Promise<Response> {
    try {
      await env.DB.prepare('SELECT 1').first()
      return json({ status: 'ok', initialised: (await ensure()) !== undefined, version: vars.VERSION || 'dev' }, 200)
    } catch {
      return json({ status: 'unavailable' }, 503)
    }
  }

  return {
    async fetch(req) {
      try {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === '/health') return await health()
        if (configError) return json(INTERNAL, 500)
        const ready = await ensure()
        if (ready) return await ready.fetch(req)
        if (req.method === 'GET' && url.pathname === '/openapi.json') {
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
