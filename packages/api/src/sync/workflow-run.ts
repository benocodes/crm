// The sync run ([[CHN5]] D11, D12, D16, D33, D37, D66): Node-safe orchestrator. `MailSyncWorkflow` (in `@vault/server-d1`, which imports
// `cloudflare:workers`) delegates here with Cloudflare's `step`; tests pass the workerd step shim.
//
// Rules this file keeps (`cloudflare-workflows`): every non-determinism (the run id, the start time) is captured by the `seed` step; every step re-resolves
// the runtime from `resolve()` and returns only plain data (ids, counts, page tokens, history ids, bounds, outcomes: never a client, a resolver, a row or a
// token); business outcomes cross the step boundary as return values, never as error classes. Step names are unique per instance (`p<pass>-…`).
import { execute } from '@vault/storage'
import type { Role, ScopePolicy } from '../auth/roles.js'
import { scopesForRole } from '../auth/roles.js'
import { beginScan, captureHistoryPage, captureScanPage, loadSyncState, markConnectionStatus, type GmailSyncDeps, type PageResult, type Scan, type ScanStart } from '../channels/gmail/sync.js'
import { userSubjectOperation } from '../connections/callback.js'
import { claimLease, extendLease, finishPass, releaseLease, type LeaseDeps } from './lease.js'
import { instanceId, type MailSyncInstances, type MailSyncParams } from './request.js'

export interface StepConfig {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeout?: string | number
}
export interface WorkflowStepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>
  sleep(name: string, duration: string | number): Promise<void>
}
export interface WorkflowEventLike<P> {
  payload: P
}
/** What every step re-resolves from module factories; none of it is ever returned from a step. */
export interface MailSyncRuntime {
  pages: GmailSyncDeps
  /** Throws retryably while the database is `behind` ([[CHN5]] D37). */
  gate: () => Promise<void>
  /** The role source ([[CHN5]] D33): null role = not admitted, a throw = cannot say (retryable). Null here: no auth provider, so no human credential and no check. */
  roleOf: ((authSubject: string) => Promise<Role | null>) | null
  policy: ScopePolicy
  declaredScopes: readonly string[]
  instances: MailSyncInstances
}
export type MailSyncEnd = 'complete' | 'held' | 'inactive' | 'suspended' | 'reauth' | 'lease_lost'
export interface MailSyncSummary {
  end: MailSyncEnd
  passes: number
}

export const MAX_PASSES = 3
export const MAX_THROTTLES = 5
/** Shorter than the lease, so a page that outlives its step timeout cannot outlive its lease. */
const PAGE_STEP: StepConfig = { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '4 minutes' }
const SHORT_STEP: StepConfig = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }

type Claim = { claimed: true; owner_id: string; needs_backfill: boolean } | { claimed: false; reason: 'held' | 'inactive' | 'suspended' }
type PageOutcome = PageResult | ScanStart | { outcome: 'lease_lost' }
type Stop = Exclude<MailSyncEnd, 'complete' | 'held' | 'suspended'>

const leaseOf = (rt: MailSyncRuntime): LeaseDeps => ({ binding: rt.pages.binding, organizationId: rt.pages.organizationId, clock: rt.pages.clock })

/** The claim ([[CHN5]] D11, D33): the connection must be live and active, its owner admitted (else `suspended`, one event), and the lease free. */
async function claim(rt: MailSyncRuntime, connectionId: string, runId: string): Promise<Claim> {
  const deps = rt.pages
  const state = await loadSyncState(deps, connectionId)
  if (!state || state.status !== 'active' || state.deleted_at !== null) return { claimed: false, reason: 'inactive' }
  if (rt.roleOf !== null) {
    // A failed lookup throws here and the step retries; nothing has been written.
    const subject = (await execute(deps.binding, { kind: 'tenant', actorId: state.owner_id, organizationId: deps.organizationId }, userSubjectOperation(state.owner_id))).value
    const role = subject === null ? null : await rt.roleOf(subject)
    if (role === null || !scopesForRole(role, rt.declaredScopes, rt.policy).has({ resource: 'connections', action: 'write' })) {
      await markConnectionStatus(deps, connectionId, state.owner_id, 'suspended', 'owner_not_admitted')
      return { claimed: false, reason: 'suspended' }
    }
  }
  if (!(await claimLease(leaseOf(rt), connectionId, runId))) return { claimed: false, reason: 'held' }
  return { claimed: true, owner_id: state.owner_id, needs_backfill: state.last_synced_at === null }
}

