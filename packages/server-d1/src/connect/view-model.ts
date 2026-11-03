// Stub (red commit): the implementation follows.
import type { PageState, ViewModel } from './types.js'

export function buildView(_state: PageState, _ctx: { origin: string; mcpUrl?: string | null; profileUrl?: string | null }): ViewModel {
  return { state: 'loading', message: null, showSignIn: false, who: null, connect: null, agents: null, account: null, error: null }
}
