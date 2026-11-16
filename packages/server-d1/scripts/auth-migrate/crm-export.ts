import type { AgentRow, MembershipRow, UserRow } from './types.js'

export const USERS_SQL = ''
export const AGENTS_SQL = ''
export const MEMBERSHIPS_SQL = ''

export function readCrmExport(_run: (sql: string) => string): { users: UserRow[]; agents: AgentRow[]; memberships: MembershipRow[] } {
  return { users: [], agents: [], memberships: [] }
}
