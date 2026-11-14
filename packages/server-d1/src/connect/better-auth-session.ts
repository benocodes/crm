// [[UI297]] D7: the `ClerkLike` seam over the vault's own Better Auth (`better-auth`): same-origin `fetch` with cookies, no script, no third party.
// The type keeps its name from [[UI30]]; the rename belongs to [[UI256]].
import type { ClerkLike } from './types.js'

const SIGN_IN = '/sign-in?return_to=/connect'

export function betterAuthSession(deps: { fetch?: typeof fetch; navigate?: (url: string) => void } = {}): ClerkLike {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const navigate = deps.navigate ?? ((url: string) => location.assign(url))
  let signedIn = false

  /** R1: a non-2xx or a network failure rejects; a 200 with a null body is "signed out". */
  async function readSession(): Promise<boolean> {
    const res = await doFetch('/auth/get-session', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
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
      const res = await doFetch('/auth/token', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (res.status === 401) return null
      if (!res.ok) throw new Error(`the session token could not be read (${res.status})`)
      const body = (await res.json()) as { token?: unknown } | null
      return typeof body?.token === 'string' && body.token !== '' ? body.token : null
    },
    async recheckSession() {
      signedIn = await readSession()
      return signedIn
    },
    // R3: the argument is ignored; `/sign-in` admits exactly this target.
    async redirectToSignIn() {
      navigate(SIGN_IN)
    },
    // R4: Better Auth's handler wants a JSON body and the page origin (the browser sends it).
    async signOut() {
      const res = await doFetch('/auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' })
      if (!res.ok) throw new Error(`sign-out was refused (${res.status})`)
      signedIn = false
    },
    profileUrl: () => null,
  }
}
