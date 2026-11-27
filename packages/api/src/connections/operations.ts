import { sql, type SqlBool } from 'kysely'
import { z } from 'zod'
import {
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  readMaybe,
  step,
  ts,
  unit,
  type PreparedOperation,
  type Step,
} from '@vibase/storage'
import { eventStatement } from '../outbox.js'
import { connections, type ConnectionRecord } from '../resources/connections.js'
import { parseInput } from '../resources/define.js'
import { afterOf, beforeRead, receipt, resultStep, toRecord } from '../storage/crud.js'
import { parseCaptureUpdate, updateBody } from './capture-input.js'
import { stopWatch } from '../channels/gmail/watch.js'
import { ApiError } from '../errors.js'
import type { TenantOperation } from '../registry.js'
import type { GmailConfig, PushConfig } from './config.js'
import { GOOGLE_ENDPOINTS, buildAuthorizeUrl, type GoogleEndpoints } from './google.js'
import { pkceChallenge, pkceVerifier, signState } from './state.js'
import { instanceId, type MailSyncInstances } from '../sync/request.js'

/** What the registry needs to answer `connections.authorize`: the Gmail configuration (null: unconfigured, D58) and Google's endpoints. */
export interface ConnectionsRuntime {
  config: GmailConfig | null
  endpoints?: GoogleEndpoints
  /** The `MAIL_SYNC` Workflow binding ([[CHN141]] D75). Absent: `connections.sync` answers `501 provider_not_configured`. */
  instances?: MailSyncInstances
  /** The effective push configuration ([[CHN5]] D87): null when push is off. `connections.delete` stops the watch only when it is set. */
  push?: PushConfig | null
  /** The `fetch` and Gmail base of the stop call, as the rest of the surface. */
  fetch?: typeof fetch
  gmailBaseUrl?: string
}

/** [[CHN5]] D9: the state outlives the person's visit to Google's consent screen by ten minutes. */
export const STATE_TTL_MS = 10 * 60_000
export const CALLBACK_PATH = '/oauth/callback/google'

/** The redirect URI of authorize and callback alike ([[CHN5]] D57): `PUBLIC_BASE_URL`, or the request's own origin when it is unset. */
export const redirectUriOf = (config: GmailConfig, origin: string | undefined): string | null => {
  const base = config.publicBaseUrl ?? origin
  return base ? `${base}${CALLBACK_PATH}` : null
}

const body = z.strictObject({ provider: z.literal('google') })
const response = z.object({
  authorize_url: z
    .string()
    .describe(
      "Open this URL in a browser: Google's consent screen. Vibase records the connection when Google sends the person back.",
    ),
  expires_at: z.string().describe('When the link stops working (ten minutes).'),
})

const syncParams = z.strictObject({ id: z.uuid() })
const syncResponse = z.object({
  requested_at: z
    .string()
    .describe(
      'When the request was recorded. The mailbox is read by a background run that starts now; read connections.get for last_synced_at and last_error_code.',
    ),
})

const updateParams = z.strictObject({ id: z.uuid() })

const readOnly = <T>(name: string, value: T): PreparedOperation<T> =>
  defineOperation<T>({
    name,
    mutates: false,
    reads: () => ({}),
    build: () => unit({ steps: [], events: [], decode: () => value }),
  })

/**
 * The hand-written connection operations ([[CHN5]] D9, D20, D58): `connections.authorize`. The registry carries it whatever the
 * configuration (the CLI and MCP tool lists must not change per deployment); an unconfigured deployment answers `501 provider_not_configured`.
 */
