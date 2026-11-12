import { sql } from 'kysely'
import { codecs, defineOperation, execute, readAll, step, unit, type PreparedOperation, type Step, type StorageBinding } from '@vault/storage'
import { decodeBase64 } from '../connections/config.js'
import { openToken } from '../connections/credentials.js'
import { record as eventRecord } from '../events/operations.js'
import { feedVisibility } from '../events/operations.js'
import { toEvent, visible, type FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'
import { ScopeSet } from '../scopes.js'
import type { BudgetView } from './budget.js'
import { secretsInForce, signatureHeader } from './signing.js'

// [[API7]] D6 (send half), D7, D8, D9, D12, D15 ([[API220]]): the sender. A Node-safe module taking storage, the registry, `fetch`, the clock, a random source and the key; `compose.ts` runs it after dispatch
// in the per-minute expression. It works in WAVES: each wave claims up to five due rows under a lease of its own (30 s from the claim, a token per wave, attempts counted at the claim), signs, POSTs
// the five concurrently with a 10 s timeout and records every outcome in one batch guarded on the lease token. Claiming per wave, not all 50 at the tick's start, is what keeps every attempt inside
// its own lease: a fetch starts within milliseconds of its claim and ends within 10 s, the lease lasting 30 s, however late in the tick (up to 40 s) the wave starts.
// It writes machinery rows only (D20): no event, no `updated_at`. Response bodies are never read, stored or logged; no log line holds a secret, the key, a url or a body.

export const SEND_LEASE_MS = 30_000
export const ATTEMPT_TIMEOUT_MS = 10_000
/** Rows claimed per tick, per subscription per tick, attempts in flight (a wave), and the point of the tick after which no wave starts (D6). */
export const SEND_TICK_ROWS = 50
export const SEND_SUBSCRIPTION_ROWS = 10
export const SEND_IN_FLIGHT = 5
export const SEND_START_DEADLINE_MS = 40_000
/** The eighth failure ends the row (D9); attempts are counted at claim. */
export const SEND_MAX_ATTEMPTS = 8
/** The delay after the first seven failures (D9), before jitter. */
export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000] as const
export const SEND_JITTER = 0.2
/** D24's pinned cost of a wave: the claim's read and write, the context read, the record. Each fetch is one more. */
export const WAVE_QUERIES = 4

export interface SenderDeps {
  binding: StorageBinding
  registry: Registry
  clock: () => Date
  newId: () => string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** The 32 bytes of `CREDENTIALS_KEY`; null (absent or invalid) means the sender claims nothing and logs the variable's name (D12). */
  key: Uint8Array | null
  /** `[0, 1)`; jitters the retry delay by plus or minus 20 percent. Default `Math.random`. */
  random?: () => number
  /** Runs `fn` after `ms`; returns its cancel. Default `setTimeout`. Injected by tests. */
  after?: (ms: number, fn: () => void) => () => void
  /** D24: asked before each wave; absent means unlimited. */
  budget?: BudgetView
  /** When the tick began; the 40 s start deadline runs from it. Default: when the sender is called. */
  startedAt?: Date
}

export interface SenderSummary {
  /** Delivered (a `2xx`). */
  sent: number
  /** Attempts that failed and were rescheduled. */
  failed: number
  /** Rows ended `dead`: the eighth failure, or attempts spent with a lapsed lease (`sender_failed`). */
  dead: number
  cancelled: number
  /** Rows due and eligible when the sender stopped, left unclaimed (the budget, the tick's row caps or its 40 s). */
  deferred: number
  /** `CREDENTIALS_KEY` was missing or invalid: nothing was claimed. */
  noKey: boolean
}

const SPENT = 'sender_failed'
type FailureCode = 'http_status' | 'redirect' | 'timeout' | 'connection_failed' | typeof SPENT
type CancelCode = 'cancelled_subscription' | 'cancelled_scope'
type Outcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'failed'; code: FailureCode; status: number | null }
  | { kind: 'cancelled'; code: CancelCode }

