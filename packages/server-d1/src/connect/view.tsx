import type { ViewModel } from './types.js'

export interface Handlers {
  signIn(): void
  signOut(): void
  toggle(id: string, disabled: boolean): void
}

/** Red-commit stub: the real component arrives in the green commit. */
export function ConnectView(_props: { vm: ViewModel; handlers: Handlers }) {
  return null
}
