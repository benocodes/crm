// The watch lifecycle ([[CHN5]] D89, D90, D91): register at connect (the callback), renew in the cron, stop on delete (`connections.delete`'s after stage).
// `gmail_watches` is channel machinery (invariant 5, D22): nothing here emits an event except `invalid_grant`'s `reauth_required`, which is D16's own.
import { sql } from 'kysely'
import { defineOperation, execute, readSet, step, unit, type Step, type StorageBinding } from '@vault/storage'
import type { GmailConfig } from '../../connections/config.js'
import { GoogleRefreshError, refreshAccessToken, type GoogleEndpoints, GOOGLE_ENDPOINTS } from '../../connections/google.js'
import { openToken } from '../../connections/credentials.js'
import { GmailApiError, HttpGmailClient, isGmailThrottle, type GmailClient } from './client.js'
import { gmailClientFor, markConnectionStatus } from './sync.js'

/** A watch with less than this left is renewed (Google asks for a call at least every 7 days; daily is its recommendation). */
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
  /** Test seam: builds the client over the connection's access-token function. Default `HttpGmailClient`. */
  clientFor?: (accessToken: () => Promise<string>) => GmailClient
}
export interface RenewResult {
  attempted: number
  registered: number
  failed: Partial<Record<WatchFailureClass, number>>
}

/** The failure classes of D90. A refresh `invalid_grant` is D16's verdict on the grant; a throttle is a `429` or a rate-limit `403`; any other `403` (the topic's publisher grant), `400` or `404` is the deployment's setup. */
export function classifyWatchFailure(err: unknown): WatchFailureClass {
  if (err instanceof GoogleRefreshError && err.code === 'invalid_grant') return 'reauth_required'
  if (isGmailThrottle(err)) return 'throttled'
  if (err instanceof GmailApiError && (err.status === 403 || err.status === 400 || err.status === 404)) return 'misconfigured'
  return 'failed'
}

/** What a failure says about itself, for a log line: Google's status and `errors[].reason`, or the error's name. Never the address, token, topic or any provider text. */
function describe(err: unknown): string {
  if (err instanceof GmailApiError) return `status=${err.status}${err.reason ? ` reason=${err.reason}` : ''}`
  return `error=${err instanceof Error ? err.name : 'error'}`
}

const isoOfExpiration = (expiration: string): string => new Date(Number(expiration)).toISOString()

/** The `gmail_watches` upsert ([[CHN5]] D89), one statement: `ON CONFLICT` (invariant 3), so a row inserted between a read and this write is updated, not a violation. */
export function watchUpsertStep(qc: Parameters<Parameters<typeof defineOperation>[0]['build']>[1], p: { connectionId: string; organizationId: string; ownerId: string; mailbox: string; at: string; expiresAt: string }): Step {
  return step(
    qc.db
      .insertInto('gmail_watches')
      .values({ connection_id: p.connectionId, organization_id: p.organizationId, created_by: p.ownerId, created_at: p.at, mailbox: p.mailbox, expires_at: p.expiresAt })
      .onConflict((oc) => oc.column('connection_id').doUpdateSet({ mailbox: p.mailbox, expires_at: p.expiresAt })),
  )
}

/** `users.watch` for the connect flow, never throwing ([[CHN5]] D89): the expiry as an ISO timestamp, or the failure's class for the log. */
export async function watchAtConnect(client: GmailClient, topicName: string): Promise<{ ok: true; expires_at: string } | { ok: false; klass: WatchFailureClass; detail: string }> {
  try {
    const w = await client.watch({ topicName })
    return { ok: true, expires_at: isoOfExpiration(w.expiration) }
  } catch (err) {
    return { ok: false, klass: classifyWatchFailure(err), detail: describe(err) }
  }
}

interface Candidate {
  id: string
  owner_id: string
  mailbox: string
}

