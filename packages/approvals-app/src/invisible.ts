// [[AGT588]] D12: the approvals app's copy of the API's character rule (`stripInvisibleCharacters`, `packages/api/src/channels/invisible-characters.ts`, D4).
// The app is a browser bundle that imports nothing from the API package, so it carries the set; `card.test.ts` pins it to the API's list, code point by code point.
// Stripped: zero-width space, word joiner and BOM, the bidi embeddings, overrides and isolates, the Unicode tag characters and the supplementary variation
// selectors. Kept: ZWJ, ZWNJ, the directional marks and the basic variation selectors.
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200b],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]

export function stripInvisible(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (!RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch
  }
  return out
}
