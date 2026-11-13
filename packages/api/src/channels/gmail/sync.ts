// Capture pages ([[CHN5]] cycle 3, [[CHN149]]): what one Workflow step will do. Plain async functions, Node-safe, returning plain data.
import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, assertStep, boundIds, defineOperation, execute, memberOf, readMaybe, readSet, step, ts, unit, type EventReceipt, type Row, type StorageBinding, type StorageIdentity } from '@vibase/storage'
import type { GmailConfig } from '../../connections/config.js'
import type { GoogleEndpoints } from '../../connections/google.js'
import type { ObjectStore } from '../../objects/store.js'
import type { StreamPrimitives } from '../../messaging/streams.js'
import { eventStatement } from '../../outbox.js'
import type { Program } from '../../identity/program.js'
import { captureMessages, type PipelineContext } from '../../messaging/pipeline.js'
import { connections } from '../../resources/connections.js'
import { ScopeSet } from '../../scopes.js'
import { afterOf, selectRecord, toRecord } from '../../storage/crud.js'
import type { PreparedEnv } from '../../storage/definition.js'
import { GoogleRefreshError } from '../../connections/google.js'
import { ChannelThrottledError } from '../port.js'
import { GmailApiError, HttpGmailClient, isGmailThrottle, type GmailClient } from './client.js'
import { GmailChannel } from './channel.js'
import type { GmailConnection } from './mapper.js'
import { capturesLabels } from './labels.js'
import { gmailAccessToken } from './token.js'

export interface GmailSyncDeps {
  binding: StorageBinding
  organizationId: string
  objects: ObjectStore
  streams: StreamPrimitives
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
  config: Pick<GmailConfig, 'clientId' | 'clientSecret' | 'credentialsKey' | 'keyVersion' | 'backfillDays' | 'attachmentMaxBytes'>
  endpoints?: GoogleEndpoints
  fetch?: typeof fetch
  gmailBaseUrl?: string
  /** Test seam: builds the client over the page's access-token function. Default `HttpGmailClient`. */
  clientFor?: (accessToken: () => Promise<string>) => GmailClient
}

/** `retry_after_seconds` is Google's `Retry-After` when it sent one, else null (the run's backoff then grows, [[CHN5]] D84). */
export type Outcome = { outcome: 'reauth' } | { outcome: 'throttled'; retry_after_seconds: number | null } | { outcome: 'expired' } | { outcome: 'inactive' }
export interface PageDone {
  outcome: 'page'
  next_page_token: string | null
  history_id: string
  captured: number
  existing: number
  skipped: number
}
export type PageResult = PageDone | Outcome
export interface Scan {
  kind: 'backfill' | 'recovery'
  after: number
  /** Recovery: the fresh profile history id, written by the last page only. Backfill: null. */
  history_id: string | null
}
export type ScanStart = { outcome: 'scan'; scan: Scan } | Outcome
export interface SyncState {
  status: string
  deleted_at: string | null
  owner_id: string
  mailbox: string
  history_id: string | null
  page_token: string | null
  last_synced_at: string | null
}

const PAGE_SIZE = 25
const DAY_MS = 86_400_000

/** Raised inside a history page when Gmail no longer holds the cursor's start id; becomes the `expired` outcome. */
class Expired extends Error {}

/** What a status change needs of the deps: the unit's storage, clock and id sources (the watch renewal passes this much, [[CHN5]] D90). */
export type StatusDeps = Pick<GmailSyncDeps, 'binding' | 'organizationId' | 'clock' | 'newId' | 'randomBytes'>
const internal = (deps: GmailSyncDeps): StorageIdentity => ({ kind: 'internal', organizationId: deps.organizationId })
const asOwner = (deps: StatusDeps, ownerId: string): StorageIdentity => ({ kind: 'tenant', actorId: ownerId, organizationId: deps.organizationId })
const envOf = (deps: StatusDeps, ownerId: string): PreparedEnv => ({ actor: { id: ownerId, kind: 'user' }, organizationId: deps.organizationId, scopes: ScopeSet.parse([]), now: deps.clock(), newId: deps.newId, randomBytes: deps.randomBytes })

