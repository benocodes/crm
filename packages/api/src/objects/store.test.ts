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

// ---- putStream ([[CORE69]] D5) --------------------------------------------------------------------------------------------

const MiB = 1024 * 1024
const patterned = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255)
const streamOf = (bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> => {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) return c.close()
      c.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
  })
}
const failingStream = (bytes: Uint8Array, after: number): ReadableStream<Uint8Array> => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= after) return c.error(new Error('source broke'))
      c.enqueue(bytes.slice(sent, sent + 64 * 1024))
      sent += 64 * 1024
    },
  })
}

describe.each(kinds)('ObjectStore.putStream (%s)', (name, make) => {
  it('known size: stores the bytes with the content type', async () => {
    const store = make()
    const bytes = patterned(1000)
    await store.putStream('k', streamOf(bytes), { size: 1000, contentType: 'application/pdf' })
    const got = await store.get('k')
    expect([...(await readAll(got!.body))]).toEqual([...bytes])
    expect(got!.size).toBe(1000)
    expect(got!.contentType).toBe('application/pdf')
  })
  it('unknown size under 5 MiB: stores the bytes', async () => {
    const store = make()
    const bytes = patterned(5 * MiB)
    await store.putStream('k', streamOf(bytes), { size: null })
    expect([...(await readAll((await store.get('k'))!.body))]).toEqual([...bytes])
  })
  it('unknown size over 5 MiB: stores every byte', async () => {
    const store = make()
    const bytes = patterned(12 * MiB + 17)
    await store.putStream('k', streamOf(bytes), { size: null })
    const got = await store.get('k')
    expect(got!.size).toBe(bytes.byteLength)
    expect(Buffer.from(await readAll(got!.body)).equals(Buffer.from(bytes))).toBe(true)
  })
  it('a stream that errors mid-upload rejects and leaves no object', async () => {
    const store = make()
    await expect(store.putStream('k', failingStream(patterned(8 * MiB), 7 * MiB), { size: null })).rejects.toThrow('source broke')
    expect(await store.get('k')).toBeNull()
  })
  if (name === 'r2') {
    it('known size: one put of the stream, no multipart', async () => {
      const bucket = fakeR2Bucket()
      await r2ObjectStore(bucket).putStream('k', streamOf(patterned(300)), { size: 300, contentType: 'text/plain' })
      expect(bucket.calls).toEqual([{ op: 'put', key: 'k', size: 300 }])
      expect(bucket.contentTypes.get('k')).toBe('text/plain')
    })
    it('unknown size up to and including 5 MiB: exactly one put', async () => {
      for (const n of [0, 1, 5 * MiB]) {
        const bucket = fakeR2Bucket()
        await r2ObjectStore(bucket).putStream('k', streamOf(patterned(n)), { size: null })
        expect(bucket.calls, `size ${n}`).toEqual([{ op: 'put', key: 'k', size: n }])
      }
    })
    it('unknown size over 5 MiB: multipart, every part 5 MiB but the last, completed once', async () => {
      const bucket = fakeR2Bucket()
      await r2ObjectStore(bucket).putStream('k', streamOf(patterned(12 * MiB + 17)), { size: null, contentType: 'message/rfc822' })
      expect(bucket.calls).toEqual([
        { op: 'create', key: 'k' },
        { op: 'part', key: 'k', partNumber: 1, size: 5 * MiB },
        { op: 'part', key: 'k', partNumber: 2, size: 5 * MiB },
        { op: 'part', key: 'k', partNumber: 3, size: 2 * MiB + 17 },
        { op: 'complete', key: 'k', parts: 3 },
      ])
      expect(bucket.contentTypes.get('k')).toBe('message/rfc822')
    })
    it('5 MiB plus one byte is a two-part upload with a one-byte last part', async () => {
      const bucket = fakeR2Bucket()
      await r2ObjectStore(bucket).putStream('k', streamOf(patterned(5 * MiB + 1)), { size: null })
      expect(bucket.calls.filter((c) => c.op === 'part').map((c) => (c as { size: number }).size)).toEqual([5 * MiB, 1])
    })
    it('an error mid-upload aborts the multipart upload and leaves no object', async () => {
      const bucket = fakeR2Bucket()
      await expect(r2ObjectStore(bucket).putStream('k', failingStream(patterned(12 * MiB), 11 * MiB), { size: null })).rejects.toThrow('source broke')
      expect(bucket.calls.at(-1)).toEqual({ op: 'abort', key: 'k' })
      expect(bucket.calls.some((c) => c.op === 'complete')).toBe(false)
      expect(bucket.objects.has('k')).toBe(false)
    })
    it('an error before the first part writes nothing at all', async () => {
      const bucket = fakeR2Bucket()
      await expect(r2ObjectStore(bucket).putStream('k', failingStream(patterned(2 * MiB), 1 * MiB), { size: null })).rejects.toThrow('source broke')
      expect(bucket.calls).toEqual([])
    })
  }
})

// ---- putStream cancels its source when the store rejects (#121 item 2) -----------------------------------------------------
// A provider response (CHN5's Gmail fetch) must not stay open until the invocation ends. `cancel` reaches the source only while
// the source is still open, so the cases are the ones where the store fails before the stream is drained.
function watchedStream(bytes: Uint8Array): { stream: ReadableStream<Uint8Array>; cancelled: () => { reason: unknown } | null } {
  let got: { reason: unknown } | null = null
  let at = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) return c.close()
      c.enqueue(bytes.slice(at, at + 64 * 1024))
      at += 64 * 1024
    },
    cancel(reason) {
      got = { reason }
    },
  })
  return { stream, cancelled: () => got }
}

describe('ObjectStore.putStream cancels the source on a store error (r2)', () => {
  it('multipart: uploadPart rejects -> the multipart upload is aborted and the source sees cancel with the error', async () => {
    const boom = new Error('part rejected')
    const bucket = fakeR2Bucket()
    const inner = bucket.createMultipartUpload.bind(bucket)
    bucket.createMultipartUpload = async (key, options) => ({ ...(await inner(key, options)), uploadPart: async () => { throw boom } })
    const src = watchedStream(patterned(12 * MiB))
    await expect(r2ObjectStore(bucket).putStream('k', src.stream, { size: null })).rejects.toBe(boom)
    expect(src.cancelled()).toEqual({ reason: boom })
    expect(bucket.calls.at(-1)).toEqual({ op: 'abort', key: 'k' })
  })

  it('known size: put rejects without reading -> the source sees cancel with the error', async () => {
    const boom = new Error('put rejected')
    const bucket = { ...fakeR2Bucket(), put: async () => { throw boom } }
    const src = watchedStream(patterned(1000))
    await expect(r2ObjectStore(bucket).putStream('k', src.stream, { size: 1000 })).rejects.toBe(boom)
    expect(src.cancelled()).toEqual({ reason: boom })
  })

  it('a source that is already errored does not mask the original error with a cancel failure', async () => {
    const bucket = fakeR2Bucket()
    await expect(r2ObjectStore(bucket).putStream('k', failingStream(patterned(8 * MiB), 7 * MiB), { size: null })).rejects.toThrow('source broke')
  })

  it('a cancel that itself rejects is swallowed (best effort)', async () => {
    const boom = new Error('put rejected')
    const bucket = { ...fakeR2Bucket(), put: async () => { throw boom } }
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)) }, cancel() { throw new Error('cancel exploded') } })
    await expect(r2ObjectStore(bucket).putStream('k', stream, { size: 4 })).rejects.toBe(boom)
  })
})
