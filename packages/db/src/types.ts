import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { DB, Identities, Memberships, Principals, Tasks } from './types.generated.js'

// Narrowed columns. A defaulted column keeps `Generated<>` inside the override, or every insert
// relying on the default stops compiling.
export type Database = Omit<DB, 'principals' | 'memberships' | 'tasks' | 'identities'> & {
  principals: Omit<Principals, 'kind'> & { kind: 'user' | 'agent' | 'system' }
  memberships: Omit<Memberships, 'role'> & { role: 'owner' | 'member' }
  tasks: Omit<Tasks, 'status'> & { status: Generated<'open' | 'done'> }
  identities: Omit<Identities, 'kind'> & { kind: 'email' | 'phone' }
}

export type { Insertable, Selectable, Updateable }
