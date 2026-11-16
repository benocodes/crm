// The shapes of the hq auth migration's read side ([[OPS365]]): the normalized export (D2), the plan file (D3) and the snapshot inside it (P5).
// Nothing here is a secret: the export never reads `api_keys`, and a Clerk user is kept as id, primary email, its verified flag and role only.

/** One Clerk user as the export keeps it: the primary address (by `primary_email_address_id`), whether Clerk verified it, and `public_metadata.vibase_role` when it is a string. */
export interface ClerkUserRow {
  id: string
  email: string | null
  email_verified: boolean
  role: string | null
}

export interface UserRow {
  id: string
  email: string
  name: string | null
  auth_provider: string | null
  auth_subject: string | null
  email_verified: boolean
}
export interface AgentRow {
  id: string
  name: string
  scopes: string[]
  disabled_at: string | null
  auth_provider: string | null
  auth_subject: string | null
  auth_client_id: string | null
  delegated_by: string | null
}
export interface MembershipRow {
  id: string
  user_id: string
  role: string
  deleted_at: string | null
}

/** What the plan is built from, and what #392's apply and #394's revert compare a fresh export against (P5). */
export interface Snapshot {
  clerk_users: ClerkUserRow[]
  users: UserRow[]
  agents: AgentRow[]
  memberships: MembershipRow[]
}

export type AgentKind = 'api_key' | 'agent_account' | 'delegated'
export type AgentAction = 'keep' | 'relink' | 'disable'

export interface PlanPerson {
  user_id: string
  email: string
  old_provider: string | null
  old_subject: string | null
  /** The workspace role the Clerk adapter gives today (`owner`, `member`, or null: refused at sign-in); null too when there is no Clerk match. */
  role: 'owner' | 'member' | null
  /** The raw `vibase_role` Clerk holds, unvalidated. */
  role_raw: string | null
  /** The live membership, if any, recorded beside the role. */
  membership: { id: string; role: string } | null
  /** `migrate`: a Clerk user matched, so it gets a new Better Auth user; `none`: nothing is created and the rows stay (P4). */
  action: 'migrate' | 'none'
  new_auth_user_id: string | null
  reason?: string
}
export interface PlanClerkOnly {
  clerk_user_id: string
  email: string | null
  role_raw: string | null
  action: 'none'
}
export interface PlanAgent {
  id: string
  name: string
  kind: AgentKind
  action: AgentAction
  /** The Better Auth user id a `relink` points at (the Clerk user's new id). */
  new_auth_user_id: string | null
  /** A delegated agent's scopes, recorded so the apply tail can print them for re-granting. */
  scopes: string[] | null
  reason?: string
}
export interface PlanDatabase {
  database_name: string
  database_id: string
  /** Time Travel's bookmark taken before the reads. */
  bookmark: string
}
export interface AuthPlan {
  version: 1
  env: string
  created_at: string
  crm: PlanDatabase
  control: PlanDatabase
  people: PlanPerson[]
  clerk_only: PlanClerkOnly[]
  agents: PlanAgent[]
  snapshot: Snapshot
}
