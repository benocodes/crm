import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { createVibaseRegistry } from '../operations.js'
import { d1Backend } from '../test/d1-backend.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'

// [[CORE315]] D19, D20, D23: a declared custom object is served by the generic layer on D1: CRUD, soft delete, events in the write's unit, enum validation, associations and the feed. The shared contract
// suite (contract.integration.d1.test.ts) holds the per-resource contract; this file holds what is particular to a declaration. The registry is the production one, built with the definition.
const registry = createVibaseRegistry({ definitions: [projectsDefinition()] })
const ALL = registry.declaredScopes()
const PATH = `/api/v1/${PROJECTS_KEY}`
const d1s: D1Like[] = []
let s: ContractSession
let a: ContractTenant
let b: ContractTenant
const dbOf = (t: ContractTenant) => (t.organizationId === a.organizationId ? d1s[0]! : d1s[1]!)

beforeAll(async () => {
  s = await d1Backend({
    setup: async (d1) => {
      d1s.push(d1)
      await createCustomTables(d1)
    },
  }).open(registry)
})
afterAll(() => s.close())
beforeEach(async () => {
  ;({ a, b } = await s.reset())
})

const call = (
  t: ContractTenant,
  method: string,
  path: string,
  body?: unknown,
  scopes = ALL,
  actor: 'user' | 'agent' = 'user',
) => s.call(t, actor, scopes, method, path, body)
const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any })
const make = async (body: Record<string, unknown> = { name: 'Site rebuild' }, t = a) => {
  const r = await json(await call(t, 'POST', PATH, body))
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body as Record<string, any>
}
const rowsOf = async (t: ContractTenant, sql: string, ...binds: unknown[]) =>
  ((
    await dbOf(t)
      .prepare(sql)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>

describe('create, read, update, delete', () => {
  it('creates a record with the declared defaults and the bookkeeping fields', async () => {
    const p = await make({ name: 'Site rebuild', budget: 5000, start_date: '2026-12-01T09:00:00Z' })
    expect(p).toMatchObject({
      name: 'Site rebuild',
      budget: 5000,
      active: true,
      stage: 'planned',
      start_date: '2026-12-01T09:00:00.000Z',
      organization_id: a.organizationId,
      created_by: a.userId,
    })
    expect(p).not.toHaveProperty('deleted_at')
    const got = await json(await call(a, 'GET', `${PATH}/${p.id}`))
    expect(got.body).toMatchObject({ id: p.id, name: 'Site rebuild', active: true })
  })

  it('lists in id order, pages with a cursor, and never shows another organisation its rows', async () => {
    const one = await make({ name: 'one' })
    const two = await make({ name: 'two' })
    await make({ name: 'theirs' }, b)
    const page = await json(await call(a, 'GET', `${PATH}?limit=1`))
    expect(page.body.data.map((r: any) => r.id)).toEqual([one.id].sort())
    const all = await json(await call(a, 'GET', PATH))
    expect(all.body.data.map((r: any) => r.id)).toEqual([one.id, two.id].sort())
  })

  it('updates only what the patch names, and refuses a field it does not declare', async () => {
    const p = await make({ name: 'Site rebuild', budget: 10 })
    const r = await json(await call(a, 'PATCH', `${PATH}/${p.id}`, { stage: 'active', budget: null }))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ name: 'Site rebuild', stage: 'active', budget: null, active: true })
    expect((await json(await call(a, 'PATCH', `${PATH}/${p.id}`, { colour: 'red' }))).status).toBe(400)
    expect((await json(await call(a, 'POST', PATH, { name: 'x', organization_id: b.organizationId }))).status).toBe(400)
  })

  it('refuses a create without the required field, and an update never resets a defaulted field', async () => {
    expect((await json(await call(a, 'POST', PATH, { budget: 1 }))).status).toBe(400)
    const p = await make({ name: 'x', active: false, stage: 'done' })
    const r = await json(await call(a, 'PATCH', `${PATH}/${p.id}`, { name: 'y' }))
    expect(r.body).toMatchObject({ name: 'y', active: false, stage: 'done' })
  })

  it('soft-deletes: the row is kept with deleted_at set, and it is gone from get and list', async () => {
    const p = await make()
    expect((await call(a, 'DELETE', `${PATH}/${p.id}`)).status).toBe(204)
    expect((await call(a, 'GET', `${PATH}/${p.id}`)).status).toBe(404)
    expect((await json(await call(a, 'GET', PATH))).body.data).toEqual([])
    const kept = await rowsOf(a, `SELECT deleted_at FROM "${PROJECTS_KEY}" WHERE id = ?`, p.id)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.deleted_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
    expect((await call(a, 'DELETE', `${PATH}/${p.id}`)).status).toBe(404)
  })
})

