// Small RFC 5322 / 2047 helpers for the Gmail mapper ([[CHN5]] D35): header lookup, encoded words, address lists, message-id tokens.
// Web APIs only (workerd). Lenient on purpose: mail in the wild is malformed, and a bad header must not lose the message.
import type { GmailHeader } from './types.js'

export function header(headers: readonly GmailHeader[] | undefined, name: string): string | null {
  const want = name.toLowerCase()
  return headers?.find((h) => h.name.toLowerCase() === want)?.value ?? null
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.replace(/\*.*$/, '').trim() || 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

/** Decodes the bytes of a body in its declared charset, UTF-8 when it is missing or unknown. */
export const decodeCharset = decodeBytes

const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

/** RFC 2047 encoded words. Whitespace between two adjacent encoded words is dropped. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value
  let joined = value
  for (;;) {
    const next = joined.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)[ \t\r\n]+(?==\?[^?\s]+\?[BbQq]\?)/g, '$1')
    if (next === joined) break
    joined = next
  }
  return joined.replace(WORD, (whole, charset: string, enc: string, text: string) => {
    try {
      if (enc.toLowerCase() === 'b') {
        const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
        return decodeBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)), charset)
      }
      const bytes: number[] = []
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!
        if (c === '_') bytes.push(0x20)
        else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
          i += 2
        } else bytes.push(c.charCodeAt(0) & 255)
      }
      return decodeBytes(Uint8Array.from(bytes), charset)
    } catch {
      return whole
    }
  })
}

export interface ParsedAddress {
  value: string
  name?: string
}

/** Splits at commas and semicolons that are outside quotes, angle brackets and comments. */
function splitList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = 0
  let comment = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (quoted) {
      current += c
      if (c === '\\' && i + 1 < value.length) current += value[++i]
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '(') comment++
    else if (c === ')' && comment > 0) comment--
    else if (c === '<' && comment === 0) angle++
    else if (c === '>' && comment === 0 && angle > 0) angle--
    if ((c === ',' || c === ';') && angle === 0 && comment === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  parts.push(current)
  return parts
}

const unquote = (s: string): string => {
  const t = s.trim()
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t
}

/** `Name <a@b>, c@d` to addresses with decoded display names. Groups are flattened; an item without an address is dropped. */
export function parseAddressList(value: string | null): ParsedAddress[] {
  if (!value) return []
  const out: ParsedAddress[] = []
  for (const raw of splitList(value)) {
    // A group prefix `Team: a@b` leaves its first member with a label.
    const piece = raw.replace(/^\s*[^<>"@,;]*:(?=\s*\S)/, '').trim()
    if (piece === '') continue
    const angle = /<([^<>]*)>/.exec(piece)
    let address: string
    let display: string
    if (angle) {
      address = angle[1]!.trim()
      display = piece.slice(0, angle.index)
    } else {
      const bare = piece.replace(/\([^)]*\)/g, ' ').trim()
      address = bare
      display = ''
      const comment = /\(([^)]*)\)/.exec(piece)
      if (comment) display = comment[1]!
    }
    if (!address.includes('@')) continue
    const name = decodeMimeWords(unquote(display)).trim()
    out.push(name !== '' && name.toLowerCase() !== address.toLowerCase() ? { value: address, name } : { value: address })
  }
  return out
}

/** `<id@host>` tokens in order; a bare value without brackets counts as one id. */
export function messageIdTokens(value: string | null): string[] {
  if (!value) return []
  const found = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!)
  if (found.length > 0) return found
  const bare = value.trim()
  return bare === '' ? [] : [bare]
}

/** The `charset` parameter of a Content-Type value, if any. */
export function charsetOf(contentType: string | null): string | null {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')
  return m ? m[1]! : null
}
