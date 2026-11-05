// The sync lease on `mail_sync_state` ([[CHN5]] D11). STUB (red commit).
import type { StorageBinding } from '@vault/storage'

export interface LeaseDeps {
  binding: StorageBinding
  organizationId: string
  clock: () => Date
}
export const LEASE_MS = 5 * 60_000
export async function claimLease(_d: LeaseDeps, _connectionId: string, _runId: string): Promise<boolean> {
  throw new Error('not implemented')
}
export async function extendLease(_d: LeaseDeps, _connectionId: string, _runId: string): Promise<boolean> {
  throw new Error('not implemented')
}
export async function releaseLease(_d: LeaseDeps, _connectionId: string, _runId: string): Promise<void> {
  throw new Error('not implemented')
}
export async function finishPass(_d: LeaseDeps, _connectionId: string, _runId: string, _passStart: string, _keep: boolean): Promise<{ again: boolean; requested: boolean; at: string }> {
  throw new Error('not implemented')
}
