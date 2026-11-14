// STUB (red commit): the Better Auth adapter arrives with the implementation ([[CORE244]] D8).
import type { AuthAdapter, VerifyResult } from './adapter.js'

export interface BetterAuthKey {
  kid: string
  alg: string
  publicJwk: string
}
export interface BetterAuthAdapterConfig {
  issuer: string
  audience: string
  readKeys(): Promise<BetterAuthKey[]>
  readProfile(subject: string): Promise<{ email: string | null; emailVerified: boolean; name: string | null } | null>
  readClientName(clientId: string): Promise<string | null>
  now?: () => Date
}
export const SESSION_TOKEN_CLAIM = 'vibase_token'
export const SESSION_TOKEN_VALUE = 'session'
export function createBetterAuthAdapter(_config: BetterAuthAdapterConfig): AuthAdapter {
  const refuse = async (): Promise<VerifyResult> => ({ ok: false, reason: 'malformed' })
  return { provider: 'better-auth', roleSource: 'membership', verify: refuse, fetchProfile: async () => ({ email: null, emailVerified: false, name: null }), fetchOAuthClientName: async () => null, fetchOrganization: async () => null, listMembers: async () => [], parseWebhook: async () => ({ ok: false, reason: 'signature' }) }
}
