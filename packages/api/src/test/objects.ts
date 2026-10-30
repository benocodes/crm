// Test-only. A stand-in for a Cloudflare R2 bucket behind the structural `R2BucketLike`, recording every `get` key.
import type { R2BucketLike } from '../objects/store.js'

export type FakeR2Bucket = R2BucketLike & {
  gets: string[]
  objects: Map<string, Uint8Array>
  /** The `httpMetadata.contentType` each `put` received, by key. */
  contentTypes: Map<string, string | undefined>
}

export function fakeR2Bucket(): FakeR2Bucket {
  const objects = new Map<string, Uint8Array>()
  const contentTypes = new Map<string, string | undefined>()
  const gets: string[] = []
  const bytesOf = (value: ArrayBuffer | ArrayBufferView | string): Uint8Array => {
    if (typeof value === 'string') return new TextEncoder().encode(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    return new Uint8Array(value.slice(0))
  }
  return {
    gets,
    objects,
    contentTypes,
    async put(key, value, options) {
      objects.set(key, bytesOf(value))
      contentTypes.set(key, options?.httpMetadata?.contentType)
      return {}
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
