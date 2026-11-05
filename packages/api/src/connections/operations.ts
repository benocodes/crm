import { z } from 'zod'
import { defineOperation, unit, type PreparedOperation } from '@vault/storage'
import { ApiError } from '../errors.js'
import type { TenantOperation } from '../registry.js'
import type { GmailConfig } from './config.js'
import { GOOGLE_ENDPOINTS, buildAuthorizeUrl, type GoogleEndpoints } from './google.js'
import { pkceChallenge, pkceVerifier, signState } from './state.js'

/** What the registry needs to answer `connections.authorize`: the Gmail configuration (null: unconfigured, D58) and Google's endpoints. */
export interface ConnectionsRuntime {
  config: GmailConfig | null
  endpoints?: GoogleEndpoints
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
  ]
}
