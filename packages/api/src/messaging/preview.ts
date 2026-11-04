import type { VaultMessage } from '../channels/port.js'
import { toPlainText } from '../channels/markdown.js'

const PREVIEW_CODE_POINTS = 200

/**
 * `messages.preview` ([[CORE69]] D7, [[CORE25]] D37): the plain text of the message, every whitespace run collapsed to one space,
 * trimmed, then the first 200 code points (a surrogate pair is never split: `messages_preview_length` counts characters).
 * A reaction's preview is its `text` (the emoji) under the same rule.
 */
export function messagePreview(message: Pick<VaultMessage, 'formatted' | 'text'>, kind: 'message' | 'reaction'): string {
  const plain = kind === 'reaction' ? message.text : toPlainText(message.formatted)
  const collapsed = plain.replace(/\s+/gu, ' ').trim()
  const out: string[] = []
  for (const ch of collapsed) {
    if (out.length === PREVIEW_CODE_POINTS) break
    out.push(ch)
  }
  return out.join('')
}
