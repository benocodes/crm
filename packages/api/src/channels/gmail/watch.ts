// The watch lifecycle ([[CHN5]] D89, D90, D91): register at connect, renew in the cron, stop on delete.
import type { GmailConfig } from '../../connections/config.js'
import type { GoogleEndpoints } from '../../connections/google.js'
import type { StorageBinding } from '@vault/storage'
import type { GmailClient } from './client.js'

export const WATCH_RENEW_BEFORE_MS = 6 * 86_400_000
export type WatchFailureClass = 'reauth_required' | 'throttled' | 'misconfigured' | 'failed'

export interface WatchDeps {
  binding: StorageBinding
  organizationId: string
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
  config: Pick<GmailConfig, 'clientId' | 'clientSecret' | 'credentialsKey' | 'keyVersion'>
  topicName: string
  endpoints?: GoogleEndpoints
  fetch?: typeof fetch
  gmailBaseUrl?: string
  clientFor?: (accessToken: () => Promise<string>) => GmailClient
}
export interface RenewResult {
  attempted: number
  registered: number
  failed: Partial<Record<WatchFailureClass, number>>
}

export function classifyWatchFailure(_err: unknown): WatchFailureClass {
  return 'failed'
}
export async function renewWatches(_d: WatchDeps): Promise<RenewResult> {
  return { attempted: 0, registered: 0, failed: {} }
}
