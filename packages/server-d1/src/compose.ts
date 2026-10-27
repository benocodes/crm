import type { D1Like } from '@vault/storage-d1'

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
}

/** The 503 body of every route but /health and /openapi.json while the deployment marker is absent. */
export const NOT_INITIALISED = { error: { code: 'not_initialised', message: 'run the bootstrap CLI first' } }

export function composeD1Worker(
  _env: D1WorkerEnv,
  _deps: { fetch?: typeof fetch; clock?: () => Date; newId?: () => string } = {},
): { fetch(req: Request): Promise<Response> } {
  throw new Error('not implemented')
}
