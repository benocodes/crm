import { ScopeSet } from '../scopes.js'
import { repairMembership } from '../directory/sync.js'
import { AuthFailure, type AuthAdapter } from './adapter.js'
import { lookupUser, provisionUser } from './first-sight.js'
import { resolveActiveOrganization } from './organization.js'
import { scopesForRole, type Role } from './roles.js'
import type { Principal, UserAuthenticator } from './types.js'

/**
 * A membership row updated more than this after the token was issued is newer than the token ([[CORE3]]
 * D20): the copy was changed by a webhook since, so the token must not undo it. The margin absorbs clock skew
 * between Clerk and the database.
 */
export const COPY_NEWER_MARGIN_MS = 5000

const NO_ORGANIZATION = (actor: Principal['actor'], forbidden: boolean): Principal => ({
  actor,
  organizationId: null,
  scopes: ScopeSet.parse([]),
  ...(forbidden ? { organizationForbidden: true } : {}),
})

/** The [[CORE3]] implementation of the [[CORE15]] seam: verify, first sight, organisation claim, role scopes. */
export function createUserAuthenticator(opts: { adapter: AuthAdapter; declaredScopes: readonly string[] }): UserAuthenticator {
  const { adapter, declaredScopes } = opts
  return {
    async authenticate(token, { db, organizationHeader }) {
      const verified = await adapter.verify(token)
      if (!verified.ok) throw new AuthFailure(verified.reason)
      const claim = verified.organization

      const login =
        (await lookupUser(db, adapter.provider, verified.subject, claim?.externalId ?? null)) ??
        (await provisionUser(db, adapter, verified.subject))
      const actor = { id: login.userId, kind: 'user' as const }

      let active: { organizationId: string; role: Role } | null = null
      if (claim) {
        if (claim.role === null) {
          console.warn('[auth] unmapped organisation role')
          return NO_ORGANIZATION(actor, true)
        }
        const latest = login.latestMembership
        if (latest && latest.updatedAt.getTime() > verified.issuedAt.getTime() + COPY_NEWER_MARGIN_MS) {
          // The copy changed after this token was issued: it wins, and there is nothing to repair.
          if (latest.deletedAt !== null) return NO_ORGANIZATION(actor, true)
          active = { organizationId: login.linkedOrganizationId!, role: latest.role }
        } else if (login.linkedOrganizationId !== null && latest && latest.deletedAt === null && latest.role === claim.role) {
          active = { organizationId: login.linkedOrganizationId, role: claim.role }
        } else {
          const organizationId = await repairMembership(db, adapter, {
            userId: login.userId,
            externalId: claim.externalId,
            role: claim.role,
            known: { organizationId: login.linkedOrganizationId },
          })
          active = { organizationId, role: claim.role }
        }
      }

      const resolved = resolveActiveOrganization(active, organizationHeader)
      if (resolved.organizationId === null) return NO_ORGANIZATION(actor, resolved.forbidden)
      return { actor, organizationId: resolved.organizationId, scopes: scopesForRole(resolved.role, declaredScopes) }
    },
  }
}
