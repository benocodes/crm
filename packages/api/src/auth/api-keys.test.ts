import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateApiKey, hashApiKey } from './api-keys.js'
import { JWT_SHAPE } from './middleware.js'

describe('api keys', () => {
  it('format', async () => {
    const { key, hash, prefix } = await generateApiKey()
    expect(key).toMatch(/^vk_[A-Za-z0-9_-]{43}$/)
    expect(prefix).toBe(key.slice(0, 11))
    expect(hash).toBe(await hashApiKey(key))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is never JWT-shaped', async () => {
    for (let i = 0; i < 100; i++) expect(JWT_SHAPE.test((await generateApiKey()).key)).toBe(false)
  })
  it('is unique', async () => {
    expect((await generateApiKey()).key).not.toBe((await generateApiKey()).key)
  })
  it('hashes with SHA-256', async () => {
    expect(await hashApiKey('vk_test')).toBe(createHash('sha256').update('vk_test').digest('hex'))
  })
  it.each([['a.b.c', true], ['eyJ.eyJ.sig', true], ['a.b', false], ['a.b.c.d', false], ['a b.c.d', false]])(
    'JWT_SHAPE %s',
    (s, ok) => expect(JWT_SHAPE.test(s)).toBe(ok),
  )
})
