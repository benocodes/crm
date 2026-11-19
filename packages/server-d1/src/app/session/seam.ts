// [[UI297]] D7: which sign-in seam the page builds from the instance's discovery document. `null` means sign-in is unavailable.
import { betterAuthSession } from './better-auth-session.js'
import { windowClerk } from './clerk-window.js'
import type { SessionSeam, Discovery } from './types.js'

export interface SeamDeps {
  fetch?: typeof fetch
  navigate?: (url: string) => void
  loadScript?: (src: string, publishableKey: string) => Promise<void>
  /** [[UI460]] P3: the page the person returns to after signing in (Better Auth, a path; a function is read when signing in, as the app navigates without a page load) or out (Clerk, a URL or path). Both are required ([[UI476]] P4): the app is the only caller and always passes them. */
  returnPath: string | (() => string)
  signOutReturn: string
}

export function selectSeam(discovery: Discovery | null | undefined, deps: SeamDeps): SessionSeam | null {
  const auth = discovery?.auth
  if (!auth) return null
  if (auth.provider === 'clerk' && auth.publishable_key)
    return windowClerk(auth, {
      ...(deps.loadScript ? { loadScript: deps.loadScript } : {}),
      signOutReturn: deps.signOutReturn,
    })
  if (auth.provider === 'better-auth') return betterAuthSession(deps)
  return null
}
