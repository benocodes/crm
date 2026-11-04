import type { VaultMessage } from '../channels/port.js'
export function messagePreview(_message: Pick<VaultMessage, 'formatted' | 'text'>, _kind: 'message' | 'reaction'): string {
  throw new Error('not implemented')
}
