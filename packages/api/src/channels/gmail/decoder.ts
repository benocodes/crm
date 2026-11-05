// The streaming base64url decoder ([[CHN5]] D25). Gmail returns an original (`raw`) and an attachment (`data`) as a JSON object with
// one base64url string member. This transform skips to that member, at the top level only, and decodes it chunk by chunk, so the
// whole body is never held: memory is one input chunk, one output chunk and three bytes of carry. Web APIs only (workerd).

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const LBRACE = 0x7b
const RBRACE = 0x7d
const LBRACKET = 0x5b
const RBRACKET = 0x5d
const EQUALS = 0x3d

/** base64url alphabet to sextet; -1 elsewhere. Standard `+` and `/` are not base64url and are refused. */
const SEXTET = new Int8Array(256).fill(-1)
for (let i = 0; i < 26; i++) {
  SEXTET[0x41 + i] = i
  SEXTET[0x61 + i] = 26 + i
}
for (let i = 0; i < 10; i++) SEXTET[0x30 + i] = 52 + i
SEXTET[0x2d] = 62 // -
SEXTET[0x5f] = 63 // _

const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d

/** A TransformStream that skips to the top-level string member `member` of a JSON object and emits its base64url value decoded. */
export function base64UrlMemberDecoder(member: string): TransformStream<Uint8Array, Uint8Array> {
  const memberBytes = new TextEncoder().encode(member)
  type Phase = 'scan' | 'decode' | 'done'
  let phase: Phase = 'scan'
  // scan state
  let depth = 0
  let inString = false
  let escaped = false
  let isKey = false
  let keyMatch = false
  let keyPos = 0
  let expectKey = false
  let found = false
  /** 0 none, 1 a key just ended (expect `:`), 2 the colon seen (the value starts at the next non-space). */
  let keyState: 0 | 1 | 2 = 0
  // decode state
  let acc = 0
  let accCount = 0
  let padding = false

  const finish = (): void => {
    if (accCount === 1) throw new Error('base64url: a dangling character ends the value')
    phase = 'done'
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let out: Uint8Array | null = null
      let n = 0
      for (let i = 0; i < chunk.byteLength && phase !== 'done'; i++) {
        const b = chunk[i]!
        if (phase === 'decode') {
          if (b === QUOTE) {
            // Partial quad: 2 sextets give 1 byte, 3 give 2.
            if (accCount === 2) (out ??= new Uint8Array(chunk.byteLength * 0.75 + 4))[n++] = (acc >> 4) & 255
            else if (accCount === 3) {
              out ??= new Uint8Array(chunk.byteLength * 0.75 + 4)
              out[n++] = (acc >> 10) & 255
              out[n++] = (acc >> 2) & 255
            }
            finish()
            continue
          }
          if (b === EQUALS) {
            padding = true
            continue
          }
          const s = SEXTET[b]!
          if (padding || s < 0) throw new Error('base64url: invalid character in the value')
          acc = (acc << 6) | s
          if (++accCount === 4) {
            out ??= new Uint8Array(chunk.byteLength * 0.75 + 4)
            out[n++] = (acc >> 16) & 255
            out[n++] = (acc >> 8) & 255
            out[n++] = acc & 255
            acc = 0
            accCount = 0
          }
          continue
        }

        // phase 'scan'
        if (inString) {
          if (escaped) {
            escaped = false
            if (isKey) keyMatch = false
          } else if (b === BACKSLASH) escaped = true
          else if (b === QUOTE) {
            inString = false
            if (isKey) {
              isKey = false
              found = keyMatch && keyPos === memberBytes.byteLength
              keyState = 1
            }
          } else if (isKey && keyMatch) {
            if (keyPos < memberBytes.byteLength && memberBytes[keyPos] === b) keyPos++
            else keyMatch = false
          }
          continue
        }
        if (isSpace(b)) continue
        if (keyState === 1) {
          keyState = b === COLON ? 2 : 0
          if (b === COLON) continue
        } else if (keyState === 2) {
          keyState = 0
          if (found) {
            if (b !== QUOTE) throw new Error(`base64url: member "${member}" is not a string`)
            phase = 'decode'
            continue
          }
        }
        if (b === QUOTE) {
          inString = true
          escaped = false
          if (depth === 1 && expectKey) {
            isKey = true
            expectKey = false
            keyMatch = true
            keyPos = 0
          }
        } else if (b === LBRACE || b === LBRACKET) {
          depth++
          if (b === LBRACE && depth === 1) expectKey = true
        } else if (b === RBRACE || b === RBRACKET) depth--
        else if (b === COMMA && depth === 1) expectKey = true
      }
      if (out !== null && n > 0) controller.enqueue(out.subarray(0, n))
    },
    flush() {
      if (phase === 'decode') throw new Error('base64url: the body ended inside the value')
      if (phase === 'scan') throw new Error(`base64url: member "${member}" not found`)
    },
  })
}
