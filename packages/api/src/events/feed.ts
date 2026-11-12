import type { PreparedOperation } from '@vault/storage'

// API105 stub (red commit): the real program arrives with the implementation commit.
export interface FeedEvent {
  id: string
  created_at: string
  type: string
  resource_type: string
  resource_id: string
  actor_id: string
  before: unknown
  after: unknown
}
export type StableFeed = { status: 'unknown_cursor' } | { status: 'ok'; events: FeedEvent[]; has_more: boolean }
export function readStableFeed(_d: { readable: readonly string[]; types?: readonly string[]; after: string | null; limit: number }): PreparedOperation<StableFeed> {
  return { name: 'events.feed', mutates: false, reads: () => ({}), build: () => ({ steps: [], events: [], decode: () => ({ status: 'ok', events: [], has_more: false }) }) } as unknown as PreparedOperation<StableFeed>
}
