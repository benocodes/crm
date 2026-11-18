// [[UI460]] D4 ([[UI443]]): the workspace app's state machine over the session seam and the API client. It moves between `AppState`s and decides nothing about markup. Stores nothing: no
// localStorage, sessionStorage or cookie. Dependency-free (no React), so it is tested in Node.
import type { ConnectAgentCheck } from './first-steps.js'
import type { Api, ApiResult } from './session/api.js'
import type { Me, SessionSeam } from './session/types.js'

export interface Who {
  name: string
  email: string
  role: string
  /** The name of the ACTIVE organisation's membership. */
  workspaceName: string
}

export type AppState =
  /** Reading discovery, the session and `me.get`. */
  | { kind: 'loading' }
  /** No provider, or discovery could not be read: sign-in cannot work. */
  | { kind: 'unavailable' }
  /** No session: the Sign in card. Nothing navigates on its own. */
  | { kind: 'signed-out' }
  /** A session the workspace does not admit: a 403, no active organisation, or not a person. */
  | {
      kind: 'no-access' /** Who is signed in (name, else email): known only when `me.get` answered a person with no active organisation. */
      who?: string
      signOutError?: string
    }
  /** A read that failed (5xx, `503 migrations_pending`, a network failure, a session that cannot load, a 401 that survived its one re-check). Retry re-reads. */
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      who: Who /** The active organisation's scopes, for the nav's `visible(ctx)`. */
      scopes: string[]
      manageAccountHref: string | null
      /** [[UI461]] D10: whether Home's Connect an agent prompt shows. */
      connectAgent: ConnectAgentCheck
      signOutError?: string
    }

export interface AppController {
  state(): AppState
  subscribe(fn: () => void): () => void
  start(): Promise<void>
  /** Re-reads from `error`: the session first if it never loaded, then `me.get`. */
  retry(): Promise<void>
  /** Sends the person to sign in and back to this page (`<origin><path>`, never a query). */
  signIn(): Promise<void>
  signOut(): Promise<void>
  /** [[UI461]] P4: re-reads the agents list (a GET) and updates Home's Connect an agent prompt; nothing is written. */
  checkAgain(): Promise<void>
}

const ok = (r: ApiResult<unknown>): boolean => r.status >= 200 && r.status < 300 && r.body !== null
export const AGENTS_UNREADABLE = 'The agents list could not be read. Reload the page to try again.'
const SIGN_OUT_FAILED = 'Sign-out did not complete. Reload the page and try again.'

export function createAppController(deps: {
  /** The sign-in seam, or `null` when sign-in is unavailable (no provider, or discovery could not be read). */
  seam: SessionSeam | null
  api: Pick<Api, 'me' | 'hasEnabledAgent'>
  origin: string
  /** The page path the person is on: where signing in returns to. */
  path: string
}): AppController {
  const { seam, api } = deps
  let state: AppState = { kind: 'loading' }
  let loaded = false
  const listeners = new Set<() => void>()
  const set = (s: AppState) => {
    state = s
    for (const fn of [...listeners]) fn()
  }

  /**
   * One call with the session re-check: a `401` re-reads the session once. A gone session is `'signed-out'`; a live one gets the call retried once with a fresh token, and a second `401` is returned as it is
   * (the caller shows an error). No loop.
   */
  async function guarded<T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | 'signed-out'> {
    let r = await call()
    if (r.status !== 401) return r
    if (r.noToken) return 'signed-out'
    if (!seam || !(await seam.recheckSession())) return 'signed-out'
    r = await call()
    return r.noToken ? 'signed-out' : r
  }

  const failed = (message: string): void => set({ kind: 'error', message })

  /** D10, P4: no `agents:read` is no request and the prompt; otherwise one walk of the list, which a failure turns into the one-line error. */
  async function readConnectAgent(scopes: readonly string[]): Promise<ConnectAgentCheck | 'signed-out'> {
    if (!scopes.includes('agents:read')) return { status: 'show' }
    let r: ApiResult<boolean> | 'signed-out'
    try {
      r = await guarded(() => api.hasEnabledAgent())
    } catch {
      return { status: 'error', message: AGENTS_UNREADABLE }
    }
    if (r === 'signed-out') return r
    if (r.status < 200 || r.status >= 300 || r.body === null) return { status: 'error', message: AGENTS_UNREADABLE }
    return { status: r.body ? 'hidden' : 'show' }
  }

  async function readMe(): Promise<void> {
    let r: ApiResult<Me> | 'signed-out'
    try {
      r = await guarded(() => api.me())
    } catch {
      return failed('The workspace could not be reached. Check your connection and try again.')
    }
    if (r === 'signed-out') return set({ kind: 'signed-out' })
    if (r.status === 403) return set({ kind: 'no-access' })
    if (!ok(r)) return failed(`The workspace could not be read (${r.status}). Try again.`)
    const me = r.body!
    const active = me.active_organization
    // The app is for people: an agent principal has no profile to show, and a person with no active organisation has no workspace.
    if (!me.user) return set({ kind: 'no-access' })
    const display = me.user.name?.trim() ? me.user.name : me.user.email
    if (!active) return set({ kind: 'no-access', who: display })
    const membership = me.memberships.find((m) => m.organization_id === active.id)
    const connectAgent = await readConnectAgent(active.scopes)
    if (connectAgent === 'signed-out') return set({ kind: 'signed-out' })
    set({
      kind: 'ready',
      who: {
        name: display,
        email: me.user.email,
        role: active.role ?? membership?.role ?? 'none',
        workspaceName: membership?.organization_name ?? 'Your workspace',
      },
      scopes: [...active.scopes],
      manageAccountHref: seam?.profileUrl() ?? null,
      connectAgent,
    })
  }

  async function load(): Promise<void> {
    // With no seam there is nothing to load and nothing to call.
    if (!seam) return set({ kind: 'unavailable' })
    if (!loaded) {
      try {
        await seam.load()
        loaded = true
      } catch {
        return failed('Sign-in could not be loaded. Check your connection and try again.')
      }
    }
    if (!seam.isSignedIn()) return set({ kind: 'signed-out' })
    await readMe()
  }

  return {
    state: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    start: load,
    retry: load,
    async checkAgain() {
      if (state.kind !== 'ready') return
      const before = state
      const connectAgent = await readConnectAgent(before.scopes)
      if (connectAgent === 'signed-out') return set({ kind: 'signed-out' })
      // Only if nothing else moved the state while the read was in flight.
      if (state === before) set({ ...before, connectAgent })
    },
    signIn: () => Promise.resolve(seam?.redirectToSignIn(`${deps.origin}${deps.path}`)),
    async signOut() {
      // A refused attempt's message clears as the next one begins.
      if (state.kind === 'ready' && state.signOutError)
        set({
          kind: 'ready',
          who: state.who,
          scopes: state.scopes,
          manageAccountHref: state.manageAccountHref,
          connectAgent: state.connectAgent,
        })
      const before = state
      try {
        await seam?.signOut()
      } catch {
        // A refused sign-out (the session is still live) is not "signed out": keep the shell and say so.
        if (before.kind === 'ready' || before.kind === 'no-access') set({ ...before, signOutError: SIGN_OUT_FAILED })
        return
      }
      set({ kind: 'signed-out' })
    },
  }
}
