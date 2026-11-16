// The CRM side of the export ([[OPS365]] D2, P5): the identity rows the plan is built from, each one `SELECT` with an explicit column list. Nothing here touches `api_keys` (a control-plane
// table since [[CORE329]]), so no key hash can enter the plan.
import type { AgentRow, MembershipRow, UserRow } from './types.js'

export const USERS_SQL = 'select id, email, name, auth_provider, auth_subject, email_verified from users order by id'
export const AGENTS_SQL =
  'select id, name, scopes, disabled_at, auth_provider, auth_subject, auth_client_id, delegated_by from agents order by id'
export const MEMBERSHIPS_SQL = 'select id, user_id, role, deleted_at from memberships order by id'

/** The rows of wrangler's `--json` output: `[ { results: [...], success } ]`; an `error` object or any other shape throws. */
function rowsOf(stdout: string): Record<string, unknown>[] {
  const json: unknown = JSON.parse(stdout)
  const error = (json as { error?: { text?: unknown } } | null)?.error
  if (error)
    throw new Error(`wrangler d1 execute failed: ${typeof error.text === 'string' ? error.text : 'unknown error'}`)
  const results = Array.isArray(json) ? (json[0] as { results?: unknown } | undefined)?.results : undefined
  if (!Array.isArray(results)) throw new Error('unexpected output shape from wrangler d1 execute')
  return results as Record<string, unknown>[]
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`unexpected row shape from wrangler d1 execute (${what})`)
  return v
}
const strOrNull = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : str(v, what))

function scopesOf(v: unknown): string[] {
  const parsed: unknown = JSON.parse(str(v, 'agents.scopes'))
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string'))
    throw new Error('unexpected row shape from wrangler d1 execute (agents.scopes)')
  return parsed as string[]
}

/** `run(sql)` returns wrangler's `--json` stdout for the CRM database and throws on a failed run. */
export function readCrmExport(run: (sql: string) => string): {
  users: UserRow[]
  agents: AgentRow[]
  memberships: MembershipRow[]
} {
  const users = rowsOf(run(USERS_SQL)).map(
    (r): UserRow => ({
      id: str(r.id, 'users.id'),
      email: str(r.email, 'users.email'),
      name: strOrNull(r.name, 'users.name'),
      auth_provider: strOrNull(r.auth_provider, 'users.auth_provider'),
      auth_subject: strOrNull(r.auth_subject, 'users.auth_subject'),
      email_verified: r.email_verified === 1 || r.email_verified === true,
    }),
  )
  const agents = rowsOf(run(AGENTS_SQL)).map(
    (r): AgentRow => ({
      id: str(r.id, 'agents.id'),
      name: str(r.name, 'agents.name'),
      scopes: scopesOf(r.scopes),
      disabled_at: strOrNull(r.disabled_at, 'agents.disabled_at'),
      auth_provider: strOrNull(r.auth_provider, 'agents.auth_provider'),
      auth_subject: strOrNull(r.auth_subject, 'agents.auth_subject'),
      auth_client_id: strOrNull(r.auth_client_id, 'agents.auth_client_id'),
      delegated_by: strOrNull(r.delegated_by, 'agents.delegated_by'),
    }),
  )
  const memberships = rowsOf(run(MEMBERSHIPS_SQL)).map(
    (r): MembershipRow => ({
      id: str(r.id, 'memberships.id'),
      user_id: str(r.user_id, 'memberships.user_id'),
      role: str(r.role, 'memberships.role'),
      deleted_at: strOrNull(r.deleted_at, 'memberships.deleted_at'),
    }),
  )
  return { users, agents, memberships }
}
