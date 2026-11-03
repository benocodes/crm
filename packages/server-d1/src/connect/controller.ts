// Stub (red commit): the implementation follows.
import type { Api } from './api.js'
import type { ClerkLike, Discovery, PageState } from './types.js'

export interface Page {
  state(): PageState
  start(): Promise<void>
  signIn(): Promise<void>
  signOut(): Promise<void>
  setDisabled(id: string, disabled: boolean): Promise<void>
}

export function createPage(_deps: { clerk: ClerkLike; api: Api; discovery: Discovery; origin: string; onChange?: (s: PageState) => void }): Page {
  const nothing = async () => {}
  return { state: () => ({ kind: 'loading' }), start: nothing, signIn: nothing, signOut: nothing, setDisabled: nothing }
}
