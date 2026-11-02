import { ApiError } from '../errors.js'
import { ScopeSet } from '../scopes.js'
import { AuthFailure, type AuthAdapter } from './adapter.js'
import { lookupUser, provisionUser } from './first-sight.js'
import { resolveActiveOrganization } from './organization.js'
import { scopesForRole, type Role } from './roles.js'
import type { UserAuthenticator } from './types.js'

/** The workspace role of a session token's claim; anything but `owner` and `member` (a missing, unknown or `agent` value) is null ([[CORE64]] D9). */
export function workspaceRole(claim: unknown): Role | null {
  return claim === 'owner' || claim === 'member' ? claim : null
}

/**
 * The D1 workspace authenticator ([[CORE64]] D8-D10, D24): a verified Clerk session token's `vibase_role` claim is the only
 * authority, read on every request. The organisation is the deployment's (the D1 binding): an `o` claim is ignored, no
 * `memberships` or `organizations` row is read or written, and nothing is repaired or compared. A refused token (no admissible
 * role) is refused BEFORE first sight, so it writes nothing. First sight of an admitted subject is [[CORE3]]'s, unchanged.
 * Role `agent` is refused until the agent accounts of [[CORE77]].
 */
export function createWorkspaceAuthenticator(opts: { adapter: AuthAdapter; declaredScopes: readonly string[] }): UserAuthenticator {
  const { adapter, declaredScopes } = opts
  return {
    async authenticate(token, { storage, organizationHeader, env }) {
      const verified = await adapter.verify(token)
      if (!verified.ok) throw new AuthFailure(verified.reason)
      const role = workspaceRole(verified.role)
      if (role === null) {
        console.warn('[auth] missing or unmapped workspace role')
        throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
      }
      if (storage.kind !== 'd1') throw new Error('the workspace authenticator serves a D1 deployment only')
      const login =
        (await lookupUser(storage, { provider: adapter.provider, subject: verified.subject, organizationExternalId: null })) ??
        (await provisionUser(storage, adapter, verified.subject, env))
      const actor = { id: login.userId, kind: 'user' as const }
      const resolved = resolveActiveOrganization({ organizationId: storage.organizationId, role }, organizationHeader)
      if (resolved.organizationId === null) return { actor, organizationId: null, scopes: ScopeSet.parse([]), organizationForbidden: true }
      return { actor, organizationId: resolved.organizationId, scopes: scopesForRole(resolved.role, declaredScopes), role: resolved.role }
    },
  }
}
