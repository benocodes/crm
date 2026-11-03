// Stub (red commit): the implementation follows.
import type { ViewModel } from './types.js'

export interface Handlers {
  signIn(): void
  signOut(): void
  toggle(id: string, disabled: boolean): void
}

export function render(_root: HTMLElement, _vm: ViewModel, _handlers: Handlers): void {}
