// The narrow port the OAuth client operations reach the control plane through ([[CORE623]] D2, [[CORE627]] D2). The Worker composition implements it over the control store's first-party client
// methods and hands it in; nothing in this package names the control binding or the store. Every write is one control batch with its `oauth_client.*` `control_audit` row (the store's job).

/** A first-party OAuth client as the control store holds it. Timestamps are ISO-8601 text. */
export interface OAuthClientRow {
  clientId: string
  name: string
  redirectUris: string[]
  /** The owner-chosen list; `null`: the client follows the first-party ceiling ([[CORE639]] D4). */
  scopes: string[] | null
  skipConsent: boolean
  createdAt: string
  updatedAt: string
}
export interface OAuthClientInsert {
  organizationId: string
  clientId: string
  name: string
  redirectUris: string[]
  /** `null`: the client follows the first-party ceiling ([[CORE639]] D4). */
  scopes: string[] | null
  skipConsent: boolean
  /** The resource identifiers the client is linked to (the runtime's). */
  resources: readonly string[]
  /** The calling principal ([[CORE627]] P5). */
  actorId: string
  now: string
  newId: () => string
}
export interface OAuthClientChange {
  organizationId: string
  clientId: string
  /** The calling principal ([[CORE627]] P5). */
  actorId: string
  now: string
  newId: () => string
  /** Any subset of the four owner fields; a list replaces whole. */
  name?: string
  redirectUris?: string[]
  /** A list replaces whole; `null` switches the client to follow the ceiling ([[CORE639]] D4). */
  scopes?: string[] | null
  skipConsent?: boolean
}
export interface OAuthClientsPort {
  /** `exists`: the client id is taken; nothing was written. */
  create(a: OAuthClientInsert): Promise<OAuthClientRow | 'exists'>
  /** First-party clients only, oldest first, ties by client id. */
  list(a: { organizationId: string }): Promise<OAuthClientRow[]>
  /** `null` for any id that is not a first-party client. */
  get(a: { organizationId: string; clientId: string }): Promise<OAuthClientRow | null>
  /** The client after the edit; `null`, nothing written, when no first-party client has the id ([[CORE628]] D1). */
  update(a: OAuthClientChange): Promise<OAuthClientRow | null>
  /** `false`, nothing written, when no first-party client has the id. */
  delete(a: {
    organizationId: string
    clientId: string
    actorId: string
    now: string
    newId: () => string
  }): Promise<boolean>
}
/**
 * What composition hands the registry ([[CORE627]] D10): the port, the scope ceiling and default of a first-party client (the same `registrationScopes` value Better Auth gets for dynamic registration)
 * and the resource identifiers a client is linked to. `null`/absent: this composition has no built-in provider.
 */
export interface OAuthClientsRuntime {
  port: OAuthClientsPort
  allowedScopes: readonly string[]
  defaultScopes: readonly string[]
  resources: readonly string[]
  /** [[CORE628]] P1: the parsed `CORS_ALLOWED_ORIGINS`, the same value the REST app gets as `corsOrigins`; the origin warning (D11) reads this list and no other. */
  corsOrigins: readonly string[]
  /** [[CORE628]] P3: the API's own origin (`PUBLIC_BASE_URL`'s): a redirect on it needs no CORS and is never warned. */
  apiOrigin: string
}
