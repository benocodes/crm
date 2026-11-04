export interface StreamPrimitives {
  sha256(): { writable: WritableStream<Uint8Array>; digest: Promise<ArrayBuffer> }
  fixedLength(size: number): TransformStream<Uint8Array, Uint8Array>
}
export function workerdStreams(_globals?: unknown): StreamPrimitives {
  throw new Error('not implemented')
}
