// The narrow port the invitation operations reach the control plane through ([[CORE245]] P2, [[CORE259]] D5). The Worker composition implements it over the control store and hands it in; nothing in
// this package names the control binding or the store, and the operation storage (`StorageBinding`) cannot carry it. Every write is one control batch with its `control_audit` row (the store's job).

export type InvitationRole = 'owner' | 'member' | 'agent'
/** An invitation as the control plane holds it, without its token or token hash. Timestamps are ISO-8601 text. */
export interface InvitationRow {
  id: string
  organizationId: string
  email: string
  role: InvitationRole
  expiresAt: string
  createdBy: string
  createdAt: string
  acceptedAt: string | null
  revokedAt: string | null
}
export interface InvitationInsert {
  id: string
  auditId: string
  organizationId: string
  email: string
  role: InvitationRole
  tokenHash: string
  expiresAt: string
  createdBy: string
  now: string
}
export interface InvitationsPort {
  /** `live_exists`: another live invitation holds the address; nothing was written. */
  create(a: InvitationInsert): Promise<'created' | 'live_exists'>
  list(a: { after?: string; limit: number }): Promise<InvitationRow[]>
  revoke(a: { id: string; auditId: string; actorId: string; now: string }): Promise<{ result: 'revoked' | 'not_live'; record: InvitationRow } | { result: 'not_found' }>
}
/** What composition hands the registry: the port, and the origin the invitation URL is built on (`PUBLIC_BASE_URL`, never a request host). `null`/absent: this composition has no control store. */
export interface InvitationsRuntime {
  port: InvitationsPort
  publicBaseUrl: string
}
