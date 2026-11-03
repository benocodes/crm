// [[UI30]] D3, D4: the real `ClerkLike`, over Clerk's browser bundle loaded from the instance's own Frontend API. The one file that touches `window.Clerk`.
import type { ClerkLike, Discovery } from './types.js'

/** The pinned `@clerk/clerk-js` build, served by the Frontend API ([[UI30]] D3: exact version, at least two weeks old). */
export const CLERK_JS_PATH = '/npm/@clerk/clerk-js@6.39.1/dist/clerk.browser.js'

interface ClerkSession {
  status?: string
  getToken(): Promise<string | null>
  reload?(): Promise<unknown>
}
interface ClerkBrowser {
  load(opts?: Record<string, unknown>): Promise<void>
  session?: ClerkSession | null
  redirectToSignIn(opts: { redirectUrl: string }): Promise<unknown> | void
  signOut(opts?: Record<string, unknown>): Promise<void>
  buildUserProfileUrl?(): string
}

export function clerkScriptUrl(issuer: string): string {
  return new URL(issuer).origin + CLERK_JS_PATH
}

function loadScript(src: string, publishableKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.async = true
    s.crossOrigin = 'anonymous'
    s.setAttribute('data-clerk-publishable-key', publishableKey)
    s.src = src
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error('the Clerk script could not be loaded')))
    document.head.append(s)
  })
}

export function windowClerk(auth: NonNullable<Discovery['auth']>, deps: { loadScript?: (src: string, publishableKey: string) => Promise<void> } = {}): ClerkLike {
  let clerk: ClerkBrowser | undefined
  const need = (): ClerkBrowser => {
    if (!clerk) throw new Error('Clerk is not loaded')
    return clerk
  }
  return {
    async load() {
      await (deps.loadScript ?? loadScript)(clerkScriptUrl(auth.issuer), auth.publishable_key!)
      const c = (window as unknown as { Clerk?: ClerkBrowser }).Clerk
      if (!c) throw new Error('Clerk did not initialise')
      await c.load()
      clerk = c
    },
    isSignedIn: () => Boolean(need().session),
    async getToken() {
      return (await need().session?.getToken()) ?? null
    },
    async recheckSession() {
      const c = need()
      try {
        await c.session?.reload?.()
      } catch {
        return false
      }
      return c.session?.status === 'active'
    },
    async redirectToSignIn(redirectUrl) {
      await need().redirectToSignIn({ redirectUrl })
    },
    async signOut() {
      await need().signOut()
    },
    profileUrl() {
      try {
        return need().buildUserProfileUrl?.() ?? null
      } catch {
        return null
      }
    },
  }
}
