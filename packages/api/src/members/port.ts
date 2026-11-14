// The narrow port the membership writes reach the control plane through ([[CORE288]] P5, P6, [[CORE259]] D5). The Worker composition implements it over the control store and the built-in provider and hands
// it in; nothing in this package names the control binding. Each call is one best-effort control action AFTER the CRM unit (removal) or the whole action (reset link), each with its `control_audit` row.

export interface MembersPort {
  /**
   * Removal revocation ([[CORE288]] P5): delete the Better Auth subject's sessions and OAuth tokens and write one `user.sessions_revoked` audit row, in one control batch. Called only after the CRM
   * unit committed; a failure is logged by the caller and never undoes the removal ([[CORE289]]'s sweep finishes it).
   */
  revokeCredentials(a: { subject: string; auditId: string; actorId: string; now: string }): Promise<void>
  /**
   * Owner-issued reset link ([[CORE288]] P6): drive Better Auth's reset request in-process for `email`, capture the token, write the `user.reset_link_issued` audit row, then return the token and its
   * expiry (ISO-8601). `null` when the provider has no account for the address. The token is never stored or logged here.
   */
  issueResetLink(a: { email: string; subject: string; auditId: string; actorId: string; now: string }): Promise<{ token: string; expiresAt: string } | null>
}

/** What composition hands the registry: the port, and the origin the reset URL is built on (`PUBLIC_BASE_URL`, never a request host). `null`/absent: this composition has no control store. */
export interface MembersRuntime {
  port: MembersPort
  publicBaseUrl: string
}
