import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '../rest/app.js'
import { Registry } from '../registry.js'
import { createResource } from '../resources/crud.js'
import { legacyTasks as tasks } from './legacy-tasks.js'
import { assertFixturesCoverRegistry, runContractSuite, type ContractCheck, type ContractFixture } from './contract.js'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'

const taskViews = { ...tasks, name: 'task_views', operations: ['list', 'get'], create: undefined, update: undefined } as never
const assignedTasks = { ...tasks, name: 'assigned_tasks', scopeResource: 'tasks' } as never

// A read-only definition whose create is served by a hand-written operation (api_keys' shape).
const postedViews = { ...tasks, name: 'posted_views', operations: ['list', 'get'], create: undefined, update: undefined } as never
// A read-only definition whose rows need a second user, seeded through the kit.
const seededViews = { ...tasks, name: 'seeded_views', operations: ['list', 'get'], create: undefined, update: undefined } as never

const registry = new Registry()
  .registerResource(tasks)
  .registerResource(taskViews)
  .registerResource(assignedTasks)
  .registerResource(postedViews)
  .registerResource(seededViews)
  .register({
    kind: 'tenant',
    name: 'posted_views.create',
    summary: 'Hand-written create',
    method: 'post',
    path: '/posted-views',
    scope: { resource: 'tasks', action: 'write' },
    response: { status: 201, schema: z.object({ id: z.string() }) },
    handler: async (ctx) => createResource(ctx, tasks, { title: 'posted' }),
  })
const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  task_views: { make: (kit) => kit.ctx((ctx) => createResource(ctx, tasks, { title: 'v' })) },
  assigned_tasks: {
    // The builder names the tenant's own user: the reference check only passes in the right org.
    input: async (kit) => ({ title: 'x', assignee_id: kit.tenant.userId }),
    patch: async () => ({ title: 'Renamed' }),
  },
  posted_views: { make: (kit) => kit.ctx((ctx) => createResource(ctx, tasks, { title: 'p' })), handwritten: ['create'] },
  seeded_views: {
    async make(kit) {
      const m = await kit.seedMember()
      expect(m.userId).toMatch(/^[0-9a-f-]{36}$/)
      expect(m.membershipId).toMatch(/^[0-9a-f-]{36}$/)
      return kit.ctx((ctx) => {
        expect(kit.tenant.organizationId).toBe(ctx.organizationId)
        return createResource(ctx, tasks, { title: 's' })
      })
    },
  },
}

const seen: string[] = []
const spyCheck: ContractCheck = (def, _fixture, env) => {
  seen.push(def.name)
  it(`check hook runs for ${def.name}`, () => {
    expect(env().a.organizationId).toMatch(/^[0-9a-f-]{36}$/)
  })
}

runContractSuite({ registry, fixtures, checks: [spyCheck] })

describe('suite shape', () => {
  it('calls the hook per definition', () => {
    expect(seen).toEqual(['tasks', 'task_views', 'assigned_tasks', 'posted_views', 'seeded_views'])
  })
  it('documents read-only definitions without write routes', async () => {
    const app = createApp({ db: () => ({}) as Kysely<Database>, registry })
    const d = (await (await app.request('/openapi.json')).json()) as any
    expect(Object.keys(d.paths['/task-views'])).toEqual(['get'])
    expect(Object.keys(d.paths['/task-views/{id}'])).toEqual(['get'])
  })
  it('fails the catalog check on a missing fixture', () => {
    expect(() => assertFixturesCoverRegistry(new Registry().registerResource(tasks), {})).toThrow(/tasks/)
    expect(() => assertFixturesCoverRegistry(new Registry().registerResource(tasks), { tasks: {}, stale: {} })).toThrow(/stale/)
  })
})
