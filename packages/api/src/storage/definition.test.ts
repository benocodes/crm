import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { compileOperation, type Dialect } from '@vault/storage'
import { ApiError } from '../errors.js'
import { tasks } from '../resources/tasks.js'
import { definePreparedResource } from './definition.js'
import { getOperation, listOperation } from './crud.js'
import { prepareCreate, prepareUpdate } from './prepare.js'

// Pure checks of the prepared definition layer (CORE44 P10): the guards `definePreparedResource` enforces at load, the
// agent-field rule of the prepared write, and the column projection. They stand in for the legacy resource-definition function
// and `crud.integration.test.ts` cases (agentWritable, column grants) that went with the interactive path.

const record = z.object({ id: z.uuid(), organization_id: z.uuid(), title: z.string() })
const base = (over: Record<string, unknown> = {}) =>
  ({
    name: 'widgets',
    eventName: 'widget',
    table: 'tasks' as const,
    record,
    create: z.strictObject({ title: z.string(), notes: z.string().optional() }),
    update: z.strictObject({ title: z.string().optional(), notes: z.string().optional() }),
    ...over,
  }) as never

describe('definePreparedResource guards', () => {
  it('agentWritable must name fields of the create or update schema', () => {
    expect(() => definePreparedResource(base({ agentWritable: ['nope'] }))).toThrow('agentWritable names unknown field "nope" (widgets)')
    expect(() => definePreparedResource(base({ agentWritable: ['title'] }))).not.toThrow()
  })
  it('the name has a shape', () => {
    expect(() => definePreparedResource(base({ name: 'Tasks' }))).toThrow('invalid resource name "Tasks"')
  })
  it('a table with no physical schema is refused', () => {
    expect(() => definePreparedResource(base({ table: 'nope' }))).toThrow('has no physical schema')
  })
  it('delete needs a deleted_at column', () => {
    expect(() => definePreparedResource(base({ table: 'agents', operations: ['list', 'get', 'delete'] }))).toThrow('delete needs a deleted_at column on "agents"')
  })
})

describe('the agent-field rule of the prepared write', () => {
  const restricted = definePreparedResource(base({ agentWritable: ['title'] }))
  const agent = { id: 'a', kind: 'agent' as const }
  const user = { id: 'u', kind: 'user' as const }
  it('refuses an agent write outside agentWritable on create and update', () => {
    for (const fn of [() => prepareCreate(restricted, agent, { title: 'a', notes: 'n' }), () => prepareUpdate(restricted, agent, { notes: 'n' })]) {
      try {
        fn()
        throw new Error('did not throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError)
        expect(e).toMatchObject({ status: 400, code: 'field_not_writable', message: 'agents may not write: notes' })
      }
    }
  })
  it('lets an agent write the listed field', () => {
    expect(prepareCreate(restricted, agent, { title: 'a' })).toEqual({ title: 'a' })
  })
  it('ignores the rule for users', () => {
    expect(prepareCreate(restricted, user, { title: 'a', notes: 'n' })).toEqual({ title: 'a', notes: 'n' })
    expect(prepareUpdate(restricted, user, { notes: 'n' })).toEqual({ notes: 'n' })
  })
  it('a definition without write schemas refuses to prepare a write', () => {
    const readOnly = definePreparedResource(base({ name: 'ro', operations: ['list', 'get'], create: undefined, update: undefined }))
    expect(() => prepareCreate(readOnly, user, { title: 'x' })).toThrow('ro has no create schema')
    expect(() => prepareUpdate(readOnly, user, { title: 'x' })).toThrow('ro has no update schema')
  })
  it('without agentWritable an agent may write every field of the schemas', () => {
    expect(prepareCreate(tasks, agent, { title: 'a', notes: 'n' })).toMatchObject({ title: 'a', notes: 'n' })
  })
})

describe('the column projection: only the record columns are selected, so a narrower column grant still works', () => {
  const narrow = definePreparedResource({
    name: 'narrow_tasks',
    eventName: 'task',
    table: 'tasks',
    record: (tasks.record as unknown as z.ZodObject).omit({ notes: true }),
    create: tasks.create!.omit({ notes: true }),
    update: tasks.update!.omit({ notes: true }),
  } as never)
  const env = { actor: { id: 'u', kind: 'user' as const }, organizationId: '0190b2c4-0000-7000-8000-000000000001', scopes: undefined as never, now: new Date(0), newId: () => 'x', randomBytes: () => new Uint8Array(0) }
  const id = '0190b2c4-0000-7000-8000-000000000002'
  it.each(['postgres', 'd1'] as const satisfies readonly Dialect[])('list and get never mention a column outside the record (%s)', (dialect) => {
    const list = compileOperation(listOperation(narrow, env, {}), dialect)
    const get = compileOperation(getOperation(narrow, env, id), dialect)
    for (const c of [list, get]) {
      const text = JSON.stringify(c.reads)
      expect(text).not.toContain('notes')
      expect(text).not.toContain('deleted_at" as') // deleted_at is a condition, never a selected column
      expect(text).toContain('title')
    }
    // the unrestricted definition does select it
    expect(JSON.stringify(compileOperation(getOperation(tasks, env, id), dialect).reads)).toContain('notes')
  })
})
