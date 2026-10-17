import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { withServiceRole } from '../tenancy.js'
import type { Database } from '../types.js'

// Seeds run through `withServiceRole` on the `vault_app` db. No ON CONFLICT and no catching 23505
// (AGENTS.md invariant 3): random emails avoid collisions.

export async function seedOrganization(db: Kysely<Database>, opts: { name?: string } = {}): Promise<{ id: string }> {
  return withServiceRole(db, (trx) =>
    trx
      .insertInto('organizations')
      .values({ name: opts.name ?? `Org ${randomUUID().slice(0, 8)}` })
      .returning('id')
      .executeTakeFirstOrThrow(),
  )
}

export async function seedUser(
  db: Kysely<Database>,
  opts: { organizationId: string; email?: string; role?: 'owner' | 'member' },
): Promise<{ id: string }> {
  return withServiceRole(db, async (trx) => {
    const principal = await trx.insertInto('principals').values({ kind: 'user' }).returning('id').executeTakeFirstOrThrow()
    await trx
      .insertInto('users')
      .values({ id: principal.id, email: opts.email ?? `user-${randomUUID()}@example.test` })
      .execute()
    await trx
      .insertInto('memberships')
      .values({
        organization_id: opts.organizationId,
        user_id: principal.id,
        role: opts.role ?? 'member',
        created_by: principal.id,
      })
      .execute()
    return { id: principal.id }
  })
}

export async function seedAgent(
  db: Kysely<Database>,
  opts: { organizationId: string; createdBy: string; name?: string; scopes?: string[] },
): Promise<{ id: string }> {
  return withServiceRole(db, async (trx) => {
    const principal = await trx.insertInto('principals').values({ kind: 'agent' }).returning('id').executeTakeFirstOrThrow()
    await trx
      .insertInto('agents')
      .values({
        id: principal.id,
        organization_id: opts.organizationId,
        name: opts.name ?? `agent-${randomUUID().slice(0, 8)}`,
        scopes: opts.scopes ?? [],
        created_by: opts.createdBy,
      })
      .execute()
    return { id: principal.id }
  })
}