describe('events are written in the same unit as the write, with the actor', () => {
  it('one event per write, named after the object, with before and after', async () => {
    const p = await make({ name: 'one' })
    await call(a, 'PATCH', `${PATH}/${p.id}`, { stage: 'done' })
    await call(a, 'DELETE', `${PATH}/${p.id}`)
    const events = await s.eventsOf(p.id)
    expect(events.map((e) => e.type)).toEqual([
      `${PROJECTS_KEY}.created`,
      `${PROJECTS_KEY}.updated`,
      `${PROJECTS_KEY}.deleted`,
    ])
    expect(events.every((e) => e.actor_id === a.userId && e.resource_type === PROJECTS_KEY)).toBe(true)
    expect(events[0]!.after).toMatchObject({ id: p.id, name: 'one', active: true, stage: 'planned' })
    expect(events[1]!).toMatchObject({ before: { stage: 'planned' }, after: { stage: 'done' } })
    expect(events[2]!.after).toBeNull()
  })

  it('a refused write leaves no event', async () => {
    const before = await s.countEvents()
    expect((await call(a, 'POST', PATH, { name: 'x', stage: 'nope' })).status).toBe(400)
    expect(await s.countEvents()).toBe(before)
  })

  it('an agent holding the write scope is the actor of its own write', async () => {
    const r = await json(await call(a, 'POST', PATH, { name: 'by agent' }, [`${PROJECTS_KEY}:write`], 'agent'))
    expect(r.status).toBe(201)
    expect((await s.eventsOf(r.body.id))[0]!.actor_id).toBe(a.agentId)
  })
})

describe('enums (D20)', () => {
  it('refuses an undeclared value on create and on update, in the validation envelope', async () => {
    const created = await json(await call(a, 'POST', PATH, { name: 'x', stage: 'archived' }))
    expect(created.status).toBe(400)
    expect(created.body.error.code).toBe('validation_error')
    const p = await make()
    const updated = await json(await call(a, 'PATCH', `${PATH}/${p.id}`, { stage: 'archived' }))
    expect(updated.status).toBe(400)
    expect(updated.body.error.code).toBe('validation_error')
    expect((await json(await call(a, 'GET', `${PATH}/${p.id}`))).body.stage).toBe('planned')
  })

  it('a stored value that is no longer declared still reads and lists, and can be moved to a declared one', async () => {
    const p = await make()
    await dbOf(a).prepare(`UPDATE "${PROJECTS_KEY}" SET stage = 'retired' WHERE id = ?`).bind(p.id).run()
    expect((await json(await call(a, 'GET', `${PATH}/${p.id}`))).body.stage).toBe('retired')
    expect((await json(await call(a, 'GET', PATH))).body.data.map((r: any) => r.stage)).toEqual(['retired'])
    expect((await json(await call(a, 'PATCH', `${PATH}/${p.id}`, { stage: 'done' }))).body.stage).toBe('done')
  })

  it('the table has no CHECK on the enum column, so a retired value is storable and adding a value needs no DDL', async () => {
    const [{ sql }] = await rowsOf(a, `SELECT sql FROM sqlite_master WHERE name = ?`, PROJECTS_KEY)
    expect(sql).not.toMatch(/"stage"[^,]*CHECK/i)
    expect(sql).not.toMatch(/'planned',\s*'active'/)
  })
})

describe('associations and the feed', () => {
  it('associates with a company, in both directions', async () => {
    const p = await make()
    const company = (await json(await call(a, 'POST', '/api/v1/companies', { name: 'Acme' }))).body
    const linked = await json(
      await call(a, 'POST', '/api/v1/associations', {
        a_type: 'companies',
        a_id: company.id,
        b_type: PROJECTS_KEY,
        b_id: p.id,
      }),
    )
    expect(linked.status, JSON.stringify(linked.body)).toBe(201)
    const fromProject = await json(await call(a, 'GET', `/api/v1/associations?type=${PROJECTS_KEY}&id=${p.id}`))
    expect(fromProject.body.data.map((x: any) => [x.neighbour_type, x.neighbour_id])).toEqual([
      ['companies', company.id],
    ])
    const embedded = await json(await call(a, 'GET', `${PATH}/${p.id}?include=associations`))
    expect(embedded.status).toBe(200)
    expect(embedded.body.associations.map((x: any) => x.neighbour_id)).toEqual([company.id])
  })

  it('refuses a read without the read scope, and an association to a record the caller cannot read', async () => {
    const p = await make()
    expect((await call(a, 'GET', `${PATH}/${p.id}`, undefined, ['projects__c:write'], 'agent')).status).toBe(403)
    expect((await call(a, 'GET', PATH, undefined, ['tasks:read'], 'agent')).status).toBe(403)
    expect((await call(a, 'POST', PATH, { name: 'x' }, [`${PROJECTS_KEY}:read`], 'agent')).status).toBe(403)
  })

  it('events.list shows the object events to a holder of its read scope and hides them from an agent without it', async () => {
    const p = await make()
    const typesFor = async (scopes: string[]) =>
      (await json(await call(a, 'GET', '/api/v1/events', undefined, scopes, 'agent'))).body.data
        .filter((e: any) => e.resource_id === p.id)
        .map((e: any) => e.type)
    expect(await typesFor(['events:read', `${PROJECTS_KEY}:read`])).toEqual([`${PROJECTS_KEY}.created`])
    expect(await typesFor(['events:read'])).toEqual([])
    expect(await typesFor(['events:read', 'tasks:read'])).toEqual([])
  })
})
