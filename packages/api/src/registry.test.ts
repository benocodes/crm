import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineOperation, unit } from '@vault/storage'
import { Registry, resourceOperations, toolName, type Operation } from './registry.js'
import { tasks } from './resources/tasks.js'
import { probeUnit } from './test/storage.js'
import { parseScope } from './scopes.js'

const op = (over: Partial<Operation> = {}): Operation =>
  ({
    kind: 'tenant',
    name: 'probe.one',
    summary: 'One',
    method: 'get',
    path: '/x',
    scope: parseScope('tasks:read'),
    response: { status: 200, schema: z.object({}) },
    prepare: () => probeUnit({}),
    ...over,
  }) as Operation

describe('resourceOperations', () => {
  it('generates five', () => {
    const ops = resourceOperations(tasks)
    expect(ops.map((o) => o.name)).toEqual(['tasks.list', 'tasks.get', 'tasks.create', 'tasks.update', 'tasks.delete'])
    expect(ops.map((o) => `${o.method.toUpperCase()} ${o.path}`)).toEqual([
      'GET /tasks',
      'GET /tasks/{id}',
      'POST /tasks',
      'PATCH /tasks/{id}',
      'DELETE /tasks/{id}',
    ])
    expect(ops.map((o) => `${o.scope.resource}:${o.scope.action}`)).toEqual([
      'tasks:read',
      'tasks:read',
      'tasks:write',
      'tasks:write',
      'tasks:write',
    ])
    expect(ops.map((o) => o.response.status)).toEqual([200, 200, 201, 200, 204])
    expect(ops.every((o) => o.validation === 'handler')).toBe(true)
    expect(ops.map((o) => o.summary)).toEqual(['List tasks', 'Get a task', 'Create a task', 'Update a task', 'Delete a task'])
  })
  it('subset', () => {
    const ro = { ...tasks, name: 'task_views', operations: ['list', 'get'], create: undefined, update: undefined } as never
    const ops = resourceOperations(ro)
    expect(ops.map((o) => o.name)).toEqual(['task_views.list', 'task_views.get'])
    expect(ops.map((o) => o.path)).toEqual(['/task-views', '/task-views/{id}'])
  })
  it('scope resource', () => {
    const ops = resourceOperations({ ...tasks, name: 'task_notes', scopeResource: 'tasks' })
    expect(ops.map((o) => `${o.scope.resource}:${o.scope.action}`)).toEqual([
      'tasks:read',
      'tasks:read',
      'tasks:write',
      'tasks:write',
      'tasks:write',
    ])
  })
})

describe('Registry.register', () => {
  it('rejects bad names', () => {
    for (const name of ['Tasks.list', 'tasks', 'tasks..x']) expect(() => new Registry().register(op({ name }))).toThrow()
  })
  it('rejects a long tool name', () => {
    const name = 'a.' + 'b'.repeat(63)
    expect(toolName(name)).toHaveLength(65)
    expect(() => new Registry().register(op({ name }))).toThrow()
  })
  it('rejects an empty summary', () => {
    expect(() => new Registry().register(op({ summary: '' }))).toThrow()
  })
  it('rejects duplicates', () => {
    expect(() => new Registry().register(op()).register(op({ path: '/y' }))).toThrow('duplicate operation probe.one')
    expect(() => new Registry().register(op()).register(op({ name: 'probe.two' }))).toThrow('duplicate route GET /x')
  })
  it('enforces the response schema rule', () => {
    expect(() => new Registry().register(op({ response: { status: 200 } }))).toThrow()
    expect(() => new Registry().register(op({ response: { status: 204, schema: z.object({}) } }))).toThrow()
    expect(() => new Registry().register(op({ response: { status: 204 } }))).not.toThrow()
  })
  it('enforces the binary output rules (CORE58)', () => {
    const stage = async (v: unknown) => v
    const bin = (over: Record<string, unknown> = {}) => op({ output: 'binary', response: { status: 200 }, objects: stage, ...over } as never)
    expect(() => new Registry().register(bin({ objects: undefined }))).toThrow()
    expect(() => new Registry().register(bin({ response: { status: 200, schema: z.object({}) } }))).toThrow()
    expect(() => new Registry().register(bin({ response: { status: 201 } }))).toThrow()
    expect(() => new Registry().register(op({ response: { status: 204 }, objects: stage } as never))).toThrow()
    expect(() => new Registry().register(bin())).not.toThrow()
    expect(() => new Registry().register(op({ response: { status: 200 } }))).toThrow()
  })
  it('requires path params to be declared', () => {
    expect(() =>
      new Registry().register(op({ path: '/x/{id}', request: { params: z.object({ other: z.string() }) } })),
    ).toThrow()
  })
  it('declaredScopes lists tenant scopes only', () => {
    const r = new Registry().registerResource(tasks).register({
      kind: 'account',
      name: 'account.whoami',
      summary: 'Who am I',
      method: 'get',
      path: '/account/whoami',
      response: { status: 200, schema: z.object({}) },
      prepare: () => defineOperation({ name: 'account.whoami', mutates: false, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => ({}) }) }),
    })
    expect(r.declaredScopes()).toEqual(['tasks:read', 'tasks:write'])
  })
  it('records resources', () => {
    expect(new Registry().registerResource(tasks).resources()).toEqual([tasks])
  })
})

describe('toolName', () => {
  it('replaces dots', () => expect(toolName('contacts.merge')).toBe('contacts_merge'))
})