export async function runMailSync(event: WorkflowEventLike<MailSyncParams>, step: WorkflowStepLike, resolve: () => Promise<MailSyncRuntime> | MailSyncRuntime): Promise<MailSyncSummary> {
  const connectionId = event.payload.connection_id

  // Captured once: a replay re-reads these from the step, never from the clock.
  const seed = await step.do('seed', SHORT_STEP, async () => {
    const rt = await resolve()
    await rt.gate()
    return { run_id: rt.pages.newId(), started_at: rt.pages.clock().toISOString() }
  })
  const runId = seed.run_id

  const claimed = await step.do('claim', SHORT_STEP, async () => {
    const rt = await resolve()
    await rt.gate()
    return claim(rt, connectionId, runId)
  })
  if (!claimed.claimed) return { end: claimed.reason, passes: 0 }

  /** One page-shaped step: gate, extend the lease (a run that lost it writes nothing), then the body. A throttle sleeps and repeats the same page. */
  const page = async <T extends PageOutcome>(name: string, body: (deps: GmailSyncDeps) => Promise<T>): Promise<T | { outcome: 'lease_lost' }> => {
    for (let throttles = 0; ; ) {
      const r = await step.do(throttles === 0 ? name : `${name}-t${throttles}`, PAGE_STEP, async (): Promise<T | { outcome: 'lease_lost' }> => {
        const rt = await resolve()
        await rt.gate()
        if (!(await extendLease(leaseOf(rt), connectionId, runId))) return { outcome: 'lease_lost' }
        return body(rt.pages)
      })
      if (r.outcome !== 'throttled') return r
      if (++throttles > MAX_THROTTLES) throw new Error(`Gmail throttled the page ${throttles} times`)
      await step.sleep(`${name}-sleep-${throttles}`, `${(r as { retry_after_seconds: number }).retry_after_seconds} seconds`)
    }
  }

  /** A scan (D66): its bound and tokens are carried here, in step returns. Null when it finished; else why the run stops. */
  const scan = async (pass: number, kind: 'backfill' | 'recovery'): Promise<Stop | null> => {
    const begun = await page(`p${pass}-begin-${kind}`, (d) => beginScan(d, connectionId, kind))
    if (begun.outcome !== 'scan') return stopOf(begun.outcome)
    const s: Scan = begun.scan
    let token: string | null = null
    for (let n = 1; ; n++) {
      const r = await page(`p${pass}-${kind}-${n}`, (d) => captureScanPage(d, connectionId, s, token))
      if (r.outcome !== 'page') return stopOf(r.outcome)
      if (r.next_page_token === null) return null
      token = r.next_page_token
    }
  }

  const walk = async (pass: number, backfill: boolean): Promise<Stop | null> => {
    if (backfill) {
      const stopped = await scan(pass, 'backfill')
      if (stopped) return stopped
    }
    let recovered = false
    for (let k = 1; ; k++) {
      // The history page resumes from the cursor's stored page token, so a new run after a kill continues where the last one stopped.
      const r = await page(`p${pass}-history-${k}`, (d) => captureHistoryPage(d, connectionId))
      if (r.outcome === 'page') {
        if (r.next_page_token === null) return null
        continue
      }
      if (r.outcome === 'expired') {
        if (recovered) throw new Error('Gmail history expired again right after a recovery scan')
        recovered = true
        const stopped = await scan(pass, 'recovery')
        if (stopped) return stopped
        continue
      }
      return stopOf(r.outcome)
    }
  }

  let passStart = seed.started_at
  let backfill = claimed.needs_backfill
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const stopped = await walk(pass, backfill)
    if (stopped) {
      // `reauth` and `inactive` end the run and give the lease back; `lease_lost` is somebody else's lease to keep.
      if (stopped !== 'lease_lost') {
        await step.do('record-failure', SHORT_STEP, async () => {
          const rt = await resolve()
          await releaseLease(leaseOf(rt), connectionId, runId)
          return { released: true }
        })
      }
      return { end: stopped, passes: pass }
    }
    backfill = false
    const fin = await step.do(`p${pass}-finish`, SHORT_STEP, async () => {
      const rt = await resolve()
      await rt.gate()
      return finishPass(leaseOf(rt), connectionId, runId, passStart, pass < MAX_PASSES)
    })
    if (fin.again) {
      passStart = fin.at
      continue
    }
    // Still requested after the last pass: a new instance serves it (D11).
    if (fin.requested && pass === MAX_PASSES) {
      await step.do('chain', SHORT_STEP, async () => {
        const rt = await resolve()
        const id = instanceId(connectionId, rt.pages.newId())
        await rt.instances.create({ id, params: { connection_id: connectionId } })
        return { chained: true }
      })
    }
    return { end: 'complete', passes: pass }
  }
  return { end: 'complete', passes: MAX_PASSES }
}

function stopOf(outcome: string): Stop {
  if (outcome === 'reauth' || outcome === 'inactive' || outcome === 'lease_lost') return outcome
  throw new Error(`unexpected page outcome: ${outcome}`)
}
