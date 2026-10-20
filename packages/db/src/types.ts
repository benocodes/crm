import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { DB, Identities, Invitations, Memberships, Principals, Tasks } from './types.generated.js'

// Narrowed columns. A defaulted column keeps `Generated<>` inside the override, or every insert
// relying on the default stops compiling.
export type Database = Omit<DB, 'principals' | 'memberships' | 'tasks' | 'identities' | 'invitations'> & {
  principals: Omit<Principals, 'kind'> & { kind: 'user' | 'agent' }
  memberships: Omit<Memberships, 'role'> & { role: 'owner' | 'member' }
  tasks: Omit<Tasks, 'status'> & { status: Generated<'open' | 'done'> }
  identities: Omit<Identities, 'kind'> & { kind: 'email' | 'phone' }
  invitations: Omit<Invitations, 'role'> & { role: 'owner' | 'member' }
}

export type { Insertable, Selectable, Updateable }
