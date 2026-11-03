import type { ClerkLike } from '../types.js'

/** A scripted `ClerkLike`: every call is counted, and each token is distinct so a reused token is visible. */
export class FakeClerk implements ClerkLike {
  loads = 0
  tokens = 0
  rechecks = 0
  redirects: string[] = []
  signOuts = 0
  issued: string[] = []
  constructor(
    public signedIn = true,
    /** What a re-check answers (the session still active?). */
    public stillActive = true,
    public profile: string | null = 'https://accounts.example/user',
  ) {}
  async load() {
    this.loads++
  }
  isSignedIn() {
    return this.signedIn
  }
  async getToken() {
    if (!this.signedIn) return null
    const t = ['tok', ++this.tokens, 'x'.repeat(8)].join('.')
    this.issued.push(t)
    return t
  }
  async recheckSession() {
    this.rechecks++
    if (!this.stillActive) this.signedIn = false
    return this.stillActive
  }
  async redirectToSignIn(redirectUrl: string) {
    this.redirects.push(redirectUrl)
  }
  async signOut() {
    this.signOuts++
    this.signedIn = false
  }
  profileUrl() {
    return this.profile
  }
}
