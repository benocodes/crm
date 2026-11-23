// [[UI297]] D7: the `SessionSeam` seam over the vault's own Better Auth (`better-auth`): same-origin `fetch` with cookies, no script, no third party.
// The type is `SessionSeam` ([[UI443]] D4; it was `ClerkLike`).
import type { SessionSeam } from './types.js'

export function betterAuthSession(deps: {
  fetch?: typeof fetch
  navigate?: (url: string) => void
  returnPath: string | (() => string)
}): SessionSeam {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  // [[UI460]] P2, P3: the page path the person comes back to, from the caller (`/app/home`, `/app/accounts` or `/app/agents` for the app; required, [[UI476]] P4); a path only, never a query.
  const signIn = () =>
    `/sign-in?return_to=${typeof deps.returnPath === 'function' ? deps.returnPath() : deps.returnPath}`
  const navigate = deps.navigate ?? ((url: string) => location.assign(url))
  let signedIn = false

  /** R1: a non-2xx or a network failure rejects; a 200 with a null body is "signed out". */
  async function readSession(): Promise<boolean> {
    const res = await doFetch('/auth/get-session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`the session could not be read (${res.status})`)
    const text = await res.text()
    if (text.trim() === '') return false
    return JSON.parse(text) !== null
  }

  return {
    async load() {
      signedIn = await readSession()
    },
    isSignedIn: () => signedIn,
    // R2: fresh on every call, never cached; `401` is "no session".
    async getToken() {
      const res = await doFetch('/auth/token', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (res.status === 401) return null
      if (!res.ok) throw new Error(`the session token could not be read (${res.status})`)
      const body = (await res.json()) as { token?: unknown } | null
      return typeof body?.token === 'string' && body.token !== '' ? body.token : null
    },
    async recheckSession() {
      signedIn = await readSession()
      return signedIn
    },
    // R3: the argument is ignored; the target is the seam's own `returnPath` (`/sign-in` admits an allow-listed path).
    async redirectToSignIn() {
      navigate(signIn())
    },
    // R4: Better Auth's handler wants a JSON body and the page origin (the browser sends it).
    async signOut() {
      const res = await doFetch('/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
      })
      if (!res.ok) throw new Error(`sign-out was refused (${res.status})`)
      signedIn = false
    },
    profileUrl: () => null,
  }
}
