import { ApiError } from '../errors.js'
import { ScopeSet } from '../scopes.js'
import type { AuthAdapter, VerifyFailure } from './adapter.js'
import { lookupUser, provisionUser } from './first-sight.js'
import { resolveOrganization } from './organization.js'
import { scopesForRole } from './roles.js'
import type { UserAuthenticator } from './types.js'

/** Always 401 `unauthenticated`. `reason` is for the middleware's log line, never the response. */
export class AuthFailure extends ApiError {
  constructor(
    readonly reason: VerifyFailure | 'no_email',
    message = 'invalid or expired credentials',
  ) {
    super(401, 'unauthenticated', message)
  }
}

/** The [[CORE3]] implementation of the [[CORE15]] seam: verify, first sight, organisation, role scopes. */
export function createUserAuthenticator(opts: { adapter: AuthAdapter; declaredScopes: readonly string[] }): UserAuthenticator {
  const { adapter, declaredScopes } = opts
  return {
    async authenticate(token, { db, organizationHeader }) {
      const verified = await adapter.verify(token)
      if (!verified.ok) throw new AuthFailure(verified.reason)

      const login =
        (await lookupUser(db, adapter.provider, verified.subject)) ?? (await provisionUser(db, adapter, verified.subject))

      const actor = { id: login.userId, kind: 'user' as const }
      const resolved = resolveOrganization(login.memberships, organizationHeader)
      if (resolved.organizationId === null) {
        return {
          actor,
          organizationId: null,
          scopes: ScopeSet.parse([]),
          ...(resolved.forbidden ? { organizationForbidden: true } : {}),
        }
      }
      return { actor, organizationId: resolved.organizationId, scopes: scopesForRole(resolved.role, declaredScopes) }
    },
  }
}
