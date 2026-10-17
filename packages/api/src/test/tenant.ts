import type { Kysely } from 'kysely'
import { withContext, type ServiceContext } from '../context.js'
import { ScopeSet } from '../scopes.js'
import { seedAgent, seedOrganization, seedUser } from '@vault/db/test'
import type { Database } from '@vault/db'

export type Tenant = { organizationId: string; userId: string; agentId: string }

/** A real organisation with an owner user and an agent created by them. */
export async function seedTenant(db: Kysely<Database>, name?: string): Promise<Tenant> {
  const org = await seedOrganization(db, { name })
  const user = await seedUser(db, { organizationId: org.id, role: 'owner' })
  const agent = await seedAgent(db, { organizationId: org.id, createdBy: user.id })
  return { organizationId: org.id, userId: user.id, agentId: agent.id }
}

const scopes = () => ScopeSet.parse(['tasks:read', 'tasks:write'])

export function asUser<T>(db: Kysely<Database>, t: Tenant, fn: (ctx: ServiceContext) => Promise<T>): Promise<T> {
  return withContext(db, { actor: { id: t.userId, kind: 'user' }, organizationId: t.organizationId, scopes: scopes() }, fn)
}

export function asAgent<T>(db: Kysely<Database>, t: Tenant, fn: (ctx: ServiceContext) => Promise<T>): Promise<T> {
  return withContext(db, { actor: { id: t.agentId, kind: 'agent' }, organizationId: t.organizationId, scopes: scopes() }, fn)
}
