// The narrow port API-key authentication reaches the control plane's `api_keys` through ([[CORE350]] P5, [[CORE259]] D5, D11). STUB (red commit): CRM keys only.
import type { StorageBinding } from '@vibase/storage'
import type { InternalEnv } from '../storage/internal.js'
import { authenticateApiKey } from './api-keys.js'
import type { Principal } from './types.js'

export interface ApiKeyState {
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
}
export interface ApiKeyLookup extends ApiKeyState {
  id: string
  agentId: string
  organizationId: string
}
export interface ApiKeyControlPort {
  findByHash(keyHash: string): Promise<ApiKeyLookup | null>
  readState(id: string): Promise<ApiKeyState | null>
  stampUsed(a: { id: string; now: string }): Promise<boolean>
}
export interface ApiKeyControlRuntime {
  port: ApiKeyControlPort
}
export type ApiKeyAuthenticator = (storage: StorageBinding, key: string, env: InternalEnv) => Promise<Principal | null>

export function createApiKeyAuthenticator(_opts: {
  port: ApiKeyControlPort | null
  maxEntries?: number
}): ApiKeyAuthenticator {
  return (storage, key, env) => authenticateApiKey(storage, key, env)
}
