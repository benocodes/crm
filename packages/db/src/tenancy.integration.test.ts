import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql, type Kysely, type Transaction } from 'kysely'
import { TenancyContextError, withOrganization, withServiceRole } from './tenancy.js'
import {
  createOwnerTestDb,
  createTestDb,
  seedAgent,
  seedOrganization,
  seedUser,
  truncateAll,
} from './test/index.js'
import type { Database } from './types.js'

type Tenant = { orgId: string; userId: string; agentId: string; taskId: string }

let db: Kysely<Database>
let owner: Kysely<Database>
let A: Tenant
let B: Tenant

const ctx = (t: Tenant, principalId = t.userId) => ({ principalId, organizationId: t.orgId })

async function seedTenant(name: string): Promise<Tenant> {
  const org = await seedOrganization(db, { name })
  const user = await seedUser(db, { organizationId: org.id, role: 'owner' })
  const agent = await seedAgent(db, { organizationId: org.id, createdBy: user.id })
  const task = await withServiceRole(db, (trx) =>
    trx
      .insertInto('tasks')
      .values({ organization_id: org.id, title: `task of ${name}`, created_by: user.id })
      .returning('id')
      .executeTakeFirstOrThrow(),
  )
  return { orgId: org.id, userId: user.id, agentId: agent.id, taskId: task.id }
}

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})

