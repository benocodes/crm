// The sync lease on `mail_sync_state` ([[CHN5]] D11). Every function is one internal unit of one conditional write plus a `result` select of the row
// as the same batch left it, so "did I get it" is a database fact (D1 runs the batch atomically) and no drift handling is needed. The lease is
// machinery, not a resource: no event (invariant 5, [[CHN5]] D22).
import { sql, type SqlBool } from 'kysely'
import { defineOperation, execute, step, unit, type StorageBinding } from '@vibase/storage'

export interface LeaseDeps {
  binding: StorageBinding
  organizationId: string
  clock: () => Date
}
/** A lease outlives a page by a wide margin; each page step extends it. */
export const LEASE_MS = 5 * 60_000

type LeaseRow = { run_id: string | null; lease_until: string | null; sync_requested_at: string | null }
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** Runs `write` (one statement on `mail_sync_state` for the connection) and reads the row back in the same unit. */
async function leaseUnit(d: LeaseDeps, name: string, connectionId: string, write: (qc: Parameters<NonNullable<Parameters<typeof defineOperation>[0]['build']>>[1]) => ReturnType<typeof step>): Promise<LeaseRow | null> {
  const op = defineOperation<LeaseRow | null>({
    name,
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          write(qc),
          step(
            qc.db.selectFrom('mail_sync_state').select(['mail_sync_state.run_id', 'mail_sync_state.lease_until', 'mail_sync_state.sync_requested_at']).where('mail_sync_state.connection_id', '=', connectionId).where('mail_sync_state.organization_id', '=', d.organizationId),
            'result',
          ),
        ],
        events: [],
        decode: (rows) => (rows[0] ? { run_id: text(rows[0].run_id), lease_until: text(rows[0].lease_until), sync_requested_at: text(rows[0].sync_requested_at) } : null),
      }),
  })
  return (await execute(d.binding, { kind: 'internal', organizationId: d.organizationId }, op)).value
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Takes the lease when it is free, expired, or already this run's (a claim step retried after its unit committed takes its own lease back).
 * False when another run holds an unexpired lease; nothing is written then.
 */
export async function claimLease(d: LeaseDeps, connectionId: string, runId: string): Promise<boolean> {
  const now = d.clock().getTime()
  const row = await leaseUnit(d, 'sync.claim_lease', connectionId, (qc) =>
    step(
      qc.db
        .updateTable('mail_sync_state')
        .set({ lease_until: iso(now + LEASE_MS), run_id: runId })
        .where('connection_id', '=', connectionId)
        .where('organization_id', '=', d.organizationId)
        .where(sql<SqlBool>`("lease_until" is null or "lease_until" < ${iso(now)} or "run_id" = ${runId})`),
    ),
  )
  return row?.run_id === runId
}

/** Pushes the lease out for the run that holds it; false (and nothing written) when the lease is no longer this run's. */
export async function extendLease(d: LeaseDeps, connectionId: string, runId: string): Promise<boolean> {
  const now = d.clock().getTime()
  const row = await leaseUnit(d, 'sync.extend_lease', connectionId, (qc) =>
    step(qc.db.updateTable('mail_sync_state').set({ lease_until: iso(now + LEASE_MS) }).where('connection_id', '=', connectionId).where('organization_id', '=', d.organizationId).where('run_id', '=', runId)),
  )
  return row?.run_id === runId
}

/** Releases the lease when it is this run's (a failure path); anything else is left alone. */
export async function releaseLease(d: LeaseDeps, connectionId: string, runId: string): Promise<void> {
  await leaseUnit(d, 'sync.release_lease', connectionId, (qc) =>
    step(qc.db.updateTable('mail_sync_state').set({ lease_until: null, run_id: null }).where('connection_id', '=', connectionId).where('organization_id', '=', d.organizationId).where('run_id', '=', runId)),
  )
}

/**
 * Ends a pass the run holds the lease for: stamps `last_success_at`, and either keeps the lease (`keep` and a request later than `passStart`: the run
 * does another pass) or releases it, in one batch with the read of `sync_requested_at`, so a request made before the batch is seen and one made after it
 * finds a free lease. `requested` is whether a request later than the pass start exists, kept or not (the caller chains a new instance when it could not keep).
 */
export async function finishPass(d: LeaseDeps, connectionId: string, runId: string, passStart: string, keep: boolean): Promise<{ again: boolean; requested: boolean; at: string }> {
  const at = d.clock().toISOString()
  const wants = sql<SqlBool>`("sync_requested_at" is not null and "sync_requested_at" > ${passStart})`
  const row = await leaseUnit(d, 'sync.finish_pass', connectionId, (qc) =>
    step(
      qc.db
        .updateTable('mail_sync_state')
        .set({
          last_success_at: at,
          lease_until: sql<string | null>`case when ${keep ? 1 : 0} = 1 and ${wants} then ${iso(d.clock().getTime() + LEASE_MS)} else null end` as never,
          run_id: sql<string | null>`case when ${keep ? 1 : 0} = 1 and ${wants} then "run_id" else null end` as never,
        })
        .where('connection_id', '=', connectionId)
        .where('organization_id', '=', d.organizationId)
        .where('run_id', '=', runId),
    ),
  )
  const requested = row?.sync_requested_at != null && row.sync_requested_at > passStart
  return { again: keep && row?.run_id === runId && requested, requested, at }
}
