// [[UI297]] D7: which sign-in seam the page builds from the instance's discovery document. `null` means sign-in is unavailable.
import { betterAuthSession } from './better-auth-session.js'
import { windowClerk } from './clerk-window.js'
import type { ClerkLike, Discovery } from './types.js'

export interface SeamDeps {
  fetch?: typeof fetch
  navigate?: (url: string) => void
  loadScript?: (src: string, publishableKey: string) => Promise<void>
}

export function selectSeam(discovery: Discovery | null | undefined, deps: SeamDeps = {}): ClerkLike | null {
  const auth = discovery?.auth
  if (!auth) return null
  if (auth.provider === 'clerk' && auth.publishable_key) return windowClerk(auth, deps.loadScript ? { loadScript: deps.loadScript } : {})
  if (auth.provider === 'better-auth') return betterAuthSession(deps)
  return null
}
