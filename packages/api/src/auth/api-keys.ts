import type { PreparedOperation, StorageBinding } from '@vault/storage'
import type { InternalEnv } from '../storage/internal.js'
import type { Principal } from './types.js'

export const API_KEY_PREFIX = 'vk_'
const nope = (): never => {
  throw new Error('not implemented')
}

// Web Crypto only (no node:crypto), so the same code runs in workerd.
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** SHA-256, lowercase hex. High-entropy keys need no slow hash. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The random source is injected (CORE40 P8) so golden runs can record a key; real code passes `crypto.getRandomValues`. */
export async function generateApiKey(randomBytes: (n: number) => Uint8Array): Promise<{ key: string; hash: string; prefix: string }> {
  const key = API_KEY_PREFIX + base64url(randomBytes(32))
  return { key, hash: await hashApiKey(key), prefix: key.slice(0, 11) }
}

export const LAST_USED_THROTTLE_MS = 60_000
export function apiKeyAuthOperation(_keyHash: string, _now: Date): PreparedOperation<Principal | null> {
  return nope()
}
export async function authenticateApiKey(_storage: StorageBinding, _key: string, _env: InternalEnv): Promise<Principal | null> {
  return nope()
}
