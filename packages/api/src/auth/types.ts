import type { StorageBinding } from '@vault/storage'
import type { Role } from './roles.js'
import type { ScopeSet } from '../scopes.js'
import type { InternalEnv } from '../storage/internal.js'

export type Actor = { id: string; kind: 'user' | 'agent' }

export type Principal = {
  actor: Actor
  organizationId: string | null
  scopes: ScopeSet
  /** The organisation claim was unusable or the X-Organization-Id header contradicted it ([[CORE3]] D7). */
  organizationForbidden?: boolean
  /** The workspace role of a user, read from the token on this request ([[CORE64]] D10); absent for agents and on the Organizations path. */
  role?: Role
}

/**
 * The [[CORE3]] seam: verifies a JWT-shaped bearer token and resolves the user principal (first sight,
 * organisation claim, role scopes). Throws ApiError (401/403/409). `storage` is the request's binding and `env` its
 * clock and id source ([[CORE41]] C2).
 */
export interface UserAuthenticator {
  authenticate(
    token: string,
    req: { storage: StorageBinding; organizationHeader: string | undefined; env: InternalEnv },
  ): Promise<Principal>
}
