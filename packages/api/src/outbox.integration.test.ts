import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { withOrganization, withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { writeEvent } from './outbox.js'
import { seedTenant, type Tenant } from './test/tenant.js'

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

describe('writeEvent', () => {
  beforeEach(async () => {
    await truncateAll(owner)
    a = await seedTenant(db, 'A')
    b = await seedTenant(db, 'B')
  })

  const asA = <T>(fn: Parameters<typeof withOrganization<T>>[2]) =>
    withOrganization(db, { principalId: a.userId, organizationId: a.organizationId }, fn)
  const eventsOf = (resourceId: string) =>
    owner.selectFrom('events').selectAll().where('resource_id', '=', resourceId).execute()

  it('writes the row', async () => {
    const r = randomUUID()
    const after = { id: r, title: 'a', n: 1, ok: true }
    await asA((trx) =>
      writeEvent(trx, {
        organizationId: a.organizationId,
        actorId: a.userId,
        type: 'task.created',
        resourceType: 'task',
        resourceId: r,
        before: null,
        after,
      }),
    )
    const rows = await eventsOf(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'task.created',
      resource_type: 'task',
      resource_id: r,
      organization_id: a.organizationId,
      actor_id: a.userId,
      before: null,
    })
    expect(rows[0]!.after).toEqual(after)
  })

  it('round-trips scalars and nesting', async () => {
    const r = randomUUID()
    const after = { s: 'x', n: 0, b: false, nil: null, arr: [1, '2'], obj: { k: 'v' } }
    await asA((trx) =>
      writeEvent(trx, {
        organizationId: a.organizationId,
        actorId: a.userId,
        type: 'probe.created',
        resourceType: 'probe',
        resourceId: r,
        before: { s: 'old' },
        after,
      }),
    )
    const [row] = await eventsOf(r)
    expect(row!.after).toEqual(after)
    expect(row!.before).toEqual({ s: 'old' })
  })

  it('returns the id (UUIDv7)', async () => {
    const r = randomUUID()
    const { id } = await asA((trx) =>
      writeEvent(trx, {
        organizationId: a.organizationId,
        actorId: a.userId,
        type: 'probe.created',
        resourceType: 'probe',
        resourceId: r,
        before: null,
        after: { a: 1 },
      }),
    )
    const [row] = await eventsOf(r)
    expect(row!.id).toBe(id)
    expect(id[14]).toBe('7')
  })

  it("tenant RLS applies: A cannot write B's event", async () => {
    const r = randomUUID()
    await expect(
      asA((trx) =>
        writeEvent(trx, {
          organizationId: b.organizationId,
          actorId: a.userId,
          type: 'probe.created',
          resourceType: 'probe',
          resourceId: r,
          before: null,
          after: null,
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect(await eventsOf(r)).toHaveLength(0)
  })

  it('service role writes with an explicit organisation', async () => {
    const r = randomUUID()
    await withServiceRole(db, async (trx) => {
      for (const t of [a, b]) {
        await writeEvent(trx, {
          organizationId: t.organizationId,
          actorId: t.userId,
          type: 'probe.created',
          resourceType: 'probe',
          resourceId: r,
          before: null,
          after: null,
        })
      }
    })
    const rows = await eventsOf(r)
    expect(rows.map((x) => x.organization_id).sort()).toEqual([a.organizationId, b.organizationId].sort())
  })
})
