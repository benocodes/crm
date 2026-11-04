// Test-only. A stand-in for a Cloudflare R2 bucket behind the structural `R2BucketLike`, recording every `get` key and
// every call that writes (`calls`), so a test can assert one `put` versus a multipart upload and its part sizes.
import { memoryObjectStore, type ObjectStore, type R2BucketLike } from '../objects/store.js'

export type FakeR2Call =
  | { op: 'put'; key: string; size: number }
  | { op: 'create'; key: string }
  | { op: 'part'; key: string; partNumber: number; size: number }
  | { op: 'complete'; key: string; parts: number }
  | { op: 'abort'; key: string }

export type FakeR2Bucket = R2BucketLike & {
  gets: string[]
  objects: Map<string, Uint8Array>
  /** The `httpMetadata.contentType` each `put` received, by key. */
  contentTypes: Map<string, string | undefined>
  /** Every write-side call in order. */
  calls: FakeR2Call[]
}

export function fakeR2Bucket(): FakeR2Bucket {
  const objects = new Map<string, Uint8Array>()
  const contentTypes = new Map<string, string | undefined>()
  const gets: string[] = []
  const calls: FakeR2Call[] = []
  const bytesOf = async (value: ArrayBuffer | ArrayBufferView | string | ReadableStream): Promise<Uint8Array> => {
    if (typeof value === 'string') return new TextEncoder().encode(value)
    if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer())
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    return new Uint8Array(value.slice(0))
  }
  return {
    gets,
    objects,
    contentTypes,
    calls,
    async put(key, value, options) {
      const bytes = await bytesOf(value)
      calls.push({ op: 'put', key, size: bytes.byteLength })
      objects.set(key, bytes)
      contentTypes.set(key, options?.httpMetadata?.contentType)
      return {}
    },
    async createMultipartUpload(key, options) {
      calls.push({ op: 'create', key })
      const parts = new Map<number, Uint8Array>()
      let finished = false
      return {
        async uploadPart(partNumber, value) {
          const bytes = await bytesOf(value)
          calls.push({ op: 'part', key, partNumber, size: bytes.byteLength })
          parts.set(partNumber, bytes)
          return { partNumber, etag: `etag-${partNumber}` }
        },
        async complete(uploaded) {
          calls.push({ op: 'complete', key, parts: uploaded.length })
          const ordered = uploaded.map((p) => parts.get(p.partNumber)!)
          const all = new Uint8Array(ordered.reduce((n, b) => n + b.byteLength, 0))
          let at = 0
          for (const b of ordered) {
            all.set(b, at)
            at += b.byteLength
          }
          objects.set(key, all)
          contentTypes.set(key, options?.httpMetadata?.contentType)
          finished = true
          return {}
        },
        async abort() {
          calls.push({ op: 'abort', key })
          if (!finished) parts.clear()
        },
      }
    },
    async get(key) {
      gets.push(key)
      const bytes = objects.get(key)
      if (!bytes) return null
      const copy = bytes.slice()
      const contentType = contentTypes.get(key)
      return {
        body: new Blob([copy]).stream(),
        size: copy.byteLength,
        ...(contentType === undefined ? {} : { httpMetadata: { contentType } }),
      }
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(k)
        contentTypes.delete(k)
      }
    },
  }
}

/** An `ObjectStore` that records its writes and deletes and can be told to fail ([[CORE69]] tests). */
export interface RecordingStore extends ObjectStore {
  /** Keys written by `put`, then `putStream`, in call order. */
  writes: Array<{ via: 'put' | 'putStream'; key: string }>
  deletes: string[]
  /** Makes every write whose key matches throw `error`. */
  failWrites(match: (key: string) => boolean, error?: Error): void
  /** Makes every delete whose keys include a match throw. */
  failDeletes(match: (key: string) => boolean): void
}
export function recordingObjectStore(inner: ObjectStore = memoryObjectStore()): RecordingStore {
  let writeFault: { match: (key: string) => boolean; error: Error } | null = null
  let deleteFault: ((key: string) => boolean) | null = null
  const writes: RecordingStore['writes'] = []
  const deletes: string[] = []
  return {
    writes,
    deletes,
    failWrites(match, error = new Error('object store down')) {
      writeFault = { match, error }
    },
    failDeletes(match) {
      deleteFault = match
    },
    async put(key, body, opts) {
      writes.push({ via: 'put', key })
      if (writeFault?.match(key)) throw writeFault.error
      await inner.put(key, body, opts)
    },
    async putStream(key, body, opts) {
      writes.push({ via: 'putStream', key })
      if (writeFault?.match(key)) {
        await body.cancel(writeFault.error)
        throw writeFault.error
      }
      await inner.putStream(key, body, opts)
    },
    get: (key) => inner.get(key),
    async delete(keys) {
      const list = typeof keys === 'string' ? [keys] : [...keys]
      deletes.push(...list)
      if (deleteFault && list.some(deleteFault)) throw new Error('delete failed')
      await inner.delete(keys)
    },
  }
}
