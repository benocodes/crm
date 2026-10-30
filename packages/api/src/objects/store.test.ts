import { describe, expect, it } from 'vitest'
import { fakeR2Bucket } from '../test/objects.js'
import { memoryObjectStore, r2ObjectStore, type ObjectStore } from './store.js'

const readAll = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => new Uint8Array(await new Response(s).arrayBuffer())

const kinds: [string, () => ObjectStore][] = [
  ['memory', () => memoryObjectStore()],
  ['r2', () => r2ObjectStore(fakeR2Bucket())],
]

describe.each(kinds)('ObjectStore (%s)', (name, make) => {
  it('string round trip', async () => {
    const store = make()
    await store.put('a/b', 'héllo', { contentType: 'text/markdown' })
    const got = await store.get('a/b')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(await readAll(got!.body))).toBe('héllo')
    expect(got!.size).toBe(6)
    expect(got!.contentType).toBe('text/markdown')
  })
  it('bytes round trip', async () => {
    const store = make()
    await store.put('k', new Uint8Array([0, 255, 1]))
    const got = await store.get('k')
    expect([...(await readAll(got!.body))]).toEqual([0, 255, 1])
    expect(got!.size).toBe(3)
    expect(got!.contentType).toBeNull()
  })
  it('missing', async () => {
    expect(await make().get('nope')).toBeNull()
  })
  it('copy on put', async () => {
    const store = make()
    const arr = new Uint8Array([7, 8])
    await store.put('k', arr)
    arr[0] = 9
    expect((await readAll((await store.get('k'))!.body))[0]).toBe(7)
  })
  it('delete one, many, missing', async () => {
    const store = make()
    for (const k of ['a', 'b', 'c']) await store.put(k, 'x')
    await store.delete('a')
    await store.delete(['b', 'c'])
    await expect(store.delete('zzz')).resolves.toBeUndefined()
    for (const k of ['a', 'b', 'c']) expect(await store.get(k)).toBeNull()
  })
  if (name === 'r2') {
    it('passes the content type to the bucket', async () => {
      const bucket = fakeR2Bucket()
      await r2ObjectStore(bucket).put('k', 'x', { contentType: 'text/plain' })
      expect(bucket.contentTypes.get('k')).toBe('text/plain')
    })
    it('a body-less object is null', async () => {
      const bucket = { ...fakeR2Bucket(), get: async () => ({ size: 3 }) }
      expect(await r2ObjectStore(bucket).get('k')).toBeNull()
    })
  }
})
