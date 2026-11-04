// The object store port ([[CORE25]] D52): message bodies and file bytes live behind it, never in the database
// (AGENTS.md invariant 6). Web APIs only: production code here runs in workerd, which has no Node built-in.

export interface StoredObject {
  body: ReadableStream<Uint8Array>
  size: number
  contentType: string | null
}

export interface ObjectStore {
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<void>
  /** Streams `body` into `key` ([[CORE69]] D5). With a `size` the stream already has exactly that length. */
  putStream(key: string, body: ReadableStream<Uint8Array>, opts: { size: number | null; contentType?: string }): Promise<void>
  get(key: string): Promise<StoredObject | null>
  /** A missing key is not an error. */
  delete(keys: string | readonly string[]): Promise<void>
}

/** The multipart subset of Cloudflare's `R2MultipartUpload` the store uses. */
export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView): Promise<{ partNumber: number; etag: string }>
  complete(uploadedParts: { partNumber: number; etag: string }[]): Promise<unknown>
  abort(): Promise<void>
}

/** The subset of Cloudflare's `R2Bucket` the store uses (structural: no @cloudflare/workers-types import). */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ body?: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>
  delete(keys: string | string[]): Promise<void>
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUploadLike>
}

/** R2's multipart part size ([[CORE69]] D5): every part but the last is exactly this size. */
const PART_BYTES = 5 * 1024 * 1024

export function r2ObjectStore(bucket: R2BucketLike): ObjectStore {
  return {
    async put(key, body, opts) {
      await bucket.put(key, body, opts?.contentType === undefined ? undefined : { httpMetadata: { contentType: opts.contentType } })
    },
    async putStream(key, body, opts) {
      const options = opts.contentType === undefined ? undefined : { httpMetadata: { contentType: opts.contentType } }
      // Known size: the caller's stream already has exactly that length (D6 pipes it through `fixedLength`), which R2's `put` needs.
      if (opts.size !== null) {
        await bucket.put(key, body, options)
        return
      }
      // Unknown size: buffer up to one part. If the stream ends there, one `put`; otherwise a multipart upload in PART_BYTES parts
      // (every part that size but the last, R2's rule), aborted on any error ([[CORE69]] D5).
      const reader = body.getReader()
      const pending: Uint8Array[] = []
      let pendingBytes = 0
      let upload: Awaited<ReturnType<R2BucketLike['createMultipartUpload']>> | null = null
      const parts: Array<{ partNumber: number; etag: string }> = []
      const take = (n: number): Uint8Array => {
        const out = new Uint8Array(n)
        let at = 0
        while (at < n) {
          const head = pending[0]!
          const want = n - at
          if (head.byteLength <= want) {
            out.set(head, at)
            at += head.byteLength
            pending.shift()
          } else {
            out.set(head.subarray(0, want), at)
            pending[0] = head.subarray(want)
            at += want
          }
        }
        pendingBytes -= n
        return out
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          pending.push(value)
          pendingBytes += value.byteLength
          // Strictly more than a part: a part is only cut when more bytes follow it, so the last part is never empty.
          while (pendingBytes > PART_BYTES) {
            upload ??= await bucket.createMultipartUpload(key, options)
            parts.push(await upload.uploadPart(parts.length + 1, take(PART_BYTES)))
          }
        }
        if (upload === null) {
          await bucket.put(key, take(pendingBytes), options)
          return
        }
        parts.push(await upload.uploadPart(parts.length + 1, take(pendingBytes)))
        await upload.complete(parts)
      } catch (err) {
        if (upload !== null) await upload.abort().catch(() => {})
        throw err
      }
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
    async putStream(key, body, opts) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer())
      objects.set(key, { bytes, contentType: opts.contentType ?? null })
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