interface Candidate {
  id: string
  subscriptionId: string
  eventId: string
  /** Attempts before this claim. */
  attempts: number
  url: string
  deleted: boolean
  agentId: string
  scopes: string[]
  agentLive: boolean
  event: FeedEvent | null
}
interface Claimed {
  rows: Candidate[]
  /** The rows this wave claimed (under `token`), the rows it ended dead (spent attempts), and how many due rows the read saw. */
  token: string
  leaseUntil: Date
  dead: number
  totalDue: number
}

const SCOPE_STRING = /^[a-z][a-z0-9_]*:(read|request_approval|write)$/
const iso = (ms: number) => new Date(ms).toISOString()
const organizationOf = (d: SenderDeps): string | null => (d.binding.kind === 'd1' ? d.binding.organizationId : null)
const internal = (organizationId: string) => ({ kind: 'internal' as const, organizationId })

/**
 * The claim of one wave, in one operation: the read picks up to `limit` due rows (a `pending` row due by `cutoff` whose lease is absent or lapsed, of a subscription that is active or deleted: a
 * paused or disabled one is left alone so its attempts do not advance), at most `caps[subscription]` of each subscription; then, only if it found any, one batch ends the spent ones `dead` and
 * leases the rest with a guarded update (`attempts + 1`, `lease_until`, `lease_token`). The batch's result lists what really carries this wave's token or ended dead, so a row another sender took
 * between the read and the write is not ours. No due row means no write.
 */
