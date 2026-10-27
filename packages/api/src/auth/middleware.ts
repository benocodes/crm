import type { Context, MiddlewareHandler } from 'hono'
import { ApiError } from '../errors.js'
import type { AppEnv } from '../rest/app.js'
import type { InternalEnv } from '../storage/internal.js'
import { authenticateApiKey } from './api-keys.js'
import type { Principal, UserAuthenticator } from './types.js'
import { AuthFailure } from './adapter.js'

export const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const BEARER = /^Bearer +(\S+)$/i

function logUnauthenticated(method: string, path: string, token: string | undefined, reason?: string): void {
  // At most 8 characters of the token ever reach a log.
  console.warn('[auth] 401', method, path, {
    credentials: token !== undefined,
    prefix: token?.slice(0, 8) ?? '',
    ...(reason !== undefined ? { reason } : {}),
  })
}

function unauthenticated(method: string, path: string, token: string | undefined, message: string): ApiError {
  logUnauthenticated(method, path, token)
  return new ApiError(401, 'unauthenticated', message)
}

/**
 * One Bearer credential per request, dispatched by shape: a JWT-shaped token goes to the user
 * authenticator ([[CORE3]]), anything else is an API key. Mounted on registry routes only.
 */
export function authMiddleware(opts: { userAuthenticator?: UserAuthenticator; env: (c: Context<AppEnv>) => InternalEnv }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { method, path } = c.req
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) throw unauthenticated(method, path, undefined, 'missing bearer credentials')
    const organizationHeader = c.req.header('x-organization-id')

    const storage = c.var.storage
    const env = opts.env(c)

    let principal: Principal
    if (JWT_SHAPE.test(token)) {
      if (!opts.userAuthenticator) throw unauthenticated(method, path, token, 'invalid or expired credentials')
      try {
        principal = await opts.userAuthenticator.authenticate(token, { storage, organizationHeader, env })
      } catch (err) {
        // Log each authenticator 401 once; other failures (409, 500) are not the middleware's to log.
        if (err instanceof ApiError && err.status === 401) {
          logUnauthenticated(method, path, token, err instanceof AuthFailure ? err.reason : undefined)
        }
        throw err
      }
    } else {
      const found = await authenticateApiKey(storage, token, env)
      if (!found) throw unauthenticated(method, path, token, 'invalid or expired credentials')
      if (organizationHeader !== undefined && organizationHeader.toLowerCase() !== found.organizationId?.toLowerCase()) {
        throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
      }
      principal = found
    }
    c.set('principal', principal)
    await next()
  }
}
