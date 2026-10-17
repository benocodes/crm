import { describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { Registry } from '../registry.js'
import { createResource } from '../resources/crud.js'
import { tasks } from '../resources/tasks.js'
import { assertFixturesCoverRegistry, runContractSuite, type ContractCheck, type ContractFixture } from './contract.js'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'

const taskViews = { ...tasks, name: 'task_views', operations: ['list', 'get'], create: undefined, update: undefined } as never
const assignedTasks = { ...tasks, name: 'assigned_tasks', scopeResource: 'tasks' } as never

const registry = new Registry().registerResource(tasks).registerResource(taskViews).registerResource(assignedTasks)
const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  task_views: { make: (ctx) => createResource(ctx, tasks, { title: 'v' }) },
  assigned_tasks: {
    input: async (ctx) => {
      // The builder runs in the tenant's context: the reference check only passes in the right org.
      return { title: 'x', assignee_id: ctx.actor.id }
    },
    patch: async () => ({ title: 'Renamed' }),
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
    expect(seen).toEqual(['tasks', 'task_views', 'assigned_tasks'])
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
