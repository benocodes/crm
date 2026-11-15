// The narrow port `audit.list` reaches the control plane's audit log through ([[CORE261]] P1, [[CORE259]] D5). The Worker composition implements it over the control store and hands it in; nothing in this
// package names the control binding. Read only: the log is written by the control store in the same batch as the change it records.

/** A `control_audit` row as stored; `detail` is the stored JSON parsed. */
export interface AuditRow {
  id: string
  at: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  detail: unknown
}
export interface AuditPort {
  /** Ascending by `id` after the cursor, exact-match filters, at most `limit` rows. */
  list(a: {
    after?: string
    limit: number
    action?: string
    targetType?: string
    targetId?: string
  }): Promise<AuditRow[]>
}
/** What composition hands the registry. `null`/absent: this composition has no control store. */
export interface AuditRuntime {
  port: AuditPort
}
