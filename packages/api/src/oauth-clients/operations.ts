import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ControlOperation } from '../registry.js'
import type { OAuthClientRow, OAuthClientsRuntime } from './port.js'

const SKIP_CONSENT_REFUSAL = 'skip_consent = false is not implemented yet'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

/** D7: `https`, or `http` on `localhost`/`127.0.0.1`; no fragment (not even an empty one), no user info, no `*`. Returns the reason a URI is refused, or `null`. */
function redirectUriProblem(uri: string): string | null {
  if (uri.includes('*')) return 'a redirect URI may not contain *'
  if (uri.includes('#')) return 'a redirect URI may not have a fragment'
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return 'a redirect URI must be an absolute URL'
  }
  if (url.username !== '' || url.password !== '') return 'a redirect URI may not carry user info'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null
  return 'a redirect URI must be https, or http on localhost or 127.0.0.1'
}

const createBody = z.strictObject({
  name: z.string().trim().min(1).max(100).describe('What the app is called; trimmed, 1 to 100 characters'),
  redirect_uris: z
    .array(
      z.string().superRefine((uri, ctx) => {
        const problem = redirectUriProblem(uri)
        if (problem) ctx.addIssue({ code: 'custom', message: problem })
      }),
    )
    .min(1)
    .max(10)
    .describe(
      '1 to 10 redirect URIs: https, or http on localhost or 127.0.0.1; no fragment, user info or *. Duplicates are removed.',
    ),
  scopes: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'The scopes the app may be granted; within the ceiling a dynamically registered client has. Omitted: the default scopes.',
    ),
  skip_consent: z.boolean().optional().describe('Omitted means true. false is refused: it is not implemented yet.'),
})
const idParams = z.object({ client_id: z.string().min(1).max(200) })

const oauthClientRecord = z.object({
  client_id: z.string(),
  name: z.string(),
  redirect_uris: z.array(z.string()),
  scopes: z.array(z.string()),
  skip_consent: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
})

const recordOf = (row: OAuthClientRow): z.infer<typeof oauthClientRecord> => ({
  client_id: row.clientId,
  name: row.name,
  redirect_uris: row.redirectUris,
  scopes: row.scopes,
  skip_consent: row.skipConsent,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

const needsStore = (runtime: OAuthClientsRuntime | null): OAuthClientsRuntime => {
  if (!runtime)
    throw new ApiError(
      501,
      'provider_not_configured',
      'OAuth clients need the built-in auth provider (AUTH_PROVIDER=better-auth); this deployment does not have one',
    )
  return runtime
}

/**
 * [[CORE627]] D1: first-party OAuth client administration on the meta surface, held in the control plane. Control operations: the registry has them on every composition and where composition has no runtime
 * (`runtime` null: Clerk, unset, Postgres) they answer `501 provider_not_configured`. Owner-held, human-only scopes (D3); not proposable. Every refusal of the input is decided before the port is called (P4).
 */
export function oauthClientOperations(runtime: OAuthClientsRuntime | null): ControlOperation[] {
  const base = {
    kind: 'control' as const,
    surface: 'meta' as const,
    tags: ['oauth_clients'],
    validation: 'adapter' as const,
  }
  return [
    {
      ...base,
      name: 'oauth_clients.create',
      summary: 'Register a first-party OAuth client for a web app that signs people in',
      description:
        'Human only (owners). Registers a public OAuth client (PKCE, no secret) for an app that signs people in to this workspace; a person who signs in through it acts as themselves. The client skips the consent screen (skip_consent defaults to true): skip_consent = false is not implemented yet and is refused. Scopes must be within the ceiling a dynamically registered client has (never an administrative scope); omitted, the default scopes are used. The answer carries the client_id; there is no secret.',
      method: 'post',
      path: '/oauth-clients',
      scope: { resource: 'oauth_clients', action: 'write' },
      request: { body: createBody },
      response: { status: 201, schema: oauthClientRecord },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const body = input.body as z.infer<typeof createBody>
        if (body.skip_consent === false) throw new ApiError(400, 'validation_error', SKIP_CONSENT_REFUSAL)
        const scopes = [...new Set(body.scopes ?? rt.defaultScopes)]
        for (const scope of scopes)
          if (!rt.allowedScopes.includes(scope))
            throw new ApiError(400, 'validation_error', `scope ${scope} is not allowed for an OAuth client`)
        const made = await rt.port.create({
          organizationId: env.organizationId,
          clientId: base64url(env.randomBytes(24)),
          name: body.name,
          redirectUris: [...new Set(body.redirect_uris)],
          scopes,
          skipConsent: true,
          resources: rt.resources,
          actorId: env.actor.id,
          now: env.now.toISOString(),
          newId: env.newId,
        })
        if (made === 'exists') throw new Error('oauth_clients.create: the generated client id is already taken') // D13: a 500, not retried
        return recordOf(made)
      },
    },
    {
      ...base,
      name: 'oauth_clients.list',
      summary: 'List the first-party OAuth clients',
      description:
        'Human only (owners). Lists the first-party clients registered through oauth_clients.create, oldest first; clients registered by other means are not shown.',
      method: 'get',
      path: '/oauth-clients',
      scope: { resource: 'oauth_clients', action: 'read' },
      response: { status: 200, schema: z.object({ data: z.array(oauthClientRecord) }) },
      run: async (env) => {
        const rt = needsStore(runtime)
        return { data: (await rt.port.list({ organizationId: env.organizationId })).map(recordOf) }
      },
    },
    {
      ...base,
      name: 'oauth_clients.get',
      summary: 'Get a first-party OAuth client',
      description: 'Human only (owners). An id that is not a first-party client answers 404.',
      method: 'get',
      path: '/oauth-clients/{client_id}',
      scope: { resource: 'oauth_clients', action: 'read' },
      request: { params: idParams },
      response: { status: 200, schema: oauthClientRecord },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const row = await rt.port.get({
          organizationId: env.organizationId,
          clientId: input.params.client_id as string,
        })
        if (!row) throw new ApiError(404, 'not_found', 'OAuth client not found')
        return recordOf(row)
      },
    },
    {
      ...base,
      name: 'oauth_clients.delete',
      summary: 'Delete a first-party OAuth client, which revokes it',
      description:
        'Human only (owners). Deleting is the revocation: the client, its refresh tokens and its consents go at once, so no new sign-in or refresh works. Access tokens already issued stay valid until they expire, at most one hour. An id that is not a first-party client answers 404.',
      method: 'delete',
      path: '/oauth-clients/{client_id}',
      scope: { resource: 'oauth_clients', action: 'write' },
      request: { params: idParams },
      response: { status: 204 },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const gone = await rt.port.delete({
          organizationId: env.organizationId,
          clientId: input.params.client_id as string,
          actorId: env.actor.id,
          now: env.now.toISOString(),
          newId: env.newId,
        })
        if (!gone) throw new ApiError(404, 'not_found', 'OAuth client not found')
        return undefined
      },
    },
  ]
}