/** The connection, its owner, its mailbox address and its cursor, in one read. Null when the connection does not exist. */
export async function loadSyncState(deps: GmailSyncDeps, connectionId: string): Promise<SyncState | null> {
  const op = defineOperation<SyncState | null>({
    name: 'gmail.sync_state',
    mutates: false,
    reads: (qc) => ({
      state: readMaybe(
        sql`select c.status as status, c.deleted_at as deleted_at, c.owner_id as owner_id, i.value as mailbox, k.history_id as history_id, k.page_token as page_token, k.last_synced_at as last_synced_at
          from channel_connections c
          join identities i on i.id = c.identity_id and i.organization_id = c.organization_id
          left join mail_sync_cursors k on k.connection_id = c.id and k.organization_id = c.organization_id
          where c.id = ${connectionId} and c.organization_id = ${deps.organizationId}`.compile(qc.db),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const r = found.maybe('state')
          if (!r) return null
          const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
          return { status: String(r.status), deleted_at: text(r.deleted_at), owner_id: String(r.owner_id), mailbox: String(r.mailbox), history_id: text(r.history_id), page_token: text(r.page_token), last_synced_at: text(r.last_synced_at) }
        },
      }),
  })
  return (await execute(deps.binding, internal(deps), op)).value
}

/** The cursor write as a program composed into the last chunk's unit ([[CHN5]] D12, D38). */
function cursorProgram(deps: GmailSyncDeps, connectionId: string, set: { history_id?: string; page_token: string | null; last_synced_at?: string }): Program<unknown> {
  return {
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(
            qc.db.updateTable('mail_sync_cursors').set(set).where('connection_id', '=', connectionId).where('organization_id', '=', deps.organizationId),
            undefined,
            { expect: 'affected' },
          ),
        ],
        events: [],
        decode: () => undefined,
      }),
  }
}

/** `invalid_grant` ([[CHN5]] D69): one unit as the owner sets `reauth_required`, records the error and emits one `connection.updated`; guarded on `active`, so a repeat writes nothing. */
const markReauth = (deps: StatusDeps, connectionId: string, ownerId: string): Promise<void> => markConnectionStatus(deps, connectionId, ownerId, 'reauth_required', 'invalid_grant')

/**
 * The status change both failures share ([[CHN5]] D16, D69; the sync run's `suspended`, D33): one unit as the owner sets the status, records `errorCode` on the
 * state row and emits one `connection.updated`; guarded on `active`, so a repeat writes and emits nothing.
 */
