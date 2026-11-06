// `POST /gmail/push` ([[CHN5]] D15, D87, D88): Pub/Sub's authenticated push of a Gmail notification, and the sync it requests.
//
// Order, each step before the next: push is on (else 404); the bearer is present and JWT-shaped with an RS256 header (else 401, and no JWKS fetch, so an
// unauthenticated caller cannot make the Worker call Google); the JWKS is fetched per request through the injected `fetch` (a failure is 503 so Pub/Sub retries);
// the token's signature, `iss`, `aud`, `email`, `email_verified` and `exp` (401); only then the body, capped at 64 KiB, whose `subscription` must be ours (401).
// A verified notification that does not decode is 204 (a 4xx would be retried for days). `historyId` is never read: the run reads history from its own cursor.
import { sql } from 'kysely'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import type { Context } from 'hono'
import { defineOperation, execute, readSet, unit, uuidv7, type D1Binding, type StorageBinding } from '@vault/storage'
import type { PushConfig } from '../../connections/config.js'
import { instanceId, markRequested, type MailSyncInstances } from '../../sync/request.js'

export const PUSH_PATH = '/gmail/push'
/** Google's signing keys. A constant: tests inject it only through the composition's `fetch`, never a variable ([[CHN5]] D87). */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const BODY_LIMIT = 64 * 1024
const CLOCK_TOLERANCE_S = 30
/** An unserved request younger than this is waiting for its instance to claim the lease ([[CHN5]] D88). */
export const COALESCE_MS = 60_000
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export interface PushDeps {
  /** Null: push is off, the route answers 404 ([[CHN5]] D87). */
  push: PushConfig | null
  fetch: typeof fetch
  instances?: MailSyncInstances
  storage: (c: Context) => StorageBinding
  clock?: () => Date
  newId?: () => string
}

const error = (c: Context, status: 401 | 404 | 500 | 501 | 503, code: string, message: string): Response => c.json({ error: { code, message } }, status)

/** The request body as text, or null when it exceeds `limit` bytes (read as a stream: an oversized body is never held whole). */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limit) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return new TextDecoder().decode(all)
}

/** base64 or base64url (padded or not) to text; null when it is neither. */
function decodeData(data: string): string | null {
  try {
    const t = data.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))
  } catch {
    return null
  }
}

type Watched = { id: string; lease_until: string | null; last_success_at: string | null; sync_requested_at: string | null }
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** The live, `active` connections watching `mailbox`, with the lease and request columns the coalescing decision reads. */
async function watched(binding: D1Binding, mailbox: string): Promise<Watched[]> {
  const organizationId = binding.organizationId
  const op = defineOperation<Watched[]>({
    name: 'gmail.push_lookup',
    mutates: false,
    reads: (qc) => ({
      watched: readSet(
        sql`select c.id as id, s.lease_until as lease_until, s.last_success_at as last_success_at, s.sync_requested_at as sync_requested_at
          from gmail_watches w
          join channel_connections c on c.id = w.connection_id and c.organization_id = w.organization_id
          join mail_sync_state s on s.connection_id = c.id and s.organization_id = c.organization_id
          where w.organization_id = ${organizationId} and w.mailbox = ${mailbox} and c.deleted_at is null and c.status = 'active'
          order by c.id`.compile(qc.db),
      ),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('watched').map((r) => ({ id: String(r.id), lease_until: text(r.lease_until), last_success_at: text(r.last_success_at), sync_requested_at: text(r.sync_requested_at) })) }),
  })
  return (await execute(binding, { kind: 'internal', organizationId }, op)).value
}

