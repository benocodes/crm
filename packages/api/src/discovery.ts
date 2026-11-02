import { toProviderScope } from './auth/clerk.js'
import { SURFACE_PREFIX, openApiPath } from './surfaces.js'

/** [[CORE64]] D21: the vault's own discovery document. */
export const VIBASE_DISCOVERY_PATH = '/.well-known/vibase'
/** [[CORE64]] D22: RFC 9728 protected-resource metadata. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

/** The configuration the two documents read: public values only, never a secret. */
export interface DiscoveryConfig {
  /** `undefined` when `AUTH_PROVIDER` is unset (API keys only). */
  provider?: { name: 'clerk'; issuer: string }
  /** `AUTH_CLI_CLIENT_ID`; `undefined` is `null` in the document. */
  cliClientId?: string
  /** Every declared vault scope, in the vault's names; mapped to the provider's names here. */
  declaredScopes: readonly string[]
}

/** The `WWW-Authenticate` value of every 401 when a provider is configured ([[CORE64]] D22, RFC 9728 section 5.1). */
export const resourceMetadataChallenge = (origin: string): string => `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
}

/**
 * Answers `GET` or `HEAD` of the two documents, or `undefined` for any other request (exact paths only: a trailing slash is not
 * ours). Reads configuration, never storage or credentials, so it can run before every gate. URLs are on the request's origin.
 */
export function discoveryResponse(req: Request, config: DiscoveryConfig): Response | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined
  const url = new URL(req.url)
  let body: unknown
  if (url.pathname === VIBASE_DISCOVERY_PATH) {
    const o = url.origin
    body = {
      api: o + SURFACE_PREFIX.api,
      openapi: { api: o + openApiPath('api'), meta: o + openApiPath('meta') },
      auth: config.provider
        ? { provider: config.provider.name, issuer: config.provider.issuer, cli_client_id: config.cliClientId ?? null, protected_resource_metadata: o + PROTECTED_RESOURCE_PATH }
        : null,
    }
  } else if (url.pathname === PROTECTED_RESOURCE_PATH) {
    // Without a provider there is no authorisation server to name: 404, not a document that points nowhere.
    if (!config.provider) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    body = {
      resource: url.origin,
      authorization_servers: [config.provider.issuer],
      scopes_supported: config.declaredScopes.map(toProviderScope),
      bearer_methods_supported: ['header'],
    }
  } else return undefined
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers: HEADERS })
}