function claimWave(a: { organizationId: string; cutoff: string; now: string; limit: number; caps: Record<string, number>; token: string; leaseUntil: string; at: string }): PreparedOperation<Claimed> {
  return defineOperation<Claimed>({
    name: 'webhooks.send_claim',
    mutates: true,
    reads: (qc) => ({
      due: readAll(
        sql`with due as (
            select d.id as id, d.subscription_id as subscription_id, d.event_id as event_id, d.attempts as attempts, d.next_attempt_at as next_attempt_at,
              row_number() over (partition by d.subscription_id order by d.next_attempt_at, d.id) as rn
            from webhook_deliveries d
            join webhook_subscriptions s on s.organization_id = d.organization_id and s.id = d.subscription_id
            where d.organization_id = ${a.organizationId} and d.status = 'pending' and d.next_attempt_at <= ${a.cutoff}
              and (d.lease_until is null or d.lease_until <= ${a.now}) and (s.status = 'active' or s.deleted_at is not null)
          )
          select due.id as id, due.subscription_id as subscription_id, due.event_id as event_id, due.attempts as attempts, s.url as url, s.deleted_at as deleted_at, s.agent_id as agent_id,
            ag.scopes as scopes, ag.disabled_at as disabled_at, ag.delegated_by as delegated_by,
            e.id as e_id, e.created_at as e_created_at, e.type as e_type, e.resource_type as e_resource_type, e.resource_id as e_resource_id, e.actor_id as e_actor_id, e."before" as e_before, e."after" as e_after,
            count(*) over () as total_due
          from due
          join webhook_subscriptions s on s.organization_id = ${a.organizationId} and s.id = due.subscription_id
          join agents ag on ag.organization_id = s.organization_id and ag.id = s.agent_id
          left join events e on e.id = due.event_id
          left join json_each(${JSON.stringify(a.caps)}) c on c.key = due.subscription_id
          where due.rn <= coalesce(c.value, ${SEND_SUBSCRIPTION_ROWS})
          order by due.next_attempt_at, due.id
          limit ${a.limit}`.compile(qc.db),
      ),
    }),
    build: (found, qc) => {
      const rows: (Candidate & { totalDue: number })[] = found.all('due').map((r) => ({
        id: String(r.id),
        subscriptionId: String(r.subscription_id),
        eventId: String(r.event_id),
        attempts: Number(r.attempts),
        url: String(r.url),
        deleted: r.deleted_at !== null && r.deleted_at !== undefined,
        agentId: String(r.agent_id),
        scopes: codecs.stringArray.read(r.scopes).filter((s) => SCOPE_STRING.test(s)),
        agentLive: r.disabled_at === null && r.delegated_by === null,
        event: r.e_id === null || r.e_id === undefined ? null : toEvent({ id: r.e_id, created_at: r.e_created_at, type: r.e_type, resource_type: r.e_resource_type, resource_id: r.e_resource_id, actor_id: r.e_actor_id, before: r.e_before, after: r.e_after }),
        totalDue: Number(r.total_due),
      }))
      const totalDue = rows[0]?.totalDue ?? 0
      const spent = rows.filter((r) => r.attempts >= SEND_MAX_ATTEMPTS).map((r) => r.id)
      const claim = rows.filter((r) => r.attempts < SEND_MAX_ATTEMPTS).map((r) => r.id)
      const steps: Step[] = []
      const org = a.organizationId
      if (spent.length > 0)
        steps.push(
          step(
            sql`update "webhook_deliveries" set "status" = 'dead', "last_error" = ${SPENT}, "lease_until" = null, "lease_token" = null
              where "organization_id" = ${org} and "id" in (select value from json_each(${JSON.stringify(spent)})) and "status" = 'pending' and "attempts" >= ${SEND_MAX_ATTEMPTS}
                and ("lease_until" is null or "lease_until" <= ${a.now})`.compile(qc.db),
            'first-mutation',
          ),
        )
      if (claim.length > 0)
        steps.push(
          step(
            sql`update "webhook_deliveries" set "attempts" = "attempts" + 1, "lease_until" = ${a.leaseUntil}, "lease_token" = ${a.token}, "last_attempt_at" = ${a.at}
              where "organization_id" = ${org} and "id" in (select value from json_each(${JSON.stringify(claim)})) and "status" = 'pending' and "attempts" < ${SEND_MAX_ATTEMPTS}
                and "next_attempt_at" <= ${a.cutoff} and ("lease_until" is null or "lease_until" <= ${a.now})
                and exists (select 1 from webhook_subscriptions s where s.organization_id = "webhook_deliveries"."organization_id" and s.id = "webhook_deliveries"."subscription_id" and (s.status = 'active' or s.deleted_at is not null))`.compile(qc.db),
            steps.length === 0 ? 'first-mutation' : undefined,
          ),
        )
      if (steps.length > 0)
        steps.push(
          step(
            sql`select "id", "status", "lease_token" from "webhook_deliveries"
              where "organization_id" = ${org} and "id" in (select value from json_each(${JSON.stringify(rows.map((r) => r.id))})) and ("lease_token" = ${a.token} or "status" = 'dead')`.compile(qc.db),
            'result',
          ),
        )
      return unit({
        steps,
        events: [],
        decode: (result) => {
          const mine = new Set(result.filter((r) => r.lease_token === a.token).map((r) => String(r.id)))
          const dead = result.filter((r) => r.status === 'dead').length
          return { rows: rows.filter((r) => mine.has(r.id)), token: a.token, leaseUntil: new Date(a.leaseUntil), dead, totalDue }
        },
      })
    },
  })
}

interface Context {
  /** Event ids visible to each agent (D3, D19), by agent id. */
  visibleTo: Map<string, Set<string>>
  /** Sealed secrets by subscription, oldest first. */
  secrets: Map<string, { sealed: string; created_at: string }[]>
}