/** Live, `active` connections with no watch row or one that ends within the renewal margin. */
async function candidates(d: WatchDeps, now: Date): Promise<Candidate[]> {
  const threshold = new Date(now.getTime() + WATCH_RENEW_BEFORE_MS).toISOString()
  const op = defineOperation<Candidate[]>({
    name: 'gmail.watch_candidates',
    mutates: false,
    reads: (qc) => ({
      due: readSet(
        sql`select c.id as id, c.owner_id as owner_id, i.value as mailbox from channel_connections c
          join identities i on i.id = c.identity_id and i.organization_id = c.organization_id
          left join gmail_watches w on w.connection_id = c.id and w.organization_id = c.organization_id
          where c.organization_id = ${d.organizationId} and c.deleted_at is null and c.status = 'active' and (w.connection_id is null or w.expires_at < ${threshold})
          order by c.id`.compile(qc.db),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('due').map((r) => ({ id: String(r.id), owner_id: String(r.owner_id), mailbox: String(r.mailbox).toLowerCase() })) }),
  })
  return (await execute(d.binding, { kind: 'internal', organizationId: d.organizationId }, op)).value
}

/**
 * The cron's renewal ([[CHN5]] D89, D90): one watch call for each candidate, its own small unit for the row, and one failure never stops the others. No retry within
 * a tick: the next tick is the retry. `invalid_grant` takes D16's path (`reauth_required`, with its event).
 */
export async function renewWatches(d: WatchDeps): Promise<RenewResult> {
  const out: RenewResult = { attempted: 0, registered: 0, failed: {} }
  const now = d.clock()
  for (const c of await candidates(d, now)) {
    out.attempted++
    try {
      const client = gmailClientFor(d, c.id, c.owner_id)
      const w = await client.watch({ topicName: d.topicName })
      const expiresAt = isoOfExpiration(w.expiration)
      const at = d.clock().toISOString()
      const op = defineOperation<void>({
        name: 'gmail.renew_watch',
        mutates: true,
        reads: () => ({}),
        build: (_found, qc) => unit({ steps: [watchUpsertStep(qc, { connectionId: c.id, organizationId: d.organizationId, ownerId: c.owner_id, mailbox: c.mailbox, at, expiresAt })], events: [], decode: () => undefined }),
      })
      await execute(d.binding, { kind: 'internal', organizationId: d.organizationId }, op)
      out.registered++
    } catch (err) {
      const klass = classifyWatchFailure(err)
      out.failed[klass] = (out.failed[klass] ?? 0) + 1
      console.warn(`[watch] renewal ${klass} connection=${c.id} ${describe(err)}`)
      if (klass === 'reauth_required') {
        try {
          await markConnectionStatus(d, c.id, c.owner_id, 'reauth_required', 'invalid_grant')
        } catch (inner) {
          console.error(`[watch] could not mark connection ${c.id} reauth_required: ${inner instanceof Error ? inner.name : 'error'}`)
        }
      }
    }
  }
  return out
}

/**
 * `users.stop` for a deleted connection ([[CHN5]] D91): best effort, after the delete's unit committed. The access token is refreshed from the deleted credential's
 * ciphertext, held in memory (the row is gone); the credential is not rotated. Never throws.
 */
export async function stopWatch(d: {
  config: Pick<GmailConfig, 'clientId' | 'clientSecret' | 'credentialsKey' | 'keyVersion'>
  ciphertext: string
  keyVersion: number
  connectionId: string
  endpoints?: GoogleEndpoints
  fetch?: typeof fetch
  gmailBaseUrl?: string
}): Promise<void> {
  try {
    if (d.keyVersion !== d.config.keyVersion) throw new Error('credential_key_mismatch')
    const refreshToken = await openToken(d.config.credentialsKey, d.ciphertext)
    const doFetch = d.fetch ?? ((i, n) => fetch(i, n))
    const refreshed = await refreshAccessToken({ endpoints: d.endpoints ?? GOOGLE_ENDPOINTS, clientId: d.config.clientId, clientSecret: d.config.clientSecret, refreshToken, fetch: doFetch })
    await new HttpGmailClient({ accessToken: async () => refreshed.accessToken, fetch: doFetch, ...(d.gmailBaseUrl ? { baseUrl: d.gmailBaseUrl } : {}) }).stop()
  } catch (err) {
    console.warn(`[watch] stop failed for deleted connection ${d.connectionId}: ${err instanceof GoogleRefreshError ? `refresh_${err.code}` : describe(err)}`)
  }
}
