// The streaming base64url decoder ([[CHN5]] D25).
/** A TransformStream that skips to the top-level string member `member` of a JSON object and emits its base64url value decoded, chunk by chunk. */
export function base64UrlMemberDecoder(_member: string): TransformStream<Uint8Array, Uint8Array> {
  throw new Error('not implemented')
}