/** The send-time reads of a wave, one batch: per distinct agent, which of its rows' events it could read through `events.get`; per subscription, its sealed secrets. */
function contextRead(a: { organizationId: string; registry: Registry; rows: Candidate[] }): PreparedOperation<Context> {
  const byAgent = new Map<string, Candidate[]>()
  for (const r of a.rows) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r])
  const subs = [...new Set(a.rows.map((r) => r.subscriptionId))]
  return defineOperation<Context>({
    name: 'webhooks.send_context',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, ReturnType<typeof readAll>> = {
        secrets: readAll(sql`select subscription_id, sealed, created_at from webhook_secrets where organization_id = ${a.organizationId} and subscription_id in (${sql.join(subs)}) order by created_at, id`.compile(qc.db)),
      }
      let i = 0
      for (const [agentId, rows] of byAgent) {
        const vis = feedVisibility(a.registry, { scopes: ScopeSet.parse(rows[0]!.scopes), actor: { id: agentId, kind: 'agent' } })
        const seen = visible(vis)
        if (seen !== null) reads[`vis:${agentId}`] = readAll(sql`select id from events where id in (${sql.join(rows.map((r) => r.eventId))}) and ${seen}`.compile(qc.db))
        i++
      }
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const visibleTo = new Map<string, Set<string>>()
          for (const agentId of byAgent.keys()) visibleTo.set(agentId, new Set(found.all(`vis:${agentId}`).map((r) => String(r.id))))
          const secrets = new Map<string, { sealed: string; created_at: string }[]>()
          for (const r of found.all('secrets')) secrets.set(String(r.subscription_id), [...(secrets.get(String(r.subscription_id)) ?? []), { sealed: String(r.sealed), created_at: String(r.created_at) }])
          return { visibleTo, secrets }
        },
      }),
  })
}

interface Recorded {
  row: Candidate
  outcome: Outcome
  /** Failures: the next delay was computed from this attempt number. */
  nextAt: string | null
  dead: boolean
}

/** The record of a wave: ONE batch, one guarded update per row (`id` and `lease_token`), so a stale sender whose lease was taken over changes nothing. */
function recordWave(a: { organizationId: string; token: string; at: string; recorded: Recorded[] }): PreparedOperation<void> {
  return defineOperation<void>({
    name: 'webhooks.send_record',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) => {
      const org = a.organizationId
      const mine = (id: string) => sql`"organization_id" = ${org} and "id" = ${id} and "lease_token" = ${a.token}`
      const steps: Step[] = []
      for (const r of a.recorded) {
        const o = r.outcome
        if (o.kind === 'delivered') {
          steps.push(
            step(
              sql`update "webhook_deliveries" set "status" = 'delivered', "delivered_at" = ${a.at}, "last_status_code" = ${o.status}, "last_error" = null, "lease_until" = null, "lease_token" = null where ${mine(r.row.id)}`.compile(qc.db),
              steps.length === 0 ? 'first-mutation' : undefined,
            ),
            // The stamp D11 reads (API227): only where this record is the one that delivered (a stale sender matched no row above, so no delivered row carries this instant).
            step(
              sql`update "webhook_dispatch_state" set "last_success_at" = ${a.at}
                where "organization_id" = ${org} and "subscription_id" = ${r.row.subscriptionId}
                  and exists (select 1 from "webhook_deliveries" where "id" = ${r.row.id} and "status" = 'delivered' and "delivered_at" = ${a.at})`.compile(qc.db),
            ),
          )
        } else if (o.kind === 'failed') {
          const status = r.dead ? 'dead' : 'pending'
          steps.push(
            step(
              sql`update "webhook_deliveries" set "status" = ${status}, "last_error" = ${o.code}, "last_status_code" = ${o.status}, "next_attempt_at" = coalesce(${r.nextAt}, "next_attempt_at"), "lease_until" = null, "lease_token" = null where ${mine(r.row.id)}`.compile(qc.db),
              steps.length === 0 ? 'first-mutation' : undefined,
            ),
          )
        } else {
          steps.push(
            step(
              sql`update "webhook_deliveries" set "status" = 'cancelled', "last_error" = ${o.code}, "lease_until" = null, "lease_token" = null where ${mine(r.row.id)}`.compile(qc.db),
              steps.length === 0 ? 'first-mutation' : undefined,
            ),
          )
        }
      }
      return unit({ steps, events: [], decode: () => undefined })
    },
  })
}

