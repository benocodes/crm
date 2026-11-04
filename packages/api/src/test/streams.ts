// Test-only ([[CORE69]] D4). The Node implementation of `StreamPrimitives`: a `node:crypto` hash sink and a pass-through that
// fails on a length mismatch the way workerd's `FixedLengthStream` does. Production code gets the workerd globals instead.
import { createHash } from 'node:crypto'
import type { StreamPrimitives } from '../messaging/streams.js'

export function nodeStreams(): StreamPrimitives {
  return {
    sha256() {
      const hash = createHash('sha256')
      let resolve!: (d: ArrayBuffer) => void
      let reject!: (e: unknown) => void
      const digest = new Promise<ArrayBuffer>((res, rej) => {
        resolve = res
        reject = rej
      })
      digest.catch(() => {}) // a sink that is aborted rejects its digest; the caller decides whether anyone reads it
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          hash.update(chunk)
        },
        close() {
          const d = hash.digest()
          resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)
        },
        abort(reason) {
          reject(reason)
        },
      })
      return { writable, digest }
    },
    fixedLength(size) {
      let seen = 0
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength
          if (seen > size) throw new TypeError(`too many bytes: ${seen} > ${size}`)
          controller.enqueue(chunk)
        },
        flush() {
          if (seen !== size) throw new TypeError(`too few bytes: ${seen} < ${size}`)
        },
      })
    },
  }
}
