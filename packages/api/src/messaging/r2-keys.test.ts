import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fileBlobKey, fileObjectPrefix, messageBodyKey, messageContentPrefix, messageOriginalKey } from './r2-keys.js'

describe('r2 keys (CORE25 D23)', () => {
  it('message prefix', async () => {
    expect(await messageContentPrefix('0190B2C4-0000-7000-8000-00000000A001', 'email', 'abc')).toBe(
      'orgs/0190b2c4-0000-7000-8000-00000000a001/messages/email/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
  it('hashes the UTF-8 bytes', async () => {
    const hex = createHash('sha256').update(Buffer.from('é@x', 'utf8')).digest('hex')
    expect((await messageContentPrefix('0190b2c4-0000-7000-8000-00000000a001', 'email', 'é@x')).endsWith(`/${hex}`)).toBe(true)
  })
  it('body and original keys', () => {
    expect(messageBodyKey('p/q', 2)).toBe('p/q/v2/body.md')
    expect(messageOriginalKey('p/q', 1, 'eml')).toBe('p/q/v1/original.eml')
  })
  it('file keys', () => {
    const prefix = fileObjectPrefix('0190B2C4-0000-7000-8000-00000000A001', '0190B2C4-0000-7000-8000-00000000B002')
    expect(prefix).toBe('orgs/0190b2c4-0000-7000-8000-00000000a001/files/0190b2c4-0000-7000-8000-00000000b002')
    expect(fileBlobKey(prefix)).toBe(`${prefix}/blob`)
  })
  it('refuses a bad prefix or version', () => {
    for (const p of ['', 'p/']) {
      expect(() => messageBodyKey(p, 1)).toThrow()
      expect(() => messageOriginalKey(p, 1, 'eml')).toThrow()
      expect(() => fileBlobKey(p)).toThrow()
    }
    for (const v of [0, 1.5]) {
      expect(() => messageBodyKey('p', v)).toThrow()
      expect(() => messageOriginalKey('p', v, 'json')).toThrow()
    }
  })
})