export function connectionOperations(runtime: ConnectionsRuntime | null): TenantOperation[] {
  return [
    {
      kind: 'tenant',
      surface: 'meta',
      name: 'connections.authorize',
      summary: 'Start connecting a Google account: returns the Google consent URL to open in a browser',
      description:
        "Human only: a person connects their own mailbox, because someone has to be at Google's consent screen. The URL is valid for ten minutes. When the person has consented, Google sends the browser back to Vibase, which records the connection, its encrypted credential and the mailbox addresses as own identities; nothing is read from the mailbox yet. Answers 501 provider_not_configured when the deployment has no Google OAuth client.",
      tags: ['connections'],
      method: 'post',
      path: '/connections/authorize',
      scope: { resource: 'connections', action: 'write' },
      proposal: { eligible: false, reason: "connecting a mailbox needs a person at the provider's consent screen" },
      validation: 'adapter',
      d1Only: true,
      request: { body },
      response: { status: 200, schema: response },
      prepare: async (env, input) => {
        // Agents never connect (an API key is an agent): the scope is not grantable to them, and this holds even if one were handed it.
        if (env.actor.kind !== 'user')
          throw new ApiError(403, 'user_required', 'connecting a mailbox needs a signed-in person')
        const config = runtime?.config
        if (!config) throw new ApiError(501, 'provider_not_configured', 'Google is not configured on this deployment')
        const redirectUri = redirectUriOf(config, input.origin)
        if (!redirectUri)
          throw new ApiError(501, 'provider_not_configured', 'PUBLIC_BASE_URL is not set and the request has no origin')
        const nonce = btoa(String.fromCharCode(...env.randomBytes(16)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')
        const expiresAt = env.now.getTime() + STATE_TTL_MS
        const state = await signState(config.stateSecret, { user_id: env.actor.id, nonce, expires_at: expiresAt })
        const challenge = await pkceChallenge(await pkceVerifier(config.stateSecret, nonce))
        return readOnly('connections.authorize', {
          authorize_url: buildAuthorizeUrl({
            endpoints: runtime?.endpoints ?? GOOGLE_ENDPOINTS,
            clientId: config.clientId,
            redirectUri,
            state,
            challenge,
          }),
          expires_at: new Date(expiresAt).toISOString(),
        })
      },
    },
    {
      kind: 'tenant',
      surface: 'meta',
      name: 'connections.update',
      summary:
        "Change a connection's capture settings: which labels are captured, who is blocked, who becomes a contact",
      description:
        'Human only, and only the connection\'s owner: send any of capture_labels, blocked_senders, exclude_group_addresses, exclude_personal_domains and contact_creation; a list replaces the whole list and a field you leave out is untouched. Answers 200 with the connection record. Works on a connection that needs a reconnect too. Anything not listed (owner, status, provider) is refused with 400. 403 user_required for an agent; 404 for an unknown or disconnected connection; 403 not_connection_owner for someone else\'s. Example: vibase connections update <id> --contact-creation sent --capture-labels \'["INBOX","Label_1"]\'',
      tags: ['connections'],
      method: 'patch',
      path: '/connections/{id}',
      scope: { resource: 'connections', action: 'write' },
      proposal: {
        eligible: false,
        reason: "changing a connection's settings is its owner's call and is not proposable",
      },
      validation: 'handler',
      d1Only: true,
      // A unit that drifted (the connection disconnected or handed to another owner since the plan read) is planned afresh: the second plan reads the newer state and refuses with its 404 or 403 ([[CHN409]] P3).
      replanOnDrift: true,
      request: { params: updateParams, body: updateBody },
      response: { status: 200, schema: connections.record },
      prepare: (env, input) => {
        // Refusal order ([[CHN406]] D6): the scope and `d1Only` are checked before `prepare`; then who, then the body, then the connection (404), then its owner (403).
        if (env.actor.kind !== 'user')
          throw new ApiError(403, 'user_required', "changing a mailbox's settings needs a signed-in person")
        const id = String(parseInput(updateParams, input.params).id).toLowerCase()
        const change = parseCaptureUpdate(input.body)
        const org = env.organizationId
        const actor = env.actor.id
        const eventId = env.newId()
        const at = codecs.timestamp.write(env.now)
        return defineOperation<ConnectionRecord>({
          name: 'connections.update',
          mutates: true,
          reads: (qc) => ({ before: beforeRead(connections, qc, env, id) }),
          build: (found, qc) => {
            const row = found.maybe('before')
            if (!row) throw new ApiError(404, 'not_found', 'connection not found')
            const { __stamp, ...rest } = row as Record<string, unknown>
            const before = toRecord(connections, rest)
            if (before.owner_id !== actor)
              throw new ApiError(403, 'not_connection_owner', "only the connection's owner can change its settings")
            // The row as read: still live, still the actor's, untouched since. Used by the commit-time assertion and the final UPDATE alike (P3).
            const unchanged = <Q extends { where: (e: any) => Q }>(q: Q): Q =>
              q
                .where(sql<SqlBool>`${sql.ref('connections.id')} = ${id}`)
                .where(sql<SqlBool>`${sql.ref('connections.organization_id')} = ${org}`)
                .where(sql<SqlBool>`${sql.ref('connections.deleted_at')} is null`)
                .where(sql<SqlBool>`${sql.ref('connections.owner_id')} = ${actor}`)
                .where(sql<SqlBool>`${ts.exact(qc, 'connections.updated_at')} = ${String(__stamp)}`)
            const writes: Step[] = []
            const replace = (
              table: 'connection_capture_labels' | 'connection_blocked_senders',
              rows: Array<Record<string, unknown>>,
            ) => {
              writes.push(
                step(qc.db.deleteFrom(table).where('connection_id', '=', id).where('organization_id', '=', org)),
              )
              for (const r of rows)
                writes.push(
                  step(
                    qc.db.insertInto(table).values({
                      id: env.newId(),
                      organization_id: org,
                      connection_id: id,
                      created_at: at,
                      ...r,
                    } as never),
                  ),
                )
            }
            if (change.capture_labels)
              replace(
                'connection_capture_labels',
                change.capture_labels.map((label_id) => ({ label_id })),
              )
            if (change.blocked_senders) replace('connection_blocked_senders', change.blocked_senders)
            const scalars = {
              ...(change.exclude_group_addresses !== undefined
                ? { exclude_group_addresses: change.exclude_group_addresses }
                : {}),
              ...(change.exclude_personal_domains !== undefined
                ? { exclude_personal_domains: change.exclude_personal_domains }
                : {}),
              ...(change.contact_creation !== undefined ? { contact_creation: change.contact_creation } : {}),
            }
            // The UPDATE is the last write, so the event's `appliedPrev` gate reads a statement that always changes one row (a DELETE of no rows would not), and it renders `after` from the rows written above.
            const update = unchanged(
              qc.db.updateTable('connections').set({ ...scalars, updated_at: at }) as never,
            ) as never
            return unit({
              steps: [
                assertStep(
                  qc,
                  sql<SqlBool>`exists ${unchanged(qc.db.selectFrom('connections').select(sql<number>`1`.as('one')) as never)}`,
                ),
                ...writes,
                step(update, 'first-mutation', { expect: 'affected' }),
                step(
                  eventStatement(qc, {
                    id: eventId,
                    at,
                    organizationId: org,
                    actorId: actor,
                    type: 'connection.updated',
                    resourceType: 'connection',
                    resourceId: id,
                    before,
                    after: afterOf(connections),
                  }),
                  'first-event',
                ),
                resultStep(connections, qc, env, id, eventId),
              ],
              events: [receipt(connections, eventId, 'updated', id)],
              decode: (rows) => {
                if (rows.length === 0) throw new UnitDriftError('connections.update')
                return toRecord(connections, rows[0]!)
              },
            })
          },
        })
      },
    },
    {
      kind: 'tenant',
      surface: 'meta',
      name: 'connections.sync',
      summary: 'Ask Vibase to read a connected mailbox now, instead of waiting for the next scheduled read',
      description:
        'Human only. Records a sync request and starts a background run; answers 202 at once, before anything is read. The run captures new mail, and a mailbox that has never synced starts with a backfill. Read connections.get for last_synced_at (when it finished) and last_error_code (why it did not). 404 for an unknown or disconnected connection; 409 connection_inactive when the connection needs a reconnect (reauth_required or suspended); 501 provider_not_configured when this deployment cannot sync.',
      tags: ['connections'],
      method: 'post',
      path: '/connections/{id}/sync',
      scope: { resource: 'connections', action: 'write' },
      proposal: { eligible: false, reason: 'connection and credential operations are not proposable' },
      validation: 'adapter',
      d1Only: true,
      request: { params: syncParams },
      response: { status: 202, schema: syncResponse },
      prepare: (env, input) => {
        // Refusal order (D75): the scope and `d1Only` are checked before `prepare`; then who, then configuration, then the connection.
        if (env.actor.kind !== 'user')
          throw new ApiError(403, 'user_required', 'syncing a mailbox needs a signed-in person')
        if (!runtime?.config || !runtime.instances)
          throw new ApiError(
            501,
            'provider_not_configured',
            'this deployment cannot sync mailboxes: Google or the sync Workflow is not configured',
          )
        const id = (input.params as { id: string }).id
        const org = env.organizationId
        const at = env.now.toISOString()
        const instance = instanceId(id, env.newId())
        return defineOperation<{ requested_at: string; connection_id: string; instance_id: string }>({
          name: 'connections.sync',
          mutates: true,
          reads: (qc) => ({
            connection: readMaybe(
              qc.db
                .selectFrom('connections')
                .select('connections.status')
                .where('connections.id', '=', id)
                .where('connections.organization_id', '=', org)
                .where('connections.deleted_at', 'is', null),
            ),
          }),
          build: (found, qc) => {
            const row = found.maybe('connection')
            if (!row) throw new ApiError(404, 'not_found', 'no such connection')
            if (row.status !== 'active')
              throw new ApiError(409, 'connection_inactive', 'the connection needs a reconnect before it can sync')
            return unit({
              steps: [
                step(
                  qc.db
                    .updateTable('connection_sync_state')
                    .set({ sync_requested_at: at })
                    .where('connection_id', '=', id)
                    .where('organization_id', '=', org),
                ),
              ],
              events: [],
              decode: () => ({ requested_at: at, connection_id: id, instance_id: instance }),
            })
          },
        })
      },
      // After the request is committed: one instance. A failure leaves the request recorded (the cron serves it) and says so.
      after: async (value) => {
        const v = value as { requested_at: string; connection_id: string; instance_id: string }
        try {
          await runtime!.instances!.create({ id: v.instance_id, params: { connection_id: v.connection_id } })
        } catch (err) {
          console.error(`[sync] connections.sync: instance not created: ${err instanceof Error ? err.name : 'error'}`)
          throw new ApiError(
            503,
            'sync_unavailable',
            'the sync request was recorded but the run could not be started; it will be picked up by the next scheduled read',
          )
        }
        return { requested_at: v.requested_at }
      },
    },
  ]
}

/**
 * `connections.delete` with the stop of its watch ([[CHN5]] D91). The generated operation stays as it is; this adds two reads before its unit (the watch row and the
 * newest credential's ciphertext, which the unit deletes) and an `after` stage that calls `users.stop` once the unit has committed. Only while push is on. A failure
 * of the stop is logged by `stopWatch` and never changes the 204.
 */
export function withWatchStop(op: TenantOperation, runtime: ConnectionsRuntime | null): TenantOperation {
  const config = runtime?.config
  if (!config || !runtime?.push) return op
  type Stop = { connectionId: string; ciphertext: string; keyVersion: number }
  return {
    ...op,
    prepare: async (env, input, ctx) => {
      const inner = (await op.prepare(env, input, ctx)) as PreparedOperation<unknown>
      const id = String((input.params as { id: string }).id).toLowerCase()
      const org = env.organizationId
      return defineOperation<{ stop: Stop | null }>({
        name: inner.name,
        mutates: true,
        reads: (qc) => ({
          ...inner.reads(qc),
          'stop:watch': readMaybe(
            qc.db
              .selectFrom('connection_watches')
              .select('connection_watches.connection_id')
              .where('connection_watches.connection_id', '=', id)
              .where('connection_watches.organization_id', '=', org),
          ),
          'stop:credential': readMaybe(
            qc.db
              .selectFrom('connection_credentials')
              .select(['connection_credentials.refresh_token_ciphertext', 'connection_credentials.key_version'])
              .where('connection_credentials.connection_id', '=', id)
              .where('connection_credentials.organization_id', '=', org)
              .orderBy('connection_credentials.created_at', 'desc')
              .orderBy('connection_credentials.id', 'desc')
              .limit(1),
          ),
        }),
        build: (found, qc) => {
          const built = inner.build(found, qc)
          const watch = found.maybe('stop:watch')
          const credential = found.maybe('stop:credential')
          return {
            ...built,
            decode: (rows, f) => {
              built.decode(rows, f)
              return {
                stop:
                  watch && credential
                    ? {
                        connectionId: id,
                        ciphertext: String(credential.refresh_token_ciphertext),
                        keyVersion: Number(credential.key_version),
                      }
                    : null,
              }
            },
          }
        },
      })
    },
    after: async (value) => {
      const stop = (value as { stop: Stop | null } | undefined)?.stop
      if (stop)
        await stopWatch({
          config,
          ...stop,
          ...(runtime.endpoints ? { endpoints: runtime.endpoints } : {}),
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
          ...(runtime.gmailBaseUrl ? { gmailBaseUrl: runtime.gmailBaseUrl } : {}),
        })
      return undefined
    },
  }
}
