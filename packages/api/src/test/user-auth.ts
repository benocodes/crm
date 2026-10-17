// Test-only: never import from non-test code. A stand-in for [[CORE3]]'s Clerk adapter behind the
// same UserAuthenticator interface.
import { ScopeSet } from '../scopes.js'
import type { UserAuthenticator } from '../auth/types.js'

const b64 = (s: string) => Buffer.from(s).toString('base64url')

/** A JWT-shaped string with an unverified payload. */
export function mintTestUserToken(args: { userId: string; organizationId: string | null; scopes: string[] }): string {
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
      }
      return { actor: { id: p.userId, kind: 'user', }, organizationId: p.organizationId, scopes: ScopeSet.parse(p.scopes) }
    },
  }
}
