// [[AGT588]] D4: the one rule for characters that hide or reorder text. Applied by the capture pipeline to everything it stores from a captured
// message, whatever the channel, and reused by the approval card ([[AGT588]] cycle b).
import type { ChannelMessage } from './port.js'

/**
 * Stripped: zero-width space, word joiner, BOM (U+200B, U+2060, U+FEFF), the bidi embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069),
 * the Unicode tag characters (U+E0000 to U+E007F) and the supplementary variation selectors (U+E0100 to U+E01EF).
 * Kept on purpose: ZWJ and ZWNJ (U+200D, U+200C), the directional marks (U+200E, U+200F, U+061C) and the basic variation selectors (U+FE00 to U+FE0F).
 * The `u` flag matches whole code points, so an astral character beside a stripped one is never split.
 */
export const STRIPPED_INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200b],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]

const isStripped = (cp: number): boolean => STRIPPED_INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

/** Removes the stripped set from `text`, by code point (an astral character is never split); nothing else changes (whitespace a removed character leaves stays). */
export function stripInvisibleCharacters(text: string): string {
  let out = ''
  for (const ch of text) if (!isStripped(ch.codePointAt(0)!)) out += ch
  return out
}

const TEXT_FIELDS = ['value', 'alt', 'title', 'url'] as const

/** Strips every text value of an mdast tree in place, iteratively (the tree's depth is the mapper's to bound). */
function stripTree(root: unknown): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null
    if (node === null || typeof node !== 'object') continue
    for (const f of TEXT_FIELDS) if (typeof node[f] === 'string') node[f] = stripInvisibleCharacters(node[f] as string)
    if (Array.isArray(node.children)) for (const c of node.children) stack.push(c)
  }
}

/**
 * [[AGT588]] D4: cleans a read message before anything is derived from it (preview, fingerprint, stored body, contact names): `formatted`, `text`, the
 * author's names, the subject and every participant's display name. Mutates and returns `cm`.
 */
export function stripInvisibleFromMessage(cm: ChannelMessage): ChannelMessage {
  const { message, facts } = cm
  stripTree(message.formatted)
  message.text = stripInvisibleCharacters(message.text)
  const a = message.author
  a.userName = stripInvisibleCharacters(a.userName)
  a.fullName = stripInvisibleCharacters(a.fullName)
  if (facts.subject !== null) facts.subject = stripInvisibleCharacters(facts.subject)
  for (const p of facts.participants) if (p.name !== undefined) p.name = stripInvisibleCharacters(p.name)
  return cm
}
