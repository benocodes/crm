import { toProviderScope } from './auth/clerk.js'
import { grantableScopes } from './auth/roles.js'
import { SURFACE_PREFIX, openApiPath } from './surfaces.js'

/** [[CORE64]] D21: the vault's own discovery document. */
export const VIBASE_DISCOVERY_PATH = '/.well-known/vibase'
/** [[CORE64]] D22: RFC 9728 protected-resource metadata. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

/** [[API106]] D13: RFC 9728 section 3.1 metadata for the MCP endpoint (the resource's path is appended to the well-known path). */
export const MCP_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp'
/** The MCP endpoint's path ([[API106]] D1); `MCP_PATH` in `mcp/handler.ts` is the same value, kept here so discovery imports no handler. */
const MCP_RESOURCE_PATH = '/mcp'

/** The configuration the three documents read: public values only, never a secret. */
export interface DiscoveryConfig {
  /** `undefined` when `AUTH_PROVIDER` is unset (API keys only). */
  provider?: { name: 'clerk'; issuer: string } | { name: 'better-auth'; issuer: string; /** `PUBLIC_BASE_URL`: the documents' resource and URLs come from it, never the request host ([[CORE243]] D23). */ baseUrl: string; /** [[CORE294]] D7: how a person signs in here; the auth pages read it to show the Google button. */ signInMethods?: readonly ('password' | 'google')[] }
  /** `AUTH_CLI_CLIENT_ID`; `undefined` is `null` in the document. */
  cliClientId?: string
  /** `CLERK_PUBLISHABLE_KEY` ([[UI30]] D5), already validated against the issuer; `undefined` is `null` in the document. */
  publishableKey?: string
  /** Every declared vault scope, in the vault's names; mapped to the provider's names here. */
  declaredScopes: readonly string[]
}

/** The `WWW-Authenticate` value of every 401 when a provider is configured ([[CORE64]] D22, RFC 9728 section 5.1). */
export const resourceMetadataChallenge = (origin: string): string => `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`

/**
 * [[API106]] D14: the `WWW-Authenticate` value of a 401 on `/mcp`. `scope` is one quoted, space-separated value (RFC 6750 section 3
 * `scope-token` list), the agent-grantable scopes in provider names, in the vault's sorted order, so the client requests a useful grant.
 */
export const mcpChallenge = (origin: string, declaredScopes: readonly string[]): string =>
  `Bearer resource_metadata="${origin}${MCP_PROTECTED_RESOURCE_PATH}", scope="${grantableScopes(declaredScopes).map(toProviderScope).join(' ')}"`

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
}

/** [[API106]] D16: the browser preflight answer for the three documents. */
const PREFLIGHT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD',
  'access-control-allow-headers': '*',
  'access-control-max-age': '600',
}
const DOCUMENT_PATHS: readonly string[] = [VIBASE_DISCOVERY_PATH, PROTECTED_RESOURCE_PATH, MCP_PROTECTED_RESOURCE_PATH]

/**
 * Answers `GET` or `HEAD` of the three documents and `OPTIONS` on their paths, or `undefined` for any other request (exact paths
 * only: a trailing slash is not ours). Reads configuration, never storage or credentials, so it can run before every gate. URLs are
 * on the request's origin. The preflight is `204` whatever the provider, so the following `GET` is what says `404`.
 */
export function discoveryResponse(req: Request, config: DiscoveryConfig): Response | undefined {
  const url = new URL(req.url)
  if (req.method === 'OPTIONS') return DOCUMENT_PATHS.includes(url.pathname) ? new Response(null, { status: 204, headers: PREFLIGHT_HEADERS }) : undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined
  let body: unknown
  if (url.pathname === VIBASE_DISCOVERY_PATH) {
    const o = url.origin
    const p = config.provider
    body = {
      api: o + SURFACE_PREFIX.api,
      mcp: o + MCP_RESOURCE_PATH,
      openapi: { api: o + openApiPath('api'), meta: o + openApiPath('meta') },
      auth: !p
        ? null
        : p.name === 'better-auth'
          ? // [[CORE283]] P3: no publishable key; the issuer, the resource and the metadata URL come from the configured base URL.
            { provider: p.name, issuer: p.issuer, cli_client_id: config.cliClientId ?? null, resource: p.baseUrl, protected_resource_metadata: p.baseUrl + PROTECTED_RESOURCE_PATH, sign_in_methods: p.signInMethods ?? ['password'] }
          : { provider: p.name, issuer: p.issuer, cli_client_id: config.cliClientId ?? null, publishable_key: config.publishableKey ?? null, protected_resource_metadata: o + PROTECTED_RESOURCE_PATH },
    }
  } else if (url.pathname === PROTECTED_RESOURCE_PATH || url.pathname === MCP_PROTECTED_RESOURCE_PATH) {
    // Without a provider there is no authorisation server to name: 404, not a document that points nowhere.
    if (!config.provider) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    const resourceOrigin = config.provider.name === 'better-auth' ? config.provider.baseUrl : url.origin
    body =
      url.pathname === PROTECTED_RESOURCE_PATH
        ? { resource: resourceOrigin, authorization_servers: [config.provider.issuer], scopes_supported: config.declaredScopes.map(toProviderScope), bearer_methods_supported: ['header'] }
        : // [[API106]] D13: every MCP token is an agent's, and human-only scopes are dropped from agents, so only the grantable ones are offered.
          {
            resource: resourceOrigin + MCP_RESOURCE_PATH,
            authorization_servers: [config.provider.issuer],
            scopes_supported: grantableScopes(config.declaredScopes).map(toProviderScope),
            bearer_methods_supported: ['header'],
            resource_name: 'Vibase',
          }
  } else return undefined
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers: HEADERS })
}
