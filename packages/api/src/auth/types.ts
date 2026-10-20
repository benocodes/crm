import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import type { Actor } from '../context.js'
import type { ScopeSet } from '../scopes.js'

export type Principal = {
  actor: Actor
  organizationId: string | null
  scopes: ScopeSet
  /** The organisation claim was unusable or the X-Organization-Id header contradicted it ([[CORE3]] D7). */
  organizationForbidden?: boolean
}

/**
 * The [[CORE3]] seam: verifies a JWT-shaped bearer token and resolves the user principal (first sight,
 * organisation claim, role scopes). Throws ApiError (401/403/409).
 */
export interface UserAuthenticator {
  authenticate(
    token: string,
    req: { db: Kysely<Database>; organizationHeader: string | undefined },
  ): Promise<Principal>
}