const defaultAfter = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/** One POST, bounded by the 10 s timer; never reads the response body; never throws. */
async function post(d: SenderDeps, url: string, headers: Record<string, string>, body: string): Promise<Outcome> {
  const controller = new AbortController()
  let timedOut = false
  let expire!: () => void
  const expired = new Promise<'timeout'>((resolve) => (expire = () => resolve('timeout')))
  const cancel = (d.after ?? defaultAfter)(ATTEMPT_TIMEOUT_MS, () => {
    timedOut = true
    controller.abort()
    expire()
  })
  try {
    const pending = d.fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal })
    pending.catch(() => {}) // a fetch that loses the race may still reject later
    const res = await Promise.race([pending, expired])
    if (res === 'timeout') return { kind: 'failed', code: 'timeout', status: null }
    try {
      void res.body?.cancel().catch(() => {}) // the body is never read; free the connection
    } catch {
      /* a body that cannot be cancelled is not an error */
    }
    if (res.type === 'opaqueredirect') return { kind: 'failed', code: 'redirect', status: null }
    if (res.status >= 200 && res.status < 300) return { kind: 'delivered', status: res.status }
    if (res.status >= 300 && res.status < 400) return { kind: 'failed', code: 'redirect', status: res.status }
    return { kind: 'failed', code: 'http_status', status: res.status }
  } catch {
    return { kind: 'failed', code: timedOut ? 'timeout' : 'connection_failed', status: null }
  } finally {
    cancel()
  }
}

/** A secret's plaintext from its sealed text, or null when the key cannot open it. */
async function openSecret(key: Uint8Array, sealed: string): Promise<string | null> {
  try {
    const plain = await openToken(key, sealed)
    return decodeBase64(plain.startsWith('whsec_') ? plain.slice('whsec_'.length) : plain) ? plain : null
  } catch {
    return null
  }
}

/** The next delay after the `attempt`th failure (1-based), jittered by plus or minus 20 percent. */
export function retryDelayMs(attempt: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!
  return Math.round(base * (1 + (random() * 2 - 1) * SEND_JITTER))
}

/** Sends one claimed wave (D6, D7, D8, D12); returns what to record. Never throws: whatever goes wrong with one row is that row's failure. */
async function sendWave(d: SenderDeps, key: Uint8Array, organizationId: string, claimed: Claimed): Promise<Recorded[]> {
  const rows = claimed.rows
  const recorded = new Map<string, Recorded>()
  const fail = (row: Candidate, code: FailureCode, status: number | null): Recorded => {
    const attempt = row.attempts + 1
    const dead = attempt >= SEND_MAX_ATTEMPTS
    return { row, outcome: { kind: 'failed', code, status }, dead, nextAt: dead ? null : iso(d.clock().getTime() + retryDelayMs(attempt, d.random ?? Math.random)) }
  }
  const cancel = (row: Candidate, code: CancelCode): Recorded => ({ row, outcome: { kind: 'cancelled', code }, nextAt: null, dead: false })

  // Cancelled without a read: the subscription is gone; the agent is disabled, delegated, or no longer holds events:read.
  const sendable: Candidate[] = []
  for (const row of rows) {
    if (row.deleted) recorded.set(row.id, cancel(row, 'cancelled_subscription'))
    else if (!row.agentLive || !ScopeSet.parse(row.scopes).has({ resource: 'events', action: 'read' })) recorded.set(row.id, cancel(row, 'cancelled_scope'))
    else sendable.push(row)
  }
  if (sendable.length > 0) {
    const ctx = (await execute(d.binding, internal(organizationId), contextRead({ organizationId, registry: d.registry, rows: sendable }))).value
    await Promise.all(
      sendable.map(async (row) => {
        try {
          if (row.event === null || !ctx.visibleTo.get(row.agentId)?.has(row.eventId)) return void recorded.set(row.id, cancel(row, 'cancelled_scope'))
          const rotation = secretsInForce(ctx.secrets.get(row.subscriptionId) ?? [], d.clock())
          const opened = await Promise.all(rotation.map((s) => openSecret(key, s.sealed)))
          if (rotation.length === 0 || opened.some((s) => s === null)) return void recorded.set(row.id, fail(row, SPENT, null))
          const body = JSON.stringify(eventRecord(organizationId, row.event))
          const timestamp = Math.floor(d.clock().getTime() / 1000)
          const signature = await signatureHeader({ secrets: opened as string[], id: row.eventId, timestamp, body })
          const headers = { 'Content-Type': 'application/json', 'User-Agent': 'vibase-webhooks/1', 'webhook-id': row.eventId, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature }
          const outcome = await post(d, row.url, headers, body)
          recorded.set(row.id, outcome.kind === 'failed' ? fail(row, outcome.code, outcome.status) : { row, outcome, nextAt: null, dead: false })
        } catch {
          recorded.set(row.id, fail(row, SPENT, null))
        }
      }),
    )
  }
  return rows.map((r) => recorded.get(r.id)!)
}

