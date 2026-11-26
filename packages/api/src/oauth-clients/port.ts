// The narrow port the OAuth client operations reach the control plane through ([[CORE623]] D2, [[CORE627]] D2). The Worker composition implements it over the control store's first-party client
// methods and hands it in; nothing in this package names the control binding or the store. Every write is one control batch with its `oauth_client.*` `control_audit` row (the store's job).

/** A first-party OAuth client as the control store holds it. Timestamps are ISO-8601 text. */
export interface OAuthClientRow {
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  createdAt: string
  updatedAt: string
}
export interface OAuthClientInsert {
  organizationId: string
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  /** The resource identifiers the client is linked to (the runtime's). */
  resources: readonly string[]
  /** The calling principal ([[CORE627]] P5). */
  actorId: string
  now: string
  newId: () => string
}
export interface OAuthClientsPort {
  /** `exists`: the client id is taken; nothing was written. */
  create(a: OAuthClientInsert): Promise<OAuthClientRow | 'exists'>
  /** First-party clients only, oldest first, ties by client id. */
  list(a: { organizationId: string }): Promise<OAuthClientRow[]>
  /** `null` for any id that is not a first-party client. */
  get(a: { organizationId: string; clientId: string }): Promise<OAuthClientRow | null>
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
}
