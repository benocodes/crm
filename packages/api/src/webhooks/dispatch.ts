import type { StorageBinding } from '@vault/storage'
import type { FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'

// [[API7]] D4 ([[API219]]): the dispatcher. STUB for the red commit: it does nothing.

export const PAGE_LIMIT = 100
export const MAX_PAGES = 5

export interface DispatchDeps {
  binding: StorageBinding
  registry: Registry
  clock: () => Date
  newId: () => string
}
export interface DispatchTarget {
  subscriptionId: string
  createdBy: string
  agentId: string
  eventTypes: string[]
  cursor: string
  scopes: string[]
}
export type PagePlan = { kind: 'page'; target: DispatchTarget; events: FeedEvent[]; hasMore: boolean } | { kind: 'unknown_cursor'; target: DispatchTarget }
export interface DispatchSummary {
  subscriptions: number
  events: number
  unknownCursor: number
  failed: number
}

export async function eligibleSubscriptions(_d: DispatchDeps): Promise<DispatchTarget[]> {
  return []
}
export async function readPage(_d: DispatchDeps, target: DispatchTarget): Promise<PagePlan> {
  return { kind: 'page', target, events: [], hasMore: false }
}
export async function applyPage(_d: DispatchDeps, _plan: PagePlan): Promise<{ moved: boolean }> {
  return { moved: false }
}
export async function dispatchWebhooks(_d: DispatchDeps): Promise<DispatchSummary> {
  return { subscriptions: 0, events: 0, unknownCursor: 0, failed: 0 }
}
