/** Browser sign-in (DX624). Stub: red commit. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export interface BrowserSignInOptions {
  url: string
  clientId: string
  redirectUri: string
  scopes?: string[]
  storage?: 'session' | 'local' | 'memory' | StorageLike
  fetch?: typeof fetch
  location?: { href: string; origin: string }
  navigate?: (url: string) => void
  replaceUrl?: (url: string) => void
  sessionStorage?: StorageLike
}
export interface BrowserSignIn {
  signIn(o?: { returnTo?: string }): Promise<never>
  handleRedirect(): Promise<{ returnTo: string } | null>
  token(): Promise<string | null>
  isSignedIn(): boolean
  signOut(): void
}
export async function pkceChallenge(_verifier: string): Promise<string> {
  return ''
}
export function browserSignIn(_options: BrowserSignInOptions): BrowserSignIn {
  const nope = (): never => {
    throw new Error('not implemented')
  }
  return { signIn: nope, handleRedirect: nope, token: nope, isSignedIn: nope, signOut: nope }
}
