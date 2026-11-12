import type { StorageBinding } from '@vault/storage'
import type { Registry } from '../registry.js'
import type { BudgetView } from './budget.js'

// [[API7]] D6, D7, D8, D9, D12, D15 ([[API220]]): STUB for the red commit.
export interface SenderDeps {
  binding: StorageBinding
  registry: Registry
  clock: () => Date
  newId: () => string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  key: Uint8Array | null
  random?: () => number
  after?: (ms: number, fn: () => void) => () => void
  budget?: BudgetView
  startedAt?: Date
}
export interface SenderSummary {
  sent: number
  failed: number
  dead: number
  cancelled: number
  deferred: number
  noKey: boolean
}
export async function sendWebhooks(_d: SenderDeps): Promise<SenderSummary> {
  return { sent: 0, failed: 0, dead: 0, cancelled: 0, deferred: 0, noKey: false }
}