describe('tenancy wrappers', () => {
  beforeEach(async () => {
    await truncateAll(owner)
    A = await seedTenant('A')
    B = await seedTenant('B')
  })

  const settings = (d: Kysely<Database>) =>
    sql<{ o: string | null; p: string | null }>`
      SELECT current_setting('app.organization_id', true) AS o, current_setting('app.principal_id', true) AS p`.execute(d)

  it('service role sees all', async () => {
    const rows = await withServiceRole(db, (trx) => trx.selectFrom('tasks').select('id').execute())
    expect(rows.map((r) => r.id).sort()).toEqual([A.taskId, B.taskId].sort())
  })

  it('tenant sees own tasks', async () => {
    const rows = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('tasks').select('id').execute())
    expect(rows.map((r) => r.id)).toEqual([A.taskId])
  })

  it("other tenant's id is invisible", async () => {
    const rows = await withOrganization(db, ctx(A), (trx) =>
      trx.selectFrom('tasks').select('id').where('id', '=', B.taskId).execute(),
    )
    expect(rows).toEqual([])
  })

  it('cross-tenant insert refused', async () => {
    await expect(
      withOrganization(db, ctx(A), (trx) =>
        trx.insertInto('tasks').values({ organization_id: B.orgId, title: 'x', created_by: A.userId }).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('row-level security') })
  })

  it('own insert allowed', async () => {
    const row = await withOrganization(db, ctx(A), (trx) =>
      trx
        .insertInto('tasks')
        .values({ organization_id: A.orgId, title: 'mine', created_by: A.userId })
        .returning(['id', 'title'])
        .executeTakeFirstOrThrow(),
    )
    expect(row.title).toBe('mine')
    const seenByA = await withOrganization(db, ctx(A), (trx) =>
      trx.selectFrom('tasks').select('id').where('id', '=', row.id).execute(),
    )
    const seenByB = await withOrganization(db, ctx(B), (trx) =>
      trx.selectFrom('tasks').select('id').where('id', '=', row.id).execute(),
    )
    expect(seenByA).toHaveLength(1)
    expect(seenByB).toHaveLength(0)
  })

  it('cross-tenant update is a no-op', async () => {
    const res = await withOrganization(db, ctx(A), (trx) =>
      trx.updateTable('tasks').set({ title: 'hijacked' }).where('id', '=', B.taskId).executeTakeFirst(),
    )
    expect(res.numUpdatedRows).toBe(0n)
    const row = await withServiceRole(db, (trx) =>
      trx.selectFrom('tasks').select('title').where('id', '=', B.taskId).executeTakeFirstOrThrow(),
    )
    expect(row.title).toBe('task of B')
  })

  it('no deletes', async () => {
    await expect(
      withOrganization(db, ctx(A), (trx) => trx.deleteFrom('tasks').where('id', '=', A.taskId).execute()),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('events append-only', async () => {
    const ev = await withOrganization(db, ctx(A, A.agentId), (trx) =>
      trx
        .insertInto('events')
        .values({
          organization_id: A.orgId,
          type: 'task.created',
          resource_type: 'task',
          resource_id: A.taskId,
          actor_id: A.agentId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    )
    await expect(
      withOrganization(db, ctx(A), (trx) =>
        trx.updateTable('events').set({ type: 'x' }).where('id', '=', ev.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withOrganization(db, ctx(A), (trx) => trx.deleteFrom('events').where('id', '=', ev.id).execute()),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('events are tenant-scoped', async () => {
    await withServiceRole(db, async (trx) => {
      for (const t of [A, B]) {
        await trx
          .insertInto('events')
          .values({
            organization_id: t.orgId,
            type: 'task.created',
            resource_type: 'task',
            resource_id: t.taskId,
            actor_id: t.userId,
          })
          .execute()
      }
    })
    const rows = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('events').select('organization_id').execute())
    expect(rows).toEqual([{ organization_id: A.orgId }])
  })

  it('organizations scoped', async () => {
    const rows = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('organizations').select('id').execute())
    expect(rows).toEqual([{ id: A.orgId }])
  })

  it('principals scoped', async () => {
    const rows = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('principals').select('id').execute())
    expect(rows.map((r) => r.id).sort()).toEqual([A.userId, A.agentId].sort())
  })

  it('users scoped', async () => {
    const rows = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('users').select('id').execute())
    expect(rows).toEqual([{ id: A.userId }])
  })

  it('memberships and agents scoped', async () => {
    const m = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('memberships').select('organization_id').execute())
    const a = await withOrganization(db, ctx(A), (trx) => trx.selectFrom('agents').select('id').execute())
    expect(m).toEqual([{ organization_id: A.orgId }])
    expect(a).toEqual([{ id: A.agentId }])
  })

  it('keys hidden from tenants', async () => {
    await expect(
      withOrganization(db, ctx(A), (trx) => trx.selectFrom('api_keys').selectAll().execute()),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('identity tables are service-only', async () => {
    const attempts: Array<(trx: Transaction<Database>) => Promise<unknown>> = [
      (trx) => trx.insertInto('organizations').values({ name: 'x' }).execute(),
      (trx) => trx.insertInto('principals').values({ kind: 'user' }).execute(),
      (trx) => trx.insertInto('users').values({ id: A.userId, email: 'z@x.test' }).execute(),
    ]
    for (const attempt of attempts) {
      await expect(withOrganization(db, ctx(A), attempt)).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('context functions', async () => {
    const { rows } = await withOrganization(db, ctx(A, A.agentId), (trx) =>
      sql<{ o: string; p: string }>`SELECT app.current_organization_id() AS o, app.current_principal_id() AS p`.execute(trx),
    )
    expect(rows[0]).toEqual({ o: A.orgId, p: A.agentId })
  })

  it('rollback on throw', async () => {
    await expect(
      withOrganization(db, ctx(A), async (trx) => {
        await trx.insertInto('tasks').values({ organization_id: A.orgId, title: 'ghost', created_by: A.userId }).execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const rows = await withServiceRole(db, (trx) => trx.selectFrom('tasks').select('id').where('title', '=', 'ghost').execute())
    expect(rows).toEqual([])
  })

  it('return value', async () => {
    expect(await withOrganization(db, ctx(A), async () => 42)).toBe(42)
  })

  describe('validation', () => {
    const uuid = '0198f0f0-0000-7000-8000-000000000000'
    it('missing organisation', async () => {
      const fn = vi.fn(async () => 1)
      await expect(withOrganization(db, { principalId: uuid, organizationId: '' }, fn)).rejects.toMatchObject({
        name: 'TenancyContextError',
        code: 'missing_organization',
      })
      expect(fn).not.toHaveBeenCalled()
    })
    it('missing principal', async () => {
      const fn = vi.fn(async () => 1)
      await expect(withOrganization(db, { principalId: '', organizationId: uuid }, fn)).rejects.toMatchObject({
        code: 'missing_principal',
      })
      expect(fn).not.toHaveBeenCalled()
    })
    it('invalid id', async () => {
      const fn = vi.fn(async () => 1)
      const p = withOrganization(db, { principalId: uuid, organizationId: 'not-a-uuid' }, fn)
      await expect(p).rejects.toBeInstanceOf(TenancyContextError)
      await expect(p).rejects.toMatchObject({ code: 'invalid_id' })
      expect(fn).not.toHaveBeenCalled()
    })
  })
})

describe('tenancy wrappers: connection reuse', () => {
  let one: Kysely<Database>
  let org: string
  let user: string

  beforeAll(() => {
    one = createTestDb({ max: 1 })
  })
  afterAll(async () => {
    await one.destroy()
  })
  beforeEach(async () => {
    await truncateAll(owner)
    org = (await seedOrganization(db, { name: 'Reuse' })).id
    user = (await seedUser(db, { organizationId: org })).id
  })

  const read = async () => {
    const { rows } = await sql<{ o: string | null; p: string | null }>`
      SELECT current_setting('app.organization_id', true) AS o, current_setting('app.principal_id', true) AS p`.execute(one)
    return rows[0]!
  }

  it("settings don't leak", async () => {
    await withOrganization(one, { principalId: user, organizationId: org }, async () => 1)
    const s = await read()
    expect(s.o ?? '').toBe('')
    expect(s.p ?? '').toBe('')
  })

  it("settings don't leak after rollback", async () => {
    const err = new Error('boom')
    await expect(
      withOrganization(one, { principalId: user, organizationId: org }, async () => {
        throw err
      }),
    ).rejects.toBe(err)
    const s = await read()
    expect(s.o ?? '').toBe('')
    expect(s.p ?? '').toBe('')
  })

  it("role doesn't leak", async () => {
    const who = async () => (await sql<{ current_user: string }>`SELECT current_user`.execute(one)).rows[0]!.current_user
    await withOrganization(one, { principalId: user, organizationId: org }, async () => 1)
    expect(await who()).toBe('vault_app')
    await withServiceRole(one, async () => 1)
    expect(await who()).toBe('vault_app')
  })
})