export function gmailPushHandler(d: PushDeps): (c: Context) => Promise<Response> {
  return async (c) => {
    const push = d.push
    if (!push) return error(c, 404, 'not_found', 'no such route')
    const binding = d.storage(c)
    if (binding.kind !== 'd1') return error(c, 501, 'not_implemented', 'Gmail push is implemented for D1 only')
    const refuse = (why: string): Response => {
      console.warn(`[gmail-push] refused: ${why}`)
      return error(c, 401, 'unauthenticated', 'invalid push credentials')
    }

    // 1. The bearer, before anything else: no fetch for a request that cannot carry a valid token.
    const m = /^Bearer ([^\s]+)$/i.exec(c.req.header('authorization') ?? '')
    const jwt = m?.[1]
    if (!jwt || !JWT_SHAPE.test(jwt)) return refuse('bearer')
    try {
      if (decodeProtectedHeader(jwt).alg !== 'RS256') return refuse('alg')
    } catch {
      return refuse('header')
    }

    // 2. Google's keys, per request (no cache: a rotation is never hidden). A failure to get them is Pub/Sub's to retry.
    const clock = d.clock ?? (() => new Date())
    let keys: ReturnType<typeof createLocalJWKSet>
    try {
      const res = await d.fetch(GOOGLE_JWKS_URL)
      if (!res.ok) throw new Error('jwks status')
      keys = createLocalJWKSet((await res.json()) as Parameters<typeof createLocalJWKSet>[0])
    } catch {
      console.warn('[gmail-push] the JWKS could not be fetched')
      return error(c, 503, 'jwks_unavailable', 'Google signing keys are unavailable; retry')
    }

    // 3. The token.
    try {
      const { payload } = await jwtVerify(jwt, keys, { issuer: ISSUERS, audience: push.audience, algorithms: ['RS256'], clockTolerance: CLOCK_TOLERANCE_S, currentDate: clock(), requiredClaims: ['exp'] })
      if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== push.serviceAccount) return refuse('email')
      if (payload.email_verified !== true) return refuse('email_verified')
    } catch {
      return refuse('token')
    }

    // 4. The body, only now, and the subscription it names.
    const raw = await readCapped(c.req.raw, BODY_LIMIT)
    if (raw === null) {
      console.warn('[gmail-push] body over the 64 KiB limit: acknowledged and dropped')
      return c.body(null, 204)
    }
    let envelope: { subscription?: unknown; message?: { data?: unknown } } = {}
    try {
      envelope = JSON.parse(raw) as typeof envelope
    } catch {
      return refuse('body')
    }
    if (envelope.subscription !== push.subscription) return refuse('subscription')

    // 5. The notification. Anything that does not decode is acknowledged: a retry cannot make it decode.
    let mailbox: string | null = null
    const data = typeof envelope.message?.data === 'string' ? decodeData(envelope.message.data) : null
    if (data !== null) {
      try {
        const n = JSON.parse(data) as { emailAddress?: unknown }
        if (typeof n.emailAddress === 'string' && n.emailAddress.trim() !== '') mailbox = n.emailAddress.trim().toLowerCase()
      } catch {
        // not JSON
      }
    }
    if (mailbox === null) {
      console.warn('[gmail-push] verified notification did not decode: acknowledged')
      return c.body(null, 204)
    }

    // 6. Look up, mark, and (only when nothing already covers it) create one instance. A D1 failure is the route's 500: Pub/Sub retries.
    try {
      const now = (d.clock ?? (() => new Date()))()
      const at = now.toISOString()
      const found = await watched(binding, mailbox)
      if (found.length === 0) {
        console.log('[gmail-push] no live watched connection for this notification')
        return c.body(null, 204)
      }
      const newId = d.newId ?? (() => uuidv7(now))
      for (const w of found) {
        const leaseHeld = w.lease_until !== null && w.lease_until >= at
        const unserved = w.sync_requested_at !== null && (w.last_success_at === null || w.sync_requested_at > w.last_success_at)
        const young = unserved && now.getTime() - Date.parse(w.sync_requested_at!) < COALESCE_MS
        // Always advance the request: a running pass re-passes on it ([[CHN5]] D11).
        await markRequested({ binding, organizationId: binding.organizationId }, w.id, at)
        if (leaseHeld || young || !d.instances) continue
        try {
          await d.instances.create({ id: instanceId(w.id, newId()), params: { connection_id: w.id } })
          console.log('[gmail-push] sync requested')
        } catch (err) {
          // The request is recorded: the cron serves it (D77).
          console.error(`[gmail-push] sync instance not created: ${err instanceof Error ? err.name : 'error'}`)
        }
      }
      return c.body(null, 204)
    } catch (err) {
      console.error(`[gmail-push] storage failed: ${err instanceof Error ? err.name : 'error'}`)
      return error(c, 500, 'internal', 'internal error')
    }
  }
}
