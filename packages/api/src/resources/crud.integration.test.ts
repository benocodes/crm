import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { asAgent, asUser, seedTenant, type Tenant } from '../test/tenant.js'
import { createResource, deleteResource, getResource, listResource, updateResource } from './crud.js'
import { defineResource } from './define.js'
import { tasks, type TaskRecord } from './tasks.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let a: Tenant
let b: Tenant

const restricted = defineResource<TaskRecord>({ ...tasks, name: 'restricted_tasks', agentWritable: ['title'] })
const unchecked = defineResource<TaskRecord>({ ...tasks, name: 'unchecked_tasks', references: {} })
const uuid7ish = () => `0190b2c4-0000-7000-8000-${randomUUID().slice(24)}`

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})

const eventsOf = (id: string) => owner.selectFrom('events').selectAll().where('resource_id', '=', id).orderBy('id').execute()
const rowOf = (id: string) => owner.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst()

/** Runs fn and returns the ApiError it rejects with. */
async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => undefined,
    (e) => e,
  )
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

beforeEach(async () => {
  await truncateAll(owner)
  a = await seedTenant(db, 'A')
  b = await seedTenant(db, 'B')
})

const mk = (t: Tenant, input: Record<string, unknown> = { title: 'T' }) =>
  asUser(db, t, (ctx) => createResource(ctx, tasks, input))

