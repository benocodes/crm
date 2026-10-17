import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../errors.js'
import type { AppEnv } from '../rest/app.js'
import { authenticateApiKey } from './api-keys.js'
import type { Principal, UserAuthenticator } from './types.js'

export const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const BEARER = /^Bearer (\S+)$/

function unauthenticated(method: string, path: string, token: string | undefined, message: string): ApiError {
  // At most 8 characters of the token ever reach a log.
  console.warn('[auth] 401', method, path, { credentials: token !== undefined, prefix: token?.slice(0, 8) ?? '' })
  return new ApiError(401, 'unauthenticated', message)
}

/**
 * One Bearer credential per request, dispatched by shape: a JWT-shaped token goes to the user
 * authenticator ([[CORE3]]), anything else is an API key. Mounted on registry routes only.
 */
export function authMiddleware(opts: { userAuthenticator?: UserAuthenticator }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { method, path } = c.req
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) throw unauthenticated(method, path, undefined, 'missing bearer credentials')
    const organizationHeader = c.req.header('x-organization-id')

    let principal: Principal
    if (JWT_SHAPE.test(token)) {
      if (!opts.userAuthenticator) throw unauthenticated(method, path, token, 'invalid or expired credentials')
      principal = await opts.userAuthenticator.authenticate(token, { db: c.var.db, organizationHeader })
    } else {
      const found = await authenticateApiKey(c.var.db, token)
      if (!found) throw unauthenticated(method, path, token, 'invalid or expired credentials')
      if (organizationHeader !== undefined && organizationHeader !== found.organizationId) {
        throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
      }
      principal = found
    }
    c.set('principal', principal)
    await next()
  }
}
