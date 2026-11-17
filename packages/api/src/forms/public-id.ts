// [[CHN420]] D6: the public id of a form, `frm_` plus 26 lowercase Crockford base32 characters (0-9 and a-z without i, l, o, u) encoding 128 random bits.
// The migration's CHECK holds the same alphabet (`0023_forms.sql`); there is no other base32 helper in the repository to share (recorded as a decision).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 16 bytes as 26 base32 characters, 5 bits each, most significant first; the last character carries 3 bits and two zero bits. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
  return out
}

/** Mints a public id from the injected random source (`PreparedEnv.randomBytes`), so golden runs and tests can fix it. */
export function mintPublicId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16)
  if (bytes.length !== 16) throw new Error('mintPublicId needs 16 random bytes')
  return `frm_${encodeBase32(bytes)}`
}
