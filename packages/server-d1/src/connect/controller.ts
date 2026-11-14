// [[UI30]] D4, D6, D8: the page's state machine over a `ClerkLike` and an `Api`. It decides nothing about markup: it only moves between
// `PageState`s, which `buildView` turns into what is shown.
import type { Api, ApiResult } from './api.js'
import type { AgentRecord, ClerkLike, Me, PageState } from './types.js'

export interface Page {
  state(): PageState
  start(): Promise<void>
  signIn(): Promise<void>
  signOut(): Promise<void>
  setDisabled(id: string, disabled: boolean): Promise<void>
}

const ok = (r: ApiResult<unknown>): boolean => r.status >= 200 && r.status < 300 && r.body !== null

/** `clerk` is the sign-in seam, or `null` when sign-in is unavailable ([[UI297]] D7). */
export function createPage(deps: { clerk: ClerkLike | null; api: Api; origin: string; onChange?: (s: PageState) => void }): Page {
  const { clerk, api, origin } = deps
  let state: PageState = { kind: 'loading' }
  const set = (s: PageState) => {
    state = s
    deps.onChange?.(s)
  }

  /**
   * One call with the session re-check of D8: a `401` re-reads the session from Clerk once. A gone session is `'signed-out'`; a live one
   * gets the call retried once with a fresh token, and a second `401` is returned as it is (the caller shows "refused"). No loop.
   */
  async function guarded<T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | 'signed-out'> {
    let r = await call()
    if (r.status !== 401) return r
    if (r.noToken) return 'signed-out'
    if (!clerk || !(await clerk.recheckSession())) return 'signed-out'
    r = await call()
    return r.noToken ? 'signed-out' : r
  }

  /** Moves to a terminal state when a call ended the session or was refused; true when the caller should stop. */
  function ended(r: ApiResult<unknown> | 'signed-out'): boolean {
    if (r === 'signed-out') {
      set({ kind: 'signed-out' })
      return true
    }
    if (r.status === 401) {
      set({ kind: 'refused', status: 401 })
      return true
    }
    return false
  }

  async function loadSession(): Promise<void> {
    const me = await guarded(() => api.me())
    if (ended(me)) return
    if (!ok(me as ApiResult<Me>)) return set({ kind: 'refused', status: (me as ApiResult<Me>).status })
    const who = (me as ApiResult<Me>).body!
    let agents: AgentRecord[] | null = null
    let error: string | undefined
    if (who.active_organization?.scopes.includes('agents:read')) {
      const list = await guarded(() => api.agents())
      if (ended(list)) return
      if (ok(list as ApiResult<AgentRecord[]>)) agents = (list as ApiResult<AgentRecord[]>).body
      else error = `Could not list the agents (${(list as ApiResult<AgentRecord[]>).status}).`
    }
    set({ kind: 'signed-in', me: who, agents, ...(error ? { error } : {}) })
  }

  return {
    state: () => state,

    async start() {
      // D5, UI297 D7: with no seam there is nothing to load and nothing to call.
      if (!clerk) return set({ kind: 'unavailable' })
      try {
        await clerk.load()
      } catch {
        return set({ kind: 'refused', status: 0 })
      }
      if (!clerk.isSignedIn()) return set({ kind: 'signed-out' })
      try {
        await loadSession()
      } catch {
        set({ kind: 'refused', status: 0 })
      }
    },

    // D6: Account Portal, and back to this page.
    signIn: () => Promise.resolve(clerk?.redirectToSignIn(`${origin}/connect`)),

    async signOut() {
      try {
        await clerk?.signOut()
      } catch {
        // UI297 D7: a refused sign-out (the session is still live) is not "signed out".
        return set({ kind: 'refused', status: 0 })
      }
      set({ kind: 'signed-out' })
    },

    async setDisabled(id, disabled) {
      const before = state
      if (before.kind !== 'signed-in' || before.agents === null) return
      const fail = (message: string) => set({ ...before, error: message })
      const verb = disabled ? 'disable' : 'enable'
      let r: ApiResult<AgentRecord> | 'signed-out'
      try {
        r = await guarded(() => api.setDisabled(id, disabled))
      } catch {
        return fail(`Could not ${verb} the agent: the instance could not be reached.`)
      }
      if (ended(r)) return
      const res = r as ApiResult<AgentRecord>
      if (!ok(res)) return fail(`Could not ${verb} the agent (${res.status}).`)
      const updated = res.body!
      set({ kind: 'signed-in', me: before.me, agents: before.agents.map((a) => (a.id === id ? updated : a)) })
    },
  }
}
