import { sealToken } from '../connections/credentials.js'

// [[API7]] D12: the signing secret. `whsec_` + base64 of 32 random bytes (the key is the decoded bytes, [[API220]]'s signing), sealed with `sealToken` ([[CHN5]] D4) under
// `CREDENTIALS_KEY`. The plaintext leaves this module only as the answer of `webhooks.create` and `webhooks.rotate_secret`; the row stores the sealed text.

export const SECRET_PREFIX = 'whsec_'
/** The previous secret stays valid for this long after a rotation (D12). */
export const ROTATION_OVERLAP_MS = 24 * 3_600_000

export interface MintedSecret {
  /** The plaintext, shown once. */
  secret: string
  /** What the row stores. */
  sealed: string
}

/** A fresh secret from the injected random source (so a golden run is deterministic), sealed under `key` with its own IV. */
export async function mintSecret(randomBytes: (n: number) => Uint8Array, key: Uint8Array): Promise<MintedSecret> {
  const secret = SECRET_PREFIX + btoa(String.fromCharCode(...randomBytes(32)))
  return { secret, sealed: await sealToken(key, secret, randomBytes(12)) }
}
