// Requesting a sync ([[CHN5]] D11, D74): `sync_requested_at` in its own unit, then one Workflow instance. The row is committed before the instance
// exists, so a run that finishes sees a request that arrived while it ran; an instance that cannot be created leaves the request for the cron.
import { sql } from 'kysely'
import { defineOperation, execute, readSet, step, unit, type StorageBinding } from '@vibase/storage'

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
/** The cron's staleness bound ([[CHN5]] D14). */
export const STALE_MS = 15 * 60_000

/** `sync_requested_at = at` for the connection, in its own unit. Machinery, no event ([[CHN5]] D22). */
export async function markRequested(d: Pick<RequestDeps, 'binding' | 'organizationId'>, connectionId: string, at: string): Promise<void> {
  const op = defineOperation<void>({
    name: 'sync.mark_requested',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [step(qc.db.updateTable('mail_sync_state').set({ sync_requested_at: at }).where('connection_id', '=', connectionId).where('organization_id', '=', d.organizationId))],
        events: [],
        decode: () => undefined,
      }),
  })
  await execute(d.binding, { kind: 'internal', organizationId: d.organizationId }, op)
}

/** The one function every trigger uses. Throws when the instance cannot be created (the request stays recorded). */
export async function requestSync(d: RequestDeps, connectionId: string): Promise<{ requested_at: string; instance_id: string }> {
  const requested_at = d.clock().toISOString()
  await markRequested(d, connectionId, requested_at)
  const id = instanceId(connectionId, d.newId())
  await d.instances.create({ id, params: { connection_id: connectionId } })
  return { requested_at, instance_id: id }
}

/** Active, live connections the cron should request: never synced, stale (15 minutes), expired lease or a recorded request not yet served; never a held lease. */
export async function dueConnections(d: Pick<RequestDeps, 'binding' | 'organizationId'>, now: Date): Promise<string[]> {
  const at = now.toISOString()
  const stale = new Date(now.getTime() - STALE_MS).toISOString()
  const op = defineOperation<string[]>({
    name: 'sync.due_connections',
    mutates: false,
    reads: (qc) => ({
      due: readSet(
        sql`select c.id as id from channel_connections c
          join mail_sync_state s on s.connection_id = c.id and s.organization_id = c.organization_id
          where c.organization_id = ${d.organizationId} and c.deleted_at is null and c.status = 'active'
            and not (s.lease_until is not null and s.lease_until >= ${at})
            and (s.last_success_at is null or s.last_success_at <= ${stale} or (s.lease_until is not null and s.lease_until < ${at})
              or (s.sync_requested_at is not null and (s.last_success_at is null or s.sync_requested_at > s.last_success_at)))
          order by c.id`.compile(qc.db),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('due').map((r) => String(r.id)) }),
  })
  return (await execute(d.binding, { kind: 'internal', organizationId: d.organizationId }, op)).value
}
