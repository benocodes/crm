// [[UI297]] D7: stub (red commit).
import type { ClerkLike, Discovery } from './types.js'

export interface SeamDeps {
  fetch?: typeof fetch
  navigate?: (url: string) => void
  loadScript?: (src: string, publishableKey: string) => Promise<void>
}

export function selectSeam(_discovery: Discovery | null | undefined, _deps: SeamDeps = {}): ClerkLike | null {
  return null
}
