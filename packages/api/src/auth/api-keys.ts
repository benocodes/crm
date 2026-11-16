export const API_KEY_PREFIX = 'vk_'

// Web Crypto only (no node:crypto), so the same code runs in workerd.
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

/** SHA-256, lowercase hex. High-entropy keys need no slow hash. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The random source is injected (CORE40 P8) so golden runs can record a key; real code passes `crypto.getRandomValues`. */
export async function generateApiKey(
  randomBytes: (n: number) => Uint8Array,
): Promise<{ key: string; hash: string; prefix: string }> {
  const key = API_KEY_PREFIX + base64url(randomBytes(32))
  return { key, hash: await hashApiKey(key), prefix: key.slice(0, 11) }
}

/** A key used more recently than this is not stamped again: one write a minute per key at most (CORE15). The stamp is a control-plane write ([[CORE350]]); the CRM `api_keys` is gone ([[CORE329]]). */
export const LAST_USED_THROTTLE_MS = 60_000
