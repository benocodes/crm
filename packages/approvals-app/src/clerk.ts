// Clerk in the browser, the same way the vault's /connect page does it: clerk-js from the instance's own Frontend API, pinned.
import { config } from './runtime-config.js'

const CLERK_JS_PATH = '/npm/@clerk/clerk-js@6.39.1/dist/clerk.browser.js'

interface ClerkBrowser {
  load(): Promise<void>
  session?: { getToken(): Promise<string | null> } | null
  user?: { primaryEmailAddress?: { emailAddress: string } | null } | null
  redirectToSignIn(opts: { redirectUrl: string }): Promise<unknown> | void
  signOut(opts?: { redirectUrl?: string }): Promise<void>
}

export interface Session {
  signedIn: boolean
  email: string | null
  token(): Promise<string | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
}

function loadScript(src: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.async = true
    s.crossOrigin = 'anonymous'
    s.setAttribute('data-clerk-publishable-key', key)
    s.src = src
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error('Clerk could not be loaded')))
    document.head.append(s)
  })
}

export async function loadSession(): Promise<Session> {
  await loadScript(config.clerkIssuer + CLERK_JS_PATH, config.clerkPublishableKey)
  const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk
  if (!clerk) throw new Error('Clerk did not initialise')
  await clerk.load()
  return {
    signedIn: Boolean(clerk.session),
    email: clerk.user?.primaryEmailAddress?.emailAddress ?? null,
    token: async () => (await clerk.session?.getToken()) ?? null,
    signIn: async () => void (await clerk.redirectToSignIn({ redirectUrl: location.href })),
    signOut: async () => clerk.signOut({ redirectUrl: location.origin }),
  }
}
