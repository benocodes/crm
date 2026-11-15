// The repair sweep's facts and classifier ([[CORE259]] D10, [[CORE289]]): pure. The same read statements, row parsers and `classifySweep` serve the one-minute cron (through the control store)
// and the two status commands (through wrangler's `d1 execute --json`), so "what the next sweep would do" is one function. Every statement here is a SELECT.
// This module never holds a database handle; the control store reads and writes with it.

/** An account is an orphan candidate only when strictly older than this ([[CORE289]] P2). */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The control-plane read: one result set, a `kind` column and five generic columns. `user`: id, email, created_at. `credential`: a user id that still has a session, refresh token, access token
 * or device code. `invitation`: email, created_at, accepted_at, revoked_at, expires_at.
 */
export const SWEEP_CONTROL_READ = `select 'user' as kind, id as k1, email as k2, created_at as k3, null as k4, null as k5 from auth_users
union all select 'credential', user_id, null, null, null, null from (select user_id from auth_sessions union select user_id from auth_oauth_refresh_tokens union select user_id from auth_oauth_access_tokens union select user_id from auth_device_codes) where user_id is not null
union all select 'invitation', email, created_at, accepted_at, revoked_at, expires_at from invitations`

/** The CRM read: every Better Auth subject a CRM user or agent names, and whether it still has authority (a live membership; an enabled agent). */
export const SWEEP_CRM_READ = `select u.auth_subject as subject, case when exists (select 1 from memberships m where m.user_id = u.id and m.deleted_at is null) then 1 else 0 end as authority from users u where u.auth_provider = 'better-auth' and u.auth_subject is not null
union all select a.auth_subject, case when a.disabled_at is null then 1 else 0 end from agents a where a.auth_provider = 'better-auth' and a.auth_subject is not null`

export interface SweepControlFacts {
  users: Array<{ id: string; email: string; createdAt: string }>
  credentialSubjects: string[]
  invitations: Array<{ email: string; createdAt: string; acceptedAt: string | null; revokedAt: string | null; expiresAt: string }>
}
export interface SweepCrmFacts {
  linked: Array<{ subject: string; authority: boolean }>
}
export interface SweepPlan {
  /** Linked subjects without authority that still hold credentials. */
  revoke: string[]
  /** Unlinked accounts over 24 hours with no keeping invitation. */
  orphans: string[]
}

export function parseSweepControlRows(_rows: unknown): SweepControlFacts {
  throw new Error('not implemented')
}
export function parseSweepCrmRows(_rows: unknown): SweepCrmFacts {
  throw new Error('not implemented')
}
export function classifySweep(_a: { now: string; control: SweepControlFacts; crm: SweepCrmFacts }): SweepPlan {
  throw new Error('not implemented')
}
/** The instant an account must be strictly older than, as ISO text. */
export function orphanCutoff(_now: string): string {
  throw new Error('not implemented')
}