describe('create', () => {
  it('creates and emits', async () => {
    const r = await mk(a, { title: 'Call Ori' })
    expect(r).toMatchObject({
      title: 'Call Ori',
      status: 'open',
      completed_at: null,
      organization_id: a.organizationId,
      created_by: a.userId,
    })
    expect(typeof r.created_at).toBe('string')
    expect(typeof r.updated_at).toBe('string')
    const ev = await eventsOf(r.id)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: 'task.created', resource_type: 'task', before: null, actor_id: a.userId })
    expect(ev[0]!.after).toEqual(r)
  })

  it('attributes an agent actor', async () => {
    const r = await asAgent(db, a, (ctx) => createResource(ctx, tasks, { title: 'x' }))
    expect(r.created_by).toBe(a.agentId)
    expect((await eventsOf(r.id))[0]!.actor_id).toBe(a.agentId)
  })

  it.each([
    ['created_by', { title: 'a', created_by: 'B_USER' }],
    ['organization_id', { title: 'a', organization_id: 'B_ORG' }],
    ['custom', { title: 'a', custom: {} }],
  ])('rejects unknown field %s', async (_n, input) => {
    const patched = JSON.parse(JSON.stringify(input).replace('B_USER', b.userId).replace('B_ORG', b.organizationId))
    const err = await apiError(mk(a, patched))
    expect(err).toMatchObject({ status: 400, code: 'validation_error' })
    expect(await owner.selectFrom('tasks').selectAll().execute()).toHaveLength(0)
    expect(await owner.selectFrom('events').selectAll().execute()).toHaveLength(0)
  })

  it('runs the validator escape hatch', async () => {
    const r = await mk(a, { title: 'a', status: 'done' })
    expect(typeof r.completed_at).toBe('string')
    expect(r.completed_at).not.toBeNull()
  })

  it('accepts a same-organisation principal reference', async () => {
    const r = await mk(a, { title: 'a', assignee_id: a.agentId })
    expect(r.assignee_id).toBe(a.agentId)
  })

  it('rejects a cross-tenant reference', async () => {
    const err = await apiError(mk(a, { title: 'a', assignee_id: b.userId }))
    expect(err).toMatchObject({ status: 400, code: 'invalid_reference' })
    expect(await owner.selectFrom('tasks').selectAll().execute()).toHaveLength(0)
    expect(await owner.selectFrom('events').selectAll().execute()).toHaveLength(0)
  })

  it('rejects a nonexistent reference', async () => {
    expect(await apiError(mk(a, { title: 'a', assignee_id: uuid7ish() }))).toMatchObject({ code: 'invalid_reference' })
  })

  it('maps the 23503 backstop', async () => {
    const err = await apiError(
      asUser(db, a, (ctx) => createResource(ctx, unchecked, { title: 'a', assignee_id: uuid7ish() })),
    )
    expect(err).toMatchObject({ status: 400, code: 'invalid_reference' })
  })

  it('refuses agent writes outside agentWritable', async () => {
    const err = await apiError(asAgent(db, a, (ctx) => createResource(ctx, restricted, { title: 'a', notes: 'n' })))
    expect(err).toMatchObject({ status: 400, code: 'field_not_writable', message: 'agents may not write: notes' })
  })

  it('agentWritable ignores users', async () => {
    const r = await asUser(db, a, (ctx) => createResource(ctx, restricted, { title: 'a', notes: 'n' }))
    expect(r.notes).toBe('n')
  })

  it('uses the per-request schema', async () => {
    const inputSchema = vi.fn((_ctx: unknown, op: 'create' | 'update') =>
      op === 'create' ? z.strictObject({ title: z.string().min(3) }) : tasks.update,
    )
    const def = defineResource<TaskRecord>({ ...tasks, name: 'schema_tasks', inputSchema })
    expect(await apiError(asUser(db, a, (ctx) => createResource(ctx, def, { title: 'ab' })))).toMatchObject({
      code: 'validation_error',
    })
    const ok = await asUser(db, a, (ctx) => createResource(ctx, def, { title: 'abc' }))
    expect(ok.title).toBe('abc')
    expect(inputSchema).toHaveBeenCalledTimes(2)
    for (const call of inputSchema.mock.calls) {
      expect((call[0] as { organizationId: string }).organizationId).toBe(a.organizationId)
      expect(call[1]).toBe('create')
    }
  })

  it('runs a create override with the parsed input', async () => {
    const create = vi.fn((_ctx: unknown, input: Record<string, unknown>, generic: (i: Record<string, unknown>) => Promise<TaskRecord>) =>
      generic({ ...input, title: `${input.title}!` }),
    )
    const def = defineResource<TaskRecord>({ ...tasks, name: 'override_tasks', overrides: { create } })
    const r = await asUser(db, a, (ctx) => createResource(ctx, def, { title: 'a' }))
    expect(r.title).toBe('a!')
    expect(create.mock.calls[0]![1]).toEqual({ title: 'a' })
    expect((await eventsOf(r.id)).map((e) => e.type)).toEqual(['task.created'])
  })

  it('validates before the override runs', async () => {
    const create = vi.fn()
    const def = defineResource<TaskRecord>({ ...tasks, name: 'override_tasks', overrides: { create } })
    expect(await apiError(asUser(db, a, (ctx) => createResource(ctx, def, {})))).toMatchObject({ code: 'validation_error' })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('read and list', () => {
  it('gets', async () => {
    const r = await mk(a)
    expect(await asUser(db, a, (ctx) => getResource(ctx, tasks, r.id))).toEqual(r)
  })

  it('get cross-tenant is not_found', async () => {
    const r = await mk(b)
    const err = await apiError(asUser(db, a, (ctx) => getResource(ctx, tasks, r.id)))
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'task not found' })
  })

  it('get with a non-UUID id is not_found', async () => {
    expect(await apiError(asUser(db, a, (ctx) => getResource(ctx, tasks, 'abc')))).toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('list is scoped to the organisation', async () => {
    for (let i = 0; i < 3; i++) await mk(a, { title: `a${i}` })
    for (let i = 0; i < 2; i++) await mk(b, { title: `b${i}` })
    const res = await asUser(db, a, (ctx) => listResource(ctx, tasks, {}))
    expect(res.data).toHaveLength(3)
    expect(res.data.every((t) => t.organization_id === a.organizationId)).toBe(true)
    const ids = res.data.map((t) => t.id)
    expect(ids).toEqual([...ids].sort())
    expect(res.next_cursor).toBeNull()
  })

  it('pages by keyset', async () => {
    const all = new Set<string>()
    for (let i = 0; i < 5; i++) all.add((await mk(a, { title: `t${i}` })).id)
    const pages: string[][] = []
    let after: string | undefined
    let cursor: string | null = null
    for (let i = 0; i < 3; i++) {
      const res = await asUser(db, a, (ctx) => listResource(ctx, tasks, { limit: 2, after }))
      pages.push(res.data.map((t) => t.id))
      cursor = res.next_cursor
      after = cursor ?? undefined
    }
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1])
    expect(cursor).toBeNull()
    for (const p of pages) expect(p).toEqual([...p].sort())
    expect(pages[1]![0]! > pages[0]![1]!).toBe(true)
    expect(pages[2]![0]! > pages[1]![1]!).toBe(true)
    expect(new Set(pages.flat())).toEqual(all)
    expect(pages.flat()).toHaveLength(5)
  })

  it('filters', async () => {
    await mk(a, { title: 'o' })
    const done = await mk(a, { title: 'd', status: 'done' })
    const assigned = await mk(a, { title: 'g', assignee_id: a.agentId })
    const byStatus = await asUser(db, a, (ctx) => listResource(ctx, tasks, { filters: { status: 'done' } }))
    expect(byStatus.data.map((t) => t.id)).toEqual([done.id])
    const byAssignee = await asUser(db, a, (ctx) => listResource(ctx, tasks, { filters: { assignee_id: a.agentId } }))
    expect(byAssignee.data.map((t) => t.id)).toEqual([assigned.id])
  })

  it('rejects a bad query', async () => {
    expect(await apiError(asUser(db, a, (ctx) => listResource(ctx, tasks, { limit: 0 })))).toMatchObject({
      code: 'validation_error',
    })
    expect(await apiError(asUser(db, a, (ctx) => listResource(ctx, tasks, { filters: { title: 'x' } })))).toMatchObject({
      code: 'validation_error',
    })
  })
})

