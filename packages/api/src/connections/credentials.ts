// Credential encryption ([[CHN5]] D4): AES-256-GCM through Web Crypto. The sealed text is base64url of iv (12 bytes) || ciphertext || tag (16 bytes),
// stored as TEXT (D30). Nothing here logs, and an error carries no key, token or plaintext. The caller supplies the IV (from the injected
// random source) so a golden run is deterministic and a test can see that each encryption gets its own.
import { base64UrlDecode, base64UrlEncode } from './base64url.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const IV_BYTES = 12
const TAG_BYTES = 16

async function importKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('credentials key must be 32 bytes')
  return crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, [usage])
}

/** Encrypts `plaintext` under `key` with `iv`; returns base64url of `iv || ciphertext || tag`. */
export async function sealToken(key: Uint8Array, plaintext: string, iv: Uint8Array): Promise<string> {
  if (iv.length !== IV_BYTES) throw new Error('credential IV must be 12 bytes')
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: TAG_BYTES * 8 }, await importKey(key, 'encrypt'), enc.encode(plaintext)))
  const out = new Uint8Array(IV_BYTES + sealed.length)
  out.set(iv, 0)
  out.set(sealed, IV_BYTES)
  return base64UrlEncode(out)
}

/** The inverse of `sealToken`. Throws (with no secret in the message) on a wrong key or a damaged text. */
export async function openToken(key: Uint8Array, sealed: string): Promise<string> {
  const bytes = base64UrlDecode(sealed)
  if (!bytes || bytes.length < IV_BYTES + TAG_BYTES) throw new Error('credential text is malformed')
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) as BufferSource, tagLength: TAG_BYTES * 8 }, await importKey(key, 'decrypt'), bytes.subarray(IV_BYTES) as BufferSource)
    return dec.decode(plain)
  } catch {
    throw new Error('credential could not be opened')
  }
}
