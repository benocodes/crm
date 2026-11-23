import { sql } from 'kysely'
import { defineOperation, execute, readAll, unit, type PreparedOperation, type StorageBinding } from '@vibase/storage'
import { decodeBase64 } from '../connections/config.js'
import { openToken } from '../connections/credentials.js'
import { eventFor, feedVisibility, record as eventRecord } from '../events/operations.js'
import { visible, type FeedEvent } from '../events/feed.js'
import type { Registry } from '../registry.js'
import type { BudgetView } from './budget.js'
import { agentLive, agentScopeSet, readAgentsAndEvents } from './crm-reads.js'
import type { WebhookDeliveryOutcome, WebhooksPort } from './port.js'
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
/** D24's pinned cost of a wave ([[CORE337]]): the claim's read and write (control), the agents and events read (CRM), the visibility read (CRM), the secrets read (control), the record (control). Each fetch is one more. */
export const WAVE_QUERIES = 6

export interface SenderDeps {
  binding: StorageBinding
  /** The control-plane store ([[CORE337]] P5): claims and records, and the secrets. Null: this composition has none and nothing is claimed. */
  port: WebhooksPort | null
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

/** The three Standard Webhooks headers the sender sets on every POST ([[API221]] D21: the guide and the example's verifier are tested against this, not a copy). */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const
/** Every value `webhook_deliveries.last_error` takes, failures then cancellations ([[API221]]: the guide is tested against this list). */
export const DELIVERY_FAILURE_CODES = [
  'timeout',
  'connection_failed',
  'http_status',
  'redirect',
  'sender_failed',
] as const
export const DELIVERY_CANCEL_CODES = ['cancelled_subscription', 'cancelled_scope'] as const
const SPENT = 'sender_failed'
type FailureCode = (typeof DELIVERY_FAILURE_CODES)[number]
type CancelCode = (typeof DELIVERY_CANCEL_CODES)[number]
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
  /** P3: the agent's row is gone from the CRM database: not live, cancelled as `cancelled_subscription`. */
  agentMissing: boolean
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

const iso = (ms: number) => new Date(ms).toISOString()
const organizationOf = (d: SenderDeps): string | null => (d.binding.kind === 'd1' ? d.binding.organizationId : null)
const internal = (organizationId: string) => ({ kind: 'internal' as const, organizationId })

/**
 * The claim of one wave: the control store picks up to `limit` due rows (a `pending` row due by `cutoff` whose lease is absent or lapsed, of a subscription that is active or deleted: a paused or disabled one is left
 * alone so its attempts do not advance), at most `caps[subscription]` of each subscription, ends the spent ones `dead` and leases the rest (`attempts + 1`, `lease_until`, `lease_token`) in one batch; no due row means
 * no write. The rows that really carry this wave's token come back with the subscription facts only. The agent's grants and the event are then read from the CRM by the claimed ids (D3 of [[CORE327]]); an agent
 * whose row is missing is not live (P3).
 */
async function claimWave(
  d: SenderDeps,
  port: WebhooksPort,
  a: {
    organizationId: string
    cutoff: string
    now: string
    limit: number
    caps: Record<string, number>
    token: string
    leaseUntil: string
  },
): Promise<Claimed> {
  const claimed = await port.claim({
    organizationId: a.organizationId,
    cutoff: a.cutoff,
    now: a.now,
    limit: a.limit,
    caps: a.caps,
    defaultCap: SEND_SUBSCRIPTION_ROWS,
    maxAttempts: SEND_MAX_ATTEMPTS,
    token: a.token,
    leaseUntil: a.leaseUntil,
  })
  const facts =
    claimed.rows.length === 0
      ? null
      : (
          await execute(
            d.binding,
            internal(a.organizationId),
            readAgentsAndEvents({
              organizationId: a.organizationId,
              agentIds: [...new Set(claimed.rows.map((r) => r.agentId))],
              eventIds: [...new Set(claimed.rows.map((r) => r.eventId))],
            }),
          )
        ).value
  const rows: Candidate[] = claimed.rows.map((r) => {
    const agent = facts?.agents.get(r.agentId)
    return {
      ...r,
      scopes: agent?.scopes ?? [],
      agentLive: agent !== undefined && agentLive(agent),
      agentMissing: agent === undefined,
      event: facts?.events.get(r.eventId) ?? null,
    }
  })
  return { rows, token: a.token, leaseUntil: new Date(a.leaseUntil), dead: claimed.dead, totalDue: claimed.totalDue }
}

interface Context {
  /** Event ids visible to each agent (D3, D19), by agent id. */
  visibleTo: Map<string, Set<string>>
  /** Sealed secrets by subscription, oldest first. */
  secrets: Map<string, { sealed: string; created_at: string }[]>
}

/** The visibility read of a wave (CRM): per distinct agent, which of its rows' events it could read through `events.get`. */
function visibilityRead(a: { registry: Registry; rows: Candidate[] }): PreparedOperation<Map<string, Set<string>>> {
  const byAgent = new Map<string, Candidate[]>()
  for (const r of a.rows) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r])
  return defineOperation<Map<string, Set<string>>>({
    name: 'webhooks.send_context',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, ReturnType<typeof readAll>> = {}
      for (const [agentId, rows] of byAgent) {
        const vis = feedVisibility(a.registry, {
          scopes: agentScopeSet(a.registry, rows[0]!.scopes),
          actor: { id: agentId, kind: 'agent' },
        })
        const seen = visible(vis)
        if (seen !== null)
          reads[`vis:${agentId}`] = readAll(
            sql`select id from events where id in (${sql.join(rows.map((r) => r.eventId))}) and ${seen}`.compile(qc.db),
          )
      }
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const visibleTo = new Map<string, Set<string>>()
          for (const agentId of byAgent.keys())
            visibleTo.set(agentId, new Set(found.all(`vis:${agentId}`).map((r) => String(r.id))))
          return visibleTo
        },
      }),
  })
}

