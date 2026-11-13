// The password hasher ([[CORE243]] D13, P3). The vault's own hasher is Web Crypto PBKDF2-SHA256, native in workerd: Better Auth's
// default (scrypt in JavaScript) took ~65 ms per hash in workerd against ~12 ms for PBKDF2 (foundation cycle's RESULT.md, `pnpm -C packages/auth hasher:measure`).
// A stored hash is self-describing, so a later change of parameters or algorithm still verifies old hashes:
//
//   pbkdf2-sha256$<iterations>$<salt, base64url>$<derived key, base64url>
//
// `verifyPassword` also accepts Better Auth's own `<salt hex>:<key hex>` scrypt format, so an account created under the library's
// default (or migrated from one) keeps working.
import { verifyPassword as verifyLegacy } from 'better-auth/crypto'

/** 100,000: the historical Workers cap, accepted by every runtime. This repo's workerd accepts more (measured, `hasher:measure`) at a linear CPU cost; Cloudflare's current production cap is unconfirmed. */
export const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256
export const PBKDF2_PREFIX = 'pbkdf2-sha256'

const encoder = new TextEncoder()
const b64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64url = (text: string): Uint8Array => {
  const s = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, KEY_BITS))
}

export async function hashPassword(password: string, opts: { iterations?: number } = {}): Promise<string> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  return `${PBKDF2_PREFIX}$${iterations}$${b64url(salt)}$${b64url(await derive(password, salt, iterations))}`
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Never throws for a malformed or unknown hash: that is a refusal. */
export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  try {
    if (hash.startsWith(`${PBKDF2_PREFIX}$`)) {
      const [, iterations, salt, key] = hash.split('$')
      const n = Number(iterations)
      if (!Number.isInteger(n) || n < 1 || !salt || !key) return false
      return equal(await derive(password, fromB64url(salt), n), fromB64url(key))
    }
    if (/^[0-9a-f]+:[0-9a-f]+$/i.test(hash)) return await verifyLegacy({ hash, password })
    return false
  } catch {
    return false
  }
}
