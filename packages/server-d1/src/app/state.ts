// STUB (red commit)
import type { Api } from './session/api.js'
import type { SessionSeam } from './session/types.js'
export type AppState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'signed-out' } | { kind: 'no-access' } | { kind: 'error'; message: string } | { kind: 'ready'; who: { name: string; email: string; role: string; workspaceName: string }; manageAccountHref: string | null; signOutError?: string }
export interface AppController { state(): AppState; subscribe(fn: () => void): () => void; start(): Promise<void>; retry(): Promise<void>; signIn(): Promise<void>; signOut(): Promise<void> }
export function createAppController(_deps: { seam: SessionSeam | null; api: Pick<Api, 'me'>; origin: string; path: string }): AppController {
  const s: AppState = { kind: 'loading' }
  return { state: () => s, subscribe: () => () => {}, start: async () => {}, retry: async () => {}, signIn: async () => {}, signOut: async () => {} }
}
