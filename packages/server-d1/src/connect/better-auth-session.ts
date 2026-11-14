// [[UI297]] D7: stub (red commit).
import type { ClerkLike } from './types.js'

export function betterAuthSession(_deps: { fetch?: typeof fetch; navigate?: (url: string) => void } = {}): ClerkLike {
  return { load: async () => {}, isSignedIn: () => false, getToken: async () => null, recheckSession: async () => false, redirectToSignIn: async () => {}, signOut: async () => {}, profileUrl: () => null }
}
