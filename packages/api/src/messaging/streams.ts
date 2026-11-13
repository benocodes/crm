// The two workerd-only stream tools content storage needs ([[CORE69]] D4), injected so Node tests can supply their own
// (`@vibase/api/test/streams`). Typed structurally: no @cloudflare/workers-types import.
export interface StreamPrimitives {
  /** A SHA-256 sink: pipe bytes into `writable`; `digest` resolves when it closes. */
  sha256(): { writable: WritableStream<Uint8Array>; digest: Promise<ArrayBuffer> }
  /** A pass-through that errors unless exactly `size` bytes go through. */
  fixedLength(size: number): TransformStream<Uint8Array, Uint8Array>
}

type Ctor = new (...args: any[]) => any
export interface StreamGlobals {
  crypto?: { DigestStream?: Ctor }
  FixedLengthStream?: Ctor
}

/** Builds the primitives from workerd's globals; throws at construction when either is absent, so a wrong composition shows at once. */
export function workerdStreams(globals: StreamGlobals = globalThis as unknown as StreamGlobals): StreamPrimitives {
  const Digest = globals.crypto?.DigestStream
  const Fixed = globals.FixedLengthStream
  if (typeof Digest !== 'function') throw new Error('workerdStreams: crypto.DigestStream is not available (this runtime is not workerd)')
  if (typeof Fixed !== 'function') throw new Error('workerdStreams: FixedLengthStream is not available (this runtime is not workerd)')
  return {
    sha256() {
      const sink = new Digest('SHA-256') as WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> }
      return { writable: sink, digest: sink.digest }
    },
    fixedLength: (size) => new Fixed(size) as TransformStream<Uint8Array, Uint8Array>,
  }
}
