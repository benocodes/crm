import { describe, expect, it } from 'vitest'
import { openToken, sealToken } from './credentials.js'

// CHN140 D4: AES-256-GCM through Web Crypto; the sealed text is base64url of iv || ciphertext || tag.
const KEY = new Uint8Array(32).fill(9)
const OTHER = new Uint8Array(32).fill(10)
const iv = (n: number) => new Uint8Array(12).fill(n)
const TOKEN = '1//0g-refresh-token-value'

describe('sealToken / openToken', () => {
  it('round-trips a token, and the sealed text is not the token', async () => {
    const sealed = await sealToken(KEY, TOKEN, iv(1))
    expect(sealed).not.toContain(TOKEN)
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await openToken(KEY, sealed)).toBe(TOKEN)
  })

  it('the sealed text starts with the 12-byte IV it was given and is iv || ciphertext || 16-byte tag long', async () => {
    const sealed = await sealToken(KEY, TOKEN, iv(5))
    const bytes = Buffer.from(sealed, 'base64url')
    expect([...bytes.subarray(0, 12)]).toEqual([...iv(5)])
    expect(bytes.length).toBe(12 + new TextEncoder().encode(TOKEN).length + 16)
  })

  it('two encryptions of one token differ when their IVs differ (a fresh IV per encryption)', async () => {
    expect(await sealToken(KEY, TOKEN, iv(1))).not.toBe(await sealToken(KEY, TOKEN, iv(2)))
  })

  it('a wrong key fails to open it', async () => {
    await expect(openToken(OTHER, await sealToken(KEY, TOKEN, iv(1)))).rejects.toThrow()
  })

  it('a tampered text fails to open (the tag is checked)', async () => {
    const bytes = Buffer.from(await sealToken(KEY, TOKEN, iv(1)), 'base64url')
    bytes[bytes.length - 1]! ^= 1
    await expect(openToken(KEY, bytes.toString('base64url'))).rejects.toThrow()
  })

  it('refuses a key that is not 32 bytes and an IV that is not 12 bytes', async () => {
    await expect(sealToken(new Uint8Array(16), TOKEN, iv(1))).rejects.toThrow()
    await expect(sealToken(KEY, TOKEN, new Uint8Array(8))).rejects.toThrow()
  })

  it('an error from a failed open carries neither the token nor the key', async () => {
    const err = await openToken(OTHER, await sealToken(KEY, TOKEN, iv(1))).catch((e: Error) => e)
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(TOKEN)
  })
})