export async function markConnectionStatus(deps: StatusDeps, connectionId: string, ownerId: string, status: 'reauth_required' | 'suspended', errorCode: string): Promise<void> {
  const env = envOf(deps, ownerId)
  const at = env.now.toISOString()
  const eventId = env.newId()
  const eventExists = sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${eventId})`
  const op = defineOperation<void>({
    name: 'connections.mark_reauth',
    mutates: true,
    reads: (qc) => ({
      connection: readMaybe(
        selectRecord(connections, qc, env, undefined, { derived: false })
          .where(sql<SqlBool>`${sql.ref('channel_connections.id')} = ${connectionId}`)
          .where(sql<SqlBool>`${sql.ref('channel_connections.status')} = 'active'`)
          .select(ts.exact(qc, 'channel_connections.updated_at').as('__stamp')),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe('connection')
      if (!row) return unit({ steps: [], events: [], decode: () => undefined })
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(connections, rest as Row)
      const receipt: EventReceipt = { id: eventId, type: 'connection.updated', resourceType: 'connection', resourceId: before.id }
      return unit({
        steps: [
          step(
            qc.db
              .updateTable('channel_connections')
              .set({ status, updated_at: at })
              .where('channel_connections.id', '=', before.id)
              .where('channel_connections.organization_id', '=', env.organizationId)
              .where('channel_connections.deleted_at', 'is', null)
              .where('channel_connections.status', '=', 'active')
              .where(sql<SqlBool>`${ts.exact(qc, 'channel_connections.updated_at')} = ${String(__stamp)}`),
            'first-mutation',
            { expect: 'affected' },
          ),
          step(eventStatement(qc, { id: eventId, at, organizationId: env.organizationId, actorId: ownerId, type: 'connection.updated', resourceType: 'connection', resourceId: before.id, before, after: afterOf(connections) }), 'first-event'),
          step(qc.db.updateTable('mail_sync_state').set({ last_error_code: errorCode, last_error_at: at }).where('connection_id', '=', before.id).where('organization_id', '=', env.organizationId)),
          assertStep(qc, eventExists),
        ],
        events: [receipt],
        decode: () => undefined,
      })
    },
  })
  for (let attempt = 0; ; attempt++) {
    try {
      await execute(deps.binding, asOwner(deps, ownerId), op)
      return
    } catch (err) {
      // Another writer changed the row between plan and commit: the retry re-reads (a row no longer `active` writes nothing).
      if (err instanceof UnitDriftError && attempt < 2) continue
      throw err
    }
  }
}

/** What building a connection's Gmail client needs ([[CHN5]] D4, D68): shared by the capture pages and the watch calls. */
export type ClientDeps = Pick<GmailSyncDeps, 'binding' | 'organizationId' | 'endpoints' | 'fetch' | 'gmailBaseUrl' | 'clientFor' | 'clock' | 'newId' | 'randomBytes'> & {
  config: Pick<GmailConfig, 'clientId' | 'clientSecret' | 'credentialsKey' | 'keyVersion'>
}

/** The per-call token resolver and the client over it. The token is opened and refreshed lazily, on the first Gmail call. */
export function gmailClientFor(deps: ClientDeps, connectionId: string, ownerId: string,signal?:AbortSignal): GmailClient {
  const accessToken = gmailAccessToken({
    binding: deps.binding,
    organizationId: deps.organizationId,
    connectionId,
    ownerId,
    clientId: deps.config.clientId,
    clientSecret: deps.config.clientSecret,
    credentialsKey: deps.config.credentialsKey,
    keyVersion: deps.config.keyVersion,
    ...(deps.endpoints ? { endpoints: deps.endpoints } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock: deps.clock,
    newId: deps.newId,
    randomBytes: deps.randomBytes,
    ...(signal?{signal}:{}),
  })
  return deps.clientFor ? deps.clientFor(accessToken) : new HttpGmailClient({ accessToken, ...(signal?{signal}:{}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.gmailBaseUrl ? { baseUrl: deps.gmailBaseUrl } : {}) })
}

interface PageContext {
  state: SyncState
  connectionId: string
  client: GmailClient
}

/**
 * The frame every page shares: read the connection (not `active` → `inactive`, no Google call, no write), build the per-page token resolver and client, run
 * `body`, and turn the classified failures into outcomes ([[CHN5]] D16, D69). Anything else is thrown.
 */
async function withPage<T extends PageResult | ScanStart>(deps: GmailSyncDeps, connectionId: string, body: (c: PageContext) => Promise<T>): Promise<T | Outcome> {
  const state = await loadSyncState(deps, connectionId)
  if (!state || state.status !== 'active' || state.deleted_at !== null) return { outcome: 'inactive' }
  const client = gmailClientFor(deps, connectionId, state.owner_id)
  try {
    return await body({ state, connectionId, client })
  } catch (err) {
    if (err instanceof GoogleRefreshError && err.code === 'invalid_grant') {
      await markReauth(deps, connectionId, state.owner_id)
      return { outcome: 'reauth' }
    }
    if (err instanceof Expired) return { outcome: 'expired' }
    // A throttle from any call of the page, an attachment get included ([[CHN5]] D16, D83).
    if (isGmailThrottle(err)) return { outcome: 'throttled', retry_after_seconds: err.retryAfterSeconds }
    if (err instanceof ChannelThrottledError) return { outcome: 'throttled', retry_after_seconds: err.retryAfterSeconds }
    throw err
  }
}

/** The provider ids this connection already holds a source for (one read; nothing is fetched for them). */
async function sourced(deps: GmailSyncDeps, connectionId: string, ids: readonly string[]): Promise<Set<string>> {
  const held = new Set<string>()
  const cap = deps.binding.runtime.maxSetSize
  for (let at = 0; at < ids.length; at += cap) {
    const slice = ids.slice(at, at + cap)
    const op = defineOperation<string[]>({
      name: 'gmail.source_check',
      mutates: false,
      reads: (qc) => {
        boundIds(qc, slice)
        return {
          held: readSet(
            sql`select "message_sources"."provider_message_id" as "id" from "message_sources"
              where "message_sources"."organization_id" = ${deps.organizationId} and "message_sources"."connection_id" = ${connectionId} and ${memberOf(qc, 'message_sources', 'provider_message_id', slice)}`.compile(qc.db),
          ),
        }
      },
      build: (f) => unit({ steps: [], events: [], decode: () => f.all('held').map((r) => String(r.id)) }),
    })
    for (const id of (await execute(deps.binding, internal(deps), op)).value) held.add(id)
  }
  return held
}

/** Drops the ids already sourced, runs the pipeline as the owner over the rest, and counts. */
async function capture(deps: GmailSyncDeps, c: PageContext, ids: readonly string[], labelSkips: number, channelOpts: ConstructorParameters<typeof GmailChannel>[1], final: Program<unknown> | undefined): Promise<{ captured: number; existing: number; skipped: number }> {
  const unique = [...new Set(ids)]
  const held = await sourced(deps, c.connectionId, unique)
  const fresh = unique.filter((id) => !held.has(id))
  const ctx: PipelineContext = {
    binding: deps.binding,
    organizationId: deps.organizationId,
    actorId: c.state.owner_id,
    objects: deps.objects,
    streams: deps.streams,
    clock: deps.clock,
    newId: deps.newId,
    randomBytes: deps.randomBytes,
    attachmentMaxBytes: deps.config.attachmentMaxBytes,
  }
  const conn: GmailConnection = { id: c.connectionId, mailbox: c.state.mailbox }
  const result = await captureMessages(ctx, new GmailChannel(c.client, channelOpts), conn, fresh, final ? { final } : {})
  return { captured: result.captured, existing: held.size + result.existing, skipped: labelSkips + Object.values(result.skipped).reduce((a, b) => a + b, 0) }
}

/**
 * One history page ([[CHN5]] D12): `historyTypes: ['messageAdded']`, 25 records, the label rule on the history record's labels (no `labelIds` on a record
 * means unknown: the message is fetched and the rule applies to it), one source read, the pipeline as the owner, and the cursor in the last chunk's unit.
 * Resumes from the stored page token unless `pageToken` is given.
 */
export async function captureHistoryPage(deps: GmailSyncDeps, connectionId: string, opts: { pageToken?: string | null } = {}): Promise<PageResult> {
  return withPage<PageResult>(deps, connectionId, async (c) => {
    const { state } = c
    if (state.history_id === null) throw new Error('connection has no cursor')
    const pageToken = opts.pageToken === undefined ? state.page_token : opts.pageToken
    let listed
    try {
      listed = await c.client.listHistory({ startHistoryId: state.history_id, pageToken, maxResults: PAGE_SIZE, historyTypes: ['messageAdded'] })
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) throw new Expired()
      throw err
    }
    const ids: string[] = []
    let labelSkips = 0
    const seen = new Set<string>()
    for (const record of listed.history) {
      for (const { message } of record.messagesAdded) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        if (message.labelIds !== undefined && !capturesLabels(message.labelIds)) labelSkips++
        else ids.push(message.id)
      }
    }
    const next = listed.nextPageToken
    const historyAfter = next === null ? (listed.historyId ?? state.history_id) : state.history_id
    const final = cursorProgram(deps, connectionId, next === null ? { history_id: historyAfter, page_token: null, last_synced_at: deps.clock().toISOString() } : { page_token: next })
    // A record without labels is checked on the fetched message, as the scans are.
    const counts = await capture(deps, c, ids, labelSkips, { accept: capturesLabels }, final)
    return { outcome: 'page', next_page_token: next, history_id: historyAfter, ...counts }
  })
}

/**
 * Starts a scan ([[CHN5]] D66, D67): the bound is taken once from the injected clock (backfill `now - days`, recovery `last_synced_at - 1 day`, falling back to the
 * backfill window when never synced). Recovery first takes a fresh profile history id, which only the scan's last page writes. Nothing is written here.
 */
export async function beginScan(deps: GmailSyncDeps, connectionId: string, kind: 'backfill' | 'recovery'): Promise<ScanStart> {
  return withPage<ScanStart>(deps, connectionId, async (c) => {
    const window = deps.clock().getTime() - deps.config.backfillDays * DAY_MS
    let boundMs = window
    let historyId: string | null = null
    if (kind === 'recovery') {
      if (c.state.last_synced_at !== null) boundMs = Date.parse(c.state.last_synced_at) - DAY_MS
      historyId = (await c.client.getProfile()).historyId
    }
    return { outcome: 'scan', scan: { kind, after: Math.floor(boundMs / 1000), history_id: historyId } }
  })
}

/** One scan page: `users.messages.list` with the scan's fixed query; the label rule applies to each fetched message. Only the last page writes the cursor. */
export async function captureScanPage(deps: GmailSyncDeps, connectionId: string, scan: Scan, pageToken: string | null): Promise<PageResult> {
  return withPage<PageResult>(deps, connectionId, async (c) => {
    const listed = await c.client.listMessages({ q: `after:${scan.after} {in:inbox in:sent}`, pageToken, maxResults: PAGE_SIZE })
    const next = listed.nextPageToken
    const historyAfter = next === null && scan.history_id !== null ? scan.history_id : (c.state.history_id ?? '')
    const final =
      next === null
        ? cursorProgram(deps, connectionId, { ...(scan.history_id !== null ? { history_id: scan.history_id } : {}), page_token: null, last_synced_at: deps.clock().toISOString() })
        : undefined
    const counts = await capture(deps, c, listed.messages.map((m) => m.id), 0, { accept: capturesLabels }, final)
    return { outcome: 'page', next_page_token: next, history_id: historyAfter, ...counts }
  })
}
