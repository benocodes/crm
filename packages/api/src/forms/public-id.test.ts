import { describe, expect, it } from 'vitest'
import { encodeBase32, mintPublicId } from './public-id.js'

// [[CHN420]] D6: the encoding is fixed by the migration's CHECK (`^frm_[0-9a-hjkmnp-tv-z]{26}$`), so pin it on known bytes.
const PATTERN = /^frm_[0-9a-hjkmnp-tv-z]{26}$/
describe('public id minting (D6)', () => {
  it('encodes 16 zero bytes as 26 zeros and 16 ones as 25 z and a final w (3 bits and two padding zeros)', () => {
    expect(mintPublicId(() => new Uint8Array(16))).toBe(`frm_${'0'.repeat(26)}`)
    expect(mintPublicId(() => new Uint8Array(16).fill(255))).toBe(`frm_${'z'.repeat(25)}w`)
  })
  it('encodes a known value (the digits, then letters, in order)', () => {
    // bytes 0x00 0x44 0x32 0x14 0xc7 = bits 00000 00001 00010 00011 00100 00101 00110 00111
    expect(encodeBase32(new Uint8Array([0x00, 0x44, 0x32, 0x14, 0xc7]))).toBe('01234567')
  })
  it('always matches the stored shape, never contains i, l, o or u, and refuses a short source', () => {
    for (let i = 0; i < 200; i++)
      expect(mintPublicId((n) => crypto.getRandomValues(new Uint8Array(n)))).toMatch(PATTERN)
    expect(() => mintPublicId(() => new Uint8Array(8))).toThrow(/16/)
  })
})
