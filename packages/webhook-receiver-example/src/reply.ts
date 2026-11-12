// The Workflow's body. Stub: the red commit ([[API221]]).
import type { VaultDeps } from './vault.js'
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, config: StepConfigLike, fn: () => Promise<T>): Promise<T>
}
export interface StepConfigLike {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeout?: string | number
}
export type ReplyOutcome = { outcome: 'proposed'; request_id: string; created: boolean } | { outcome: 'skipped'; reason: string }
export function draftReply(_message: { from: string; content: string }): string {
  return ''
}
export async function runReply(_event: { payload: unknown }, _step: StepLike, _deps: VaultDeps): Promise<ReplyOutcome> {
  return { outcome: 'skipped', reason: 'stub' }
}