describe('update', () => {
  it('updates and emits', async () => {
    const r = await mk(a, { title: 'Old' })
    const u = await asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { title: 'New' }))
    expect(u.title).toBe('New')
    expect(new Date(u.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(r.updated_at).getTime())
    const ev = (await eventsOf(r.id)).filter((e) => e.type === 'task.updated')
    expect(ev).toHaveLength(1)
    expect((ev[0]!.before as TaskRecord).title).toBe('Old')
    expect((ev[0]!.after as TaskRecord).title).toBe('New')
    expect(ev[0]!.actor_id).toBe(a.userId)
  })

  it('sets then clears completed_at', async () => {
    const r = await mk(a)
    const done = await asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { status: 'done' }))
    expect(done.completed_at).not.toBeNull()
    const open = await asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { status: 'open' }))
    expect(open.completed_at).toBeNull()
    expect((await eventsOf(r.id)).filter((e) => e.type === 'task.updated')).toHaveLength(2)
  })

  it('treats an empty patch as a no-op', async () => {
    const r = await mk(a)
    const u = await asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, {}))
    expect(u).toEqual(r)
    expect((await eventsOf(r.id)).filter((e) => e.type === 'task.updated')).toHaveLength(0)
  })

  it.each([[{ id: 'x' }], [{ completed_at: '2026-10-17T10:00:00Z' }]])('rejects unknown field %j', async (input) => {
    const r = await mk(a)
    expect(await apiError(asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, input)))).toMatchObject({
      code: 'validation_error',
    })
  })

  it('cross-tenant is not_found and changes nothing', async () => {
    const r = await mk(b, { title: 'B' })
    const err = await apiError(asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { title: 'hacked' })))
    expect(err).toMatchObject({ status: 404, code: 'not_found' })
    expect((await rowOf(r.id))!.title).toBe('B')
    expect((await eventsOf(r.id)).filter((e) => e.type === 'task.updated')).toHaveLength(0)
  })

  it('a deleted task is not_found', async () => {
    const r = await mk(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id))
    expect(await apiError(asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { title: 'x' })))).toMatchObject({
      code: 'not_found',
    })
  })

  it('checks references on update', async () => {
    const r = await mk(a)
    expect(await apiError(asUser(db, a, (ctx) => updateResource(ctx, tasks, r.id, { assignee_id: b.userId })))).toMatchObject({
      code: 'invalid_reference',
    })
  })

  it('enforces agentWritable on update', async () => {
    const r = await mk(a)
    expect(await apiError(asAgent(db, a, (ctx) => updateResource(ctx, restricted, r.id, { notes: 'x' })))).toMatchObject({
      code: 'field_not_writable',
    })
  })
})

describe('delete', () => {
  it('soft deletes and emits', async () => {
    const r = await mk(a)
    const res = await asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id))
    expect(res).toBeUndefined()
    expect((await rowOf(r.id))!.deleted_at).not.toBeNull()
    const ev = (await eventsOf(r.id)).filter((e) => e.type === 'task.deleted')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.before).toEqual(r)
    expect(ev[0]!.after).toBeNull()
  })

  it('hides a deleted task from get and list', async () => {
    const r = await mk(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id))
    expect(await apiError(asUser(db, a, (ctx) => getResource(ctx, tasks, r.id)))).toMatchObject({ code: 'not_found' })
    const list = await asUser(db, a, (ctx) => listResource(ctx, tasks, {}))
    expect(list.data.map((t) => t.id)).not.toContain(r.id)
  })

  it('a second delete is not_found', async () => {
    const r = await mk(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id))
    expect(await apiError(asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id)))).toMatchObject({ code: 'not_found' })
    expect((await eventsOf(r.id)).filter((e) => e.type === 'task.deleted')).toHaveLength(1)
  })

  it('cross-tenant is not_found and leaves the row live', async () => {
    const r = await mk(b)
    expect(await apiError(asUser(db, a, (ctx) => deleteResource(ctx, tasks, r.id)))).toMatchObject({ code: 'not_found' })
    expect((await rowOf(r.id))!.deleted_at).toBeNull()
  })

  it('runs a delete override', async () => {
    const del = vi.fn((_ctx: unknown, id: string, generic: (id: string) => Promise<void>) => generic(id))
    const def = defineResource<TaskRecord>({ ...tasks, name: 'override_tasks', overrides: { delete: del } })
    const r = await mk(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, def, r.id))
    expect(del).toHaveBeenCalledTimes(1)
    expect(del.mock.calls[0]![1]).toBe(r.id)
    expect(typeof del.mock.calls[0]![2]).toBe('function')
    expect((await rowOf(r.id))!.deleted_at).not.toBeNull()
    expect((await eventsOf(r.id)).filter((e) => e.type === 'task.deleted')).toHaveLength(1)
  })
})

describe('transaction', () => {
  it('a failed operation leaves nothing', async () => {
    await expect(
      asUser(db, a, async (ctx) => {
        const r = await createResource(ctx, tasks, { title: 'x' })
        await updateResource(ctx, tasks, r.id, { title: 'y' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await owner.selectFrom('tasks').selectAll().execute()).toHaveLength(0)
    expect(await owner.selectFrom('events').selectAll().execute()).toHaveLength(0)
  })
})