/** The send-time reads of a wave: the visibility read on the CRM database and the sealed secrets on the control plane. */
async function readContext(
  d: SenderDeps,
  port: WebhooksPort,
  organizationId: string,
  rows: Candidate[],
): Promise<Context> {
  const subs = [...new Set(rows.map((r) => r.subscriptionId))]
  const [visibleTo, found] = await Promise.all([
    execute(d.binding, internal(organizationId), visibilityRead({ registry: d.registry, rows })).then((r) => r.value),
    port.secrets({ subscriptionIds: subs }),
  ])
  const secrets = new Map<string, { sealed: string; created_at: string }[]>()
  for (const r of found)
    secrets.set(r.subscriptionId, [
      ...(secrets.get(r.subscriptionId) ?? []),
      { sealed: r.sealed, created_at: r.createdAt },
    ])
  return { visibleTo, secrets }
}

interface Recorded {
  row: Candidate
  outcome: Outcome
  /** Failures: the next delay was computed from this attempt number. */
  nextAt: string | null
  dead: boolean
}

/** The record of a wave: ONE control batch, one guarded update per row (`id` and `lease_token`), so a stale sender whose lease was taken over changes nothing. */
function outcomesOf(recorded: Recorded[]): WebhookDeliveryOutcome[] {
  return recorded.map((r): WebhookDeliveryOutcome => {
    const base = { id: r.row.id, subscriptionId: r.row.subscriptionId }
    const o = r.outcome
    if (o.kind === 'delivered') return { ...base, kind: 'delivered', statusCode: o.status }
    if (o.kind === 'failed')
      return { ...base, kind: 'failed', code: o.code, statusCode: o.status, nextAttemptAt: r.nextAt, dead: r.dead }
    return { ...base, kind: 'cancelled', code: o.code }
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
async function sendWave(
  d: SenderDeps,
  port: WebhooksPort,
  key: Uint8Array,
  organizationId: string,
  claimed: Claimed,
): Promise<Recorded[]> {
  const rows = claimed.rows
  const recorded = new Map<string, Recorded>()
  const fail = (row: Candidate, code: FailureCode, status: number | null): Recorded => {
    const attempt = row.attempts + 1
    const dead = attempt >= SEND_MAX_ATTEMPTS
    return {
      row,
      outcome: { kind: 'failed', code, status },
      dead,
      nextAt: dead ? null : iso(d.clock().getTime() + retryDelayMs(attempt, d.random ?? Math.random)),
    }
  }
  const cancel = (row: Candidate, code: CancelCode): Recorded => ({
    row,
    outcome: { kind: 'cancelled', code },
    nextAt: null,
    dead: false,
  })

  // Cancelled without a read: the subscription is gone or its agent's row is (P3); the agent is disabled, delegated, or no longer holds events:read.
  const sendable: Candidate[] = []
  for (const row of rows) {
    if (row.deleted || row.agentMissing) recorded.set(row.id, cancel(row, 'cancelled_subscription'))
    else if (!row.agentLive || !agentScopeSet(d.registry, row.scopes).has({ resource: 'events', action: 'read' }))
      recorded.set(row.id, cancel(row, 'cancelled_scope'))
    else sendable.push(row)
  }
  if (sendable.length > 0) {
    const ctx = await readContext(d, port, organizationId, sendable)
    await Promise.all(
      sendable.map(async (row) => {
        try {
          if (row.event === null || !ctx.visibleTo.get(row.agentId)?.has(row.eventId))
            return void recorded.set(row.id, cancel(row, 'cancelled_scope'))
          const rotation = secretsInForce(ctx.secrets.get(row.subscriptionId) ?? [], d.clock())
          const opened = await Promise.all(rotation.map((s) => openSecret(key, s.sealed)))
          if (rotation.length === 0 || opened.some((s) => s === null))
            return void recorded.set(row.id, fail(row, SPENT, null))
          // [[API514]] D11: the payload is the event as the agent's stored scopes may see it, projected like `events.get` (the stored event stays whole).
          const caller = {
            scopes: agentScopeSet(d.registry, row.scopes),
            actor: { id: row.agentId, kind: 'agent' as const },
          }
          const body = JSON.stringify(eventRecord(organizationId, eventFor(d.registry, caller, row.event)))
          const timestamp = Math.floor(d.clock().getTime() / 1000)
          const signature = await signatureHeader({ secrets: opened as string[], id: row.eventId, timestamp, body })
          const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'vibase-webhooks/1',
            [WEBHOOK_HEADERS.id]: row.eventId,
            [WEBHOOK_HEADERS.timestamp]: String(timestamp),
            [WEBHOOK_HEADERS.signature]: signature,
          }
          const outcome = await post(d, row.url, headers, body)
          recorded.set(
            row.id,
            outcome.kind === 'failed'
              ? fail(row, outcome.code, outcome.status)
              : { row, outcome, nextAt: null, dead: false },
          )
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
  if (organizationId === null || d.port === null) return out
  const port = d.port
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
      claimed = await claimWave(d, port, {
        organizationId,
        cutoff,
        now: iso(now),
        limit,
        caps,
        token: d.newId(),
        leaseUntil: iso(now + SEND_LEASE_MS),
      })
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
    const recorded = await sendWave(d, port, d.key, organizationId, claimed)
    try {
      await port.record({ token: claimed.token, at: iso(d.clock().getTime()), outcomes: outcomesOf(recorded) })
    } catch (err) {
      // The attempts were made and are counted; the leases lapse and the next tick tries again (D15: at least once).
      console.error(
        `[webhooks] recording a wave of ${recorded.length} attempt(s) failed: ${err instanceof Error ? err.name : 'error'}`,
      )
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
