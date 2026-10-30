// The object store port ([[CORE25]] D52): message bodies and file bytes live behind it, never in the database
// (AGENTS.md invariant 6). Web APIs only: production code here runs in workerd, which has no Node built-in.

export interface StoredObject {
  body: ReadableStream<Uint8Array>
  size: number
  contentType: string | null
}

export interface ObjectStore {
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<void>
  get(key: string): Promise<StoredObject | null>
  /** A missing key is not an error. */
  delete(keys: string | readonly string[]): Promise<void>
}

/** The subset of Cloudflare's `R2Bucket` the store uses (structural: no @cloudflare/workers-types import). */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ body?: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>
  delete(keys: string | string[]): Promise<void>
}

export function r2ObjectStore(bucket: R2BucketLike): ObjectStore {
  return {
    async put(key, body, opts) {
      await bucket.put(key, body, opts?.contentType === undefined ? undefined : { httpMetadata: { contentType: opts.contentType } })
    },
    async get(key) {
      const object = await bucket.get(key)
      if (!object || !object.body) return null
      return { body: object.body as ReadableStream<Uint8Array>, size: object.size, contentType: object.httpMetadata?.contentType ?? null }
    },
    async delete(keys) {
      await bucket.delete(typeof keys === 'string' ? keys : [...keys])
    },
  }
}

/** An in-process store for tests and local composition. Copies bytes on `put`; strings are stored as UTF-8. */
export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>()
  return {
    async put(key, body, opts) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body.slice()
      objects.set(key, { bytes, contentType: opts?.contentType ?? null })
    },
    async get(key) {
      const object = objects.get(key)
      if (!object) return null
      return { body: new Blob([object.bytes.slice()]).stream() as ReadableStream<Uint8Array>, size: object.bytes.byteLength, contentType: object.contentType }
    },
    async delete(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key)
    },
  }
}
