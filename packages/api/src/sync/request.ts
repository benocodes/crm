// Requesting a sync ([[CHN5]] D11, D74): `sync_requested_at` in its own unit, then one Workflow instance. STUB (red commit).
import type { StorageBinding } from '@vault/storage'

export interface MailSyncParams {
  connection_id: string
}
/** The Workflow binding's surface the vault uses: `MAIL_SYNC.create`. */
export interface MailSyncInstances {
  create(options: { id: string; params: MailSyncParams }): Promise<unknown>
}
export interface RequestDeps {
  binding: StorageBinding
  organizationId: string
  clock: () => Date
  newId: () => string
  instances: MailSyncInstances
}
export const instanceId = (connectionId: string, uuid: string): string => `mail-sync-${connectionId}-${uuid}`

export async function markRequested(_d: Pick<RequestDeps, 'binding' | 'organizationId'>, _connectionId: string, _at: string): Promise<void> {
  throw new Error('not implemented')
}
export async function requestSync(_d: RequestDeps, _connectionId: string): Promise<{ requested_at: string; instance_id: string }> {
  throw new Error('not implemented')
}
/** Active, live connections the cron should request: never synced, stale (15 minutes) or expired lease; never a held lease. */
export async function dueConnections(_d: Pick<RequestDeps, 'binding' | 'organizationId'>, _now: Date): Promise<string[]> {
  throw new Error('not implemented')
}
