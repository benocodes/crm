import { z } from 'zod'
import { defineOperation, readMaybe, step, unit, type PreparedOperation } from '@vault/storage'
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
export const CALLBACK_PATH = '/oauth/google/callback'

/** The redirect URI of authorize and callback alike ([[CHN5]] D57): `PUBLIC_BASE_URL`, or the request's own origin when it is unset. */
export const redirectUriOf = (config: GmailConfig, origin: string | undefined): string | null => {
  const base = config.publicBaseUrl ?? origin
  return base ? `${base}${CALLBACK_PATH}` : null
}

const body = z.strictObject({ provider: z.literal('google') })
const response = z.object({
  authorize_url: z.string().describe("Open this URL in a browser: Google's consent screen. The vault records the connection when Google sends the person back."),
  expires_at: z.string().describe('When the link stops working (ten minutes).'),
})

const syncParams = z.strictObject({ id: z.uuid() })
const syncResponse = z.object({ requested_at: z.string().describe('When the request was recorded. The mailbox is read by a background run that starts now; read connections.get for last_synced_at and last_error_code.') })

const readOnly = <T>(name: string, value: T): PreparedOperation<T> => defineOperation<T>({ name, mutates: false, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => value }) })

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
        'Human only: a person connects their own mailbox, because someone has to be at Google\'s consent screen. The URL is valid for ten minutes. When the person has consented, Google sends the browser back to the vault, which records the connection, its encrypted credential and the mailbox addresses as own identities; nothing is read from the mailbox yet. Answers 501 provider_not_configured when the deployment has no Google OAuth client.',
      tags: ['connections'],
      method: 'post',
      path: '/connections/authorize',
      scope: { resource: 'connections', action: 'write' },
      validation: 'adapter',
      d1Only: true,
      request: { body },
      response: { status: 200, schema: response },
      prepare: async (env, input) => {
        // Agents never connect (an API key is an agent): the scope is not grantable to them, and this holds even if one were handed it.
        if (env.actor.kind !== 'user') throw new ApiError(403, 'user_required', 'connecting a mailbox needs a signed-in person')
        const config = runtime?.config
        if (!config) throw new ApiError(501, 'provider_not_configured', 'Google is not configured on this deployment')
        const redirectUri = redirectUriOf(config, input.origin)
        if (!redirectUri) throw new ApiError(501, 'provider_not_configured', 'PUBLIC_BASE_URL is not set and the request has no origin')
        const nonce = btoa(String.fromCharCode(...env.randomBytes(16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const expiresAt = env.now.getTime() + STATE_TTL_MS
        const state = await signState(config.stateSecret, { user_id: env.actor.id, nonce, expires_at: expiresAt })
        const challenge = await pkceChallenge(await pkceVerifier(config.stateSecret, nonce))
        return readOnly('connections.authorize', {
          authorize_url: buildAuthorizeUrl({ endpoints: runtime?.endpoints ?? GOOGLE_ENDPOINTS, clientId: config.clientId, redirectUri, state, challenge }),
          expires_at: new Date(expiresAt).toISOString(),
        })
      },
    },
    {
      kind: 'tenant',
      surface: 'meta',
      name: 'connections.sync',
      summary: "Ask the vault to read a connected mailbox now, instead of waiting for the next scheduled read",
      description:
        "Human only. Records a sync request and starts a background run; answers 202 at once, before anything is read. The run captures new mail, and a mailbox that has never synced starts with a backfill. Read connections.get for last_synced_at (when it finished) and last_error_code (why it did not). 404 for an unknown or disconnected connection; 409 connection_inactive when the connection needs a reconnect (reauth_required or suspended); 501 provider_not_configured when this deployment cannot sync.",
      tags: ['connections'],
      method: 'post',
      path: '/connections/{id}/sync',
      scope: { resource: 'connections', action: 'write' },
      validation: 'adapter',
      d1Only: true,
      request: { params: syncParams },
      response: { status: 202, schema: syncResponse },
      prepare: (env, input) => {
        // Refusal order (D75): the scope and `d1Only` are checked before `prepare`; then who, then configuration, then the connection.
        if (env.actor.kind !== 'user') throw new ApiError(403, 'user_required', 'syncing a mailbox needs a signed-in person')
        if (!runtime?.config || !runtime.instances) throw new ApiError(501, 'provider_not_configured', 'this deployment cannot sync mailboxes: Google or the sync Workflow is not configured')
        const id = (input.params as { id: string }).id
        const org = env.organizationId
        const at = env.now.toISOString()
        const instance = instanceId(id, env.newId())
        return defineOperation<{ requested_at: string; connection_id: string; instance_id: string }>({
          name: 'connections.sync',
          mutates: true,
          reads: (qc) => ({
            connection: readMaybe(qc.db.selectFrom('channel_connections').select('channel_connections.status').where('channel_connections.id', '=', id).where('channel_connections.organization_id', '=', org).where('channel_connections.deleted_at', 'is', null)),
          }),
          build: (found, qc) => {
            const row = found.maybe('connection')
            if (!row) throw new ApiError(404, 'not_found', 'no such connection')
            if (row.status !== 'active') throw new ApiError(409, 'connection_inactive', 'the connection needs a reconnect before it can sync')
            return unit({
              steps: [step(qc.db.updateTable('mail_sync_state').set({ sync_requested_at: at }).where('connection_id', '=', id).where('organization_id', '=', org))],
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
          throw new ApiError(503, 'sync_unavailable', 'the sync request was recorded but the run could not be started; it will be picked up by the next scheduled read')
        }
        return { requested_at: v.requested_at }
      },
    },
  ]
}
