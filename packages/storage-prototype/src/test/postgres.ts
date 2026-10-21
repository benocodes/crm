import {
  createOwnerTestDb,
  createTestDb,
  truncateAll,
  seedOrganization,
  seedUser,
  seedAgent,
} from '@vault/db/test'
import { CompiledQuery } from 'kysely'
import { ScopeSet, withContext, createResource, tasks, contacts, identities } from '@vault/api'
import { installPostgres, removePostgres } from '../fixtures/postgres.js'
export async function postgresFixture() {
  const owner = createOwnerTestDb(),
    db = createTestDb({ max: 4 })
  try {
    await installPostgres(owner)
    await owner.executeQuery(
      CompiledQuery.raw('TRUNCATE storage_prototype.rows,storage_prototype.operations'),
    )
    await truncateAll(owner)
    const orgA = await seedOrganization(db),
      orgB = await seedOrganization(db)
    const userA = await seedUser(db, { organizationId: orgA.id }),
      userB = await seedUser(db, { organizationId: orgB.id })
    const agent = await seedAgent(db, {
      organizationId: orgA.id,
      createdBy: userA.id,
      scopes: ['tasks:write', 'contacts:write'],
    })
    const context = (organizationId: string, id: string, kind: 'user' | 'agent' = 'user') => ({
      organizationId,
      actor: { id, kind },
      scopes: ScopeSet.parse(['tasks:write', 'tasks:read', 'contacts:write', 'contacts:read']),
    })
    const a = context(orgA.id, userA.id),
      b = context(orgB.id, userB.id),
      agentContext = context(orgA.id, agent.id, 'agent')
    const seed = async (
      ctx = a,
      resource: 'tasks' | 'contacts' | 'identities' = 'tasks',
      input: any = { title: 'Old' },
    ) => {
      const clean = { ...input }
      if (resource === 'identities' && clean.own === false) delete clean.own
      return withContext(db, ctx, (c) =>
        createResource(c, ({ tasks, contacts, identities } as any)[resource], clean),
      )
    }
    return {
      owner,
      db,
      a,
      b,
      agentContext,
      seed,
      query: async (text: string, parameters: unknown[] = []) =>
        (await owner.executeQuery(CompiledQuery.raw(text, parameters))).rows as any[],
      clearEvents: async () => {
        await owner.executeQuery(CompiledQuery.raw('TRUNCATE events'))
      },
      close: async () => {
        await removePostgres(owner)
        await truncateAll(owner)
        await db.destroy()
        await owner.destroy()
      },
    }
  } catch (e) {
    await db.destroy()
    await owner.destroy()
    throw e
  }
}