/**
 * The sender half of the per-minute tick (D6): waves of claim, send, record until the tick's caps (50 rows, 10 a subscription, none started after 40 s of the tick) or the budget (D24) say
 * stop. A wave costs `WAVE_QUERIES` plus one fetch per row; it starts only when the budget covers that, with the wave sized to fit. Failures are per row or per wave and are logged by class only.
 */
export async function sendWebhooks(d: SenderDeps): Promise<SenderSummary> {
  const out: SenderSummary = { sent: 0, failed: 0, dead: 0, cancelled: 0, deferred: 0, noKey: false }
  const organizationId = organizationOf(d)
  if (organizationId === null) return out
  if (d.key === null) {
    console.warn('[webhooks] the sender is idle: CREDENTIALS_KEY is absent or invalid, so no delivery is claimed')
    return { ...out, noKey: true }
  }
  const started = (d.startedAt ?? d.clock()).getTime()
  const cutoff = iso(d.clock().getTime())
  const perSubscription: Record<string, number> = {}
  let claimedRows = 0
  let leftover = 0
  for (;;) {
    if (claimedRows >= SEND_TICK_ROWS) break
    if (d.clock().getTime() - started >= SEND_START_DEADLINE_MS) break
    const room = d.budget === undefined ? Infinity : d.budget.remaining() - WAVE_QUERIES
    if (room < 1) break
    const limit = Math.min(SEND_IN_FLIGHT, SEND_TICK_ROWS - claimedRows, room)
    const now = d.clock().getTime()
    const caps: Record<string, number> = {}
    for (const [id, n] of Object.entries(perSubscription)) caps[id] = Math.max(0, SEND_SUBSCRIPTION_ROWS - n)
    let claimed: Claimed
    try {
      claimed = (await execute(d.binding, internal(organizationId), claimWave({ organizationId, cutoff, now: iso(now), limit, caps, token: d.newId(), leaseUntil: iso(now + SEND_LEASE_MS), at: iso(now) }))).value
    } catch (err) {
      console.error(`[webhooks] claiming deliveries failed: ${err instanceof Error ? err.name : 'error'}`)
      throw err
    }
    leftover = Math.max(0, claimed.totalDue - claimed.rows.length - claimed.dead)
    out.dead += claimed.dead
    if (claimed.rows.length === 0) {
      if (leftover > 0 && claimed.dead > 0 && claimedRows + claimed.dead < SEND_TICK_ROWS) {
        claimedRows += claimed.dead
        continue // only spent rows this wave: look again
      }
      break
    }
    claimedRows += claimed.rows.length + claimed.dead
    for (const r of claimed.rows) perSubscription[r.subscriptionId] = (perSubscription[r.subscriptionId] ?? 0) + 1
    const recorded = await sendWave(d, d.key, organizationId, claimed)
    try {
      await execute(d.binding, internal(organizationId), recordWave({ organizationId, token: claimed.token, at: iso(d.clock().getTime()), recorded }))
    } catch (err) {
      // The attempts were made and are counted; the leases lapse and the next tick tries again (D15: at least once).
      console.error(`[webhooks] recording a wave of ${recorded.length} attempt(s) failed: ${err instanceof Error ? err.name : 'error'}`)
      continue
    }
    for (const r of recorded) {
      if (r.outcome.kind === 'delivered') out.sent++
      else if (r.outcome.kind === 'cancelled') out.cancelled++
      else if (r.dead) out.dead++
      else out.failed++
    }
    if (leftover === 0) break // everything due (inside the caps) was in this wave: no need to look again
  }
  out.deferred = leftover
  return out
}
