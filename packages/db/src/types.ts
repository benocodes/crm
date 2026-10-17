import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { DB, Memberships, Principals, Tasks } from './types.generated.js'

// Narrowed columns. A defaulted column keeps `Generated<>` inside the override, or every insert
// relying on the default stops compiling.
export type Database = Omit<DB, 'principals' | 'memberships' | 'tasks'> & {
  principals: Omit<Principals, 'kind'> & { kind: 'user' | 'agent' }
  memberships: Omit<Memberships, 'role'> & { role: 'owner' | 'member' }
  tasks: Omit<Tasks, 'status'> & { status: Generated<'open' | 'done'> }
}

export type { Insertable, Selectable, Updateable }
