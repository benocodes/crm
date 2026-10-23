// Test-only: never import from non-test code. A stand-in for [[CORE3]]'s Clerk adapter behind the
// same UserAuthenticator interface.
import { ScopeSet } from '../scopes.js'
import type { UserAuthenticator } from '../auth/types.js'

const b64 = (s: string) => Buffer.from(s).toString('base64url')

/** A JWT-shaped string with an unverified payload. `kind: 'agent'` makes the principal an agent (storage-level suites that have no API-key table). */
export function mintTestUserToken(args: { userId: string; organizationId: string | null; scopes: string[]; kind?: 'user' | 'agent' }): string {
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(args))}.x`
}

/** Decodes a token from `mintTestUserToken` into a user principal: no verification, no database. */
export function fakeUserAuthenticator(): UserAuthenticator {
  return {
    async authenticate(token) {
      const p = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
        userId: string
        organizationId: string | null
        scopes: string[]
        kind?: 'user' | 'agent'
      }
      return { actor: { id: p.userId, kind: p.kind ?? 'user' }, organizationId: p.organizationId, scopes: ScopeSet.parse(p.scopes) }
    },
  }
}
