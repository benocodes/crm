// The static authorization-server metadata and its constants: config only, no Better Auth import, so the Worker's early answers load nothing heavy (#522).
/** The OIDC scopes this cycle's clients may ask for. The vault's resource scopes join them with token verification ([[CORE244]]). */
export const AUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
/**
 * [[CORE630]] D1: the wildcard a person's default CLI login asks for, a provider scope beside the OIDC ones and never a Vibase scope. Deliberately NOT in `AUTH_SCOPES` (that list feeds every registration default and the empty-scope
 * fill) and in no published `scopes_supported`: only the provider's own scope list holds it.
 */
export const FULL_ACCESS_SCOPE = 'all_permissions'
export const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server/auth'
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * The authorization-server metadata, built from config alone (OPS252, hq cutover). The library's own handler runs Better Auth's request machinery, which on a cold isolate made
 * several D1 round trips (3.4 s from a US colo to a European database) and overran the 5 s budget of Claude web's connector check, so Claude never reached registration. This
 * document needs no database. It equals what the library emits for this composition with `shapeMetadata` applied (the discovery test compares them), so a library upgrade that
 * changes the document fails that test instead of drifting.
 */
export function staticAuthServerMetadata(baseURL: string, vaultScopes: readonly string[]): Record<string, unknown> {
  const issuer = `${baseURL}/auth`
  const publicMethods = ['client_secret_basic', 'client_secret_post']
  return {
    scopes_supported: [...AUTH_SCOPES, ...vaultScopes],
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/jwks`,
    registration_endpoint: `${issuer}/oauth2/register`,
    introspection_endpoint: `${issuer}/oauth2/introspect`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token', DEVICE_GRANT],
    token_endpoint_auth_methods_supported: ['none', ...publicMethods],
    introspection_endpoint_auth_methods_supported: publicMethods,
    revocation_endpoint_auth_methods_supported: publicMethods,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: ['EdDSA', 'ES256', 'ES512', 'PS256', 'RS256'],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'sid',
      'scope',
      'azp',
      'name',
      'picture',
      'given_name',
      'family_name',
      'email',
      'email_verified',
    ],
    claims_parameter_supported: true,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
    subject_types_supported: ['public'],
    acr_values_supported: ['0'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    end_session_endpoint: `${issuer}/oauth2/end-session`,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    prompt_values_supported: ['login', 'consent', 'create', 'select_account', 'none'],
    device_authorization_endpoint: `${issuer}/device/code`,
  }
}

export function staticMetadataResponse(baseURL: string, vaultScopes: readonly string[]): Response {
  return new Response(JSON.stringify(staticAuthServerMetadata(baseURL, vaultScopes)), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400',
    },
  })
}
