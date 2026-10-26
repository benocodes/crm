import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { TenancyContextError, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { withContext } from './context.js'
import { ApiError } from './errors.js'
import { ScopeSet } from './scopes.js'
import { asAgent, asUser, seedTenant, type Tenant } from './test/tenant.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let a: Tenant
let b: Tenant

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})

const eventsOf = (resourceId: string) =>
  owner.selectFrom('events').selectAll().where('resource_id', '=', resourceId).execute()
const uuid7ish = () => `0190b2c4-0000-7000-8000-${randomUUID().slice(24)}`

describe('withContext', () => {
  beforeEach(async () => {
    await truncateAll(owner)
    a = await seedTenant(db, 'A')
    b = await seedTenant(db, 'B')
  })

  it('exposes the principal and no db handle', async () => {
    const scopes = ScopeSet.parse(['tasks:read'])
    await withContext(db, { actor: { id: a.userId, kind: 'user' }, organizationId: a.organizationId, scopes }, async (ctx) => {
      expect(ctx.organizationId).toBe(a.organizationId)
      expect(ctx.actor).toEqual({ id: a.userId, kind: 'user' })
      expect(ctx.scopes.has({ resource: 'tasks', action: 'read' })).toBe(true)
      expect('db' in ctx).toBe(false)
    })
  })

  it('emit attributes the event to the context', async () => {
    const x = randomUUID()
    await asAgent(db, a, (ctx) =>
      ctx.emit({ type: 'probe.created', resourceType: 'probe', resourceId: x, before: null, after: { a: 1 } }),
    )
    const rows = await eventsOf(x)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ organization_id: a.organizationId, actor_id: a.agentId })
  })

  it('rollback discards the event', async () => {
    const x = randomUUID()
    await expect(
      asUser(db, a, async (ctx) => {
        await ctx.emit({ type: 'probe.created', resourceType: 'probe', resourceId: x, before: null, after: { a: 1 } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await eventsOf(x)).toHaveLength(0)
  })

  it('isolates tenants inside the context', async () => {
    await asUser(db, b, (ctx) =>
      ctx.trx.insertInto('tasks').values({ organization_id: b.organizationId, title: 'b', created_by: b.userId }).execute(),
    )
    const rows = await asUser(db, a, (ctx) => ctx.trx.selectFrom('tasks').selectAll().execute())
    expect(rows).toEqual([])
  })

  it.each([
    ['', 'missing_organization'],
    ['x', 'invalid_id'],
  ])('rejects organisation id %j with %s before opening a transaction', async (organizationId, code) => {
    const x = randomUUID()
    let ran = false
    const err = await withContext(
      db,
      { actor: { id: a.userId, kind: 'user' }, organizationId, scopes: ScopeSet.parse([]) },
      async (ctx) => {
        ran = true
        await ctx.emit({ type: 'probe.created', resourceType: 'probe', resourceId: x, before: null, after: null })
      },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(TenancyContextError)
    expect(err.code).toBe(code)
    expect(ran).toBe(false)
    expect(await eventsOf(x)).toHaveLength(0)
  })

  it('maps 23503 to invalid_reference after rollback', async () => {
    const err = await asUser(db, a, (ctx) =>
      ctx.trx
        .insertInto('tasks')
        .values({ organization_id: a.organizationId, title: 't', created_by: a.userId, assignee_id: uuid7ish() })
        .execute(),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'invalid_reference' })
    expect(await owner.selectFrom('tasks').selectAll().execute()).toHaveLength(0)
  })
})
