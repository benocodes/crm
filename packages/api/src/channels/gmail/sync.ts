// Capture pages ([[CHN5]] cycle 3, [[CHN149]]): what one Workflow step will do. Plain async functions, Node-safe, returning plain data.
import type { StorageBinding } from '@vault/storage'
import type { GmailConfig } from '../../connections/config.js'
import type { GoogleEndpoints } from '../../connections/google.js'
import type { ObjectStore } from '../../objects/store.js'
import type { StreamPrimitives } from '../../messaging/streams.js'
import type { GmailClient } from './client.js'

export interface GmailSyncDeps {
  binding: StorageBinding
  organizationId: string
  objects: ObjectStore
  streams: StreamPrimitives
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
  config: Pick<GmailConfig, 'clientId' | 'clientSecret' | 'credentialsKey' | 'keyVersion' | 'backfillDays' | 'attachmentMaxBytes'>
  endpoints?: GoogleEndpoints
  fetch?: typeof fetch
  gmailBaseUrl?: string
  /** Test seam: builds the client over the page's access-token function. Default `HttpGmailClient`. */
  clientFor?: (accessToken: () => Promise<string>) => GmailClient
}

export type Outcome = { outcome: 'reauth' } | { outcome: 'throttled'; retry_after_seconds: number } | { outcome: 'expired' } | { outcome: 'inactive' }
export interface PageDone {
  outcome: 'page'
  next_page_token: string | null
  history_id: string
  captured: number
  existing: number
  skipped: number
}
export type PageResult = PageDone | Outcome
export interface Scan {
  kind: 'backfill' | 'recovery'
  after: number
  /** Recovery: the fresh profile history id, written by the last page only. Backfill: null. */
  history_id: string | null
}
export type ScanStart = { outcome: 'scan'; scan: Scan } | Outcome
export interface SyncState {
  status: string
  deleted_at: string | null
  owner_id: string
  mailbox: string
  history_id: string | null
  page_token: string | null
  last_synced_at: string | null
}

export async function loadSyncState(_deps: GmailSyncDeps, _connectionId: string): Promise<SyncState | null> {
  throw new Error('not implemented')
}
export async function captureHistoryPage(_deps: GmailSyncDeps, _connectionId: string, _opts: { pageToken?: string | null } = {}): Promise<PageResult> {
  throw new Error('not implemented')
}
export async function beginScan(_deps: GmailSyncDeps, _connectionId: string, _kind: 'backfill' | 'recovery'): Promise<ScanStart> {
  throw new Error('not implemented')
}
export async function captureScanPage(_deps: GmailSyncDeps, _connectionId: string, _scan: Scan, _pageToken: string | null): Promise<PageResult> {
  throw new Error('not implemented')
}
