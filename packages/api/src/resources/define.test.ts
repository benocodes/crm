import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { defineResource, parseListQuery, toRecord, type ResourceDefinition } from './define.js'
import { tasks } from './tasks.js'

const record = z.object({ id: z.string(), title: z.string() })
const base = (over: Partial<ResourceDefinition<any>> = {}): ResourceDefinition<any> => ({
  name: 'widgets',
  eventName: 'widget',
  table: 'tasks',
  record,
  create: z.strictObject({ title: z.string() }),
  update: z.strictObject({ title: z.string().optional() }),
  ...over,
})

async function code(fn: () => unknown): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await fn()
  } catch (e) {
    const a = e as ApiError
    return { status: a.status, code: a.code, message: a.message }
  }
  throw new Error('did not throw')
}

describe('defineResource', () => {
  it('reserves custom in each schema', () => {
    expect(() => defineResource(base({ create: z.strictObject({ title: z.string(), custom: z.any() }) }))).toThrow(
      '"custom" is a reserved field name (widgets)',
    )
    expect(() => defineResource(base({ update: z.strictObject({ custom: z.any().optional() }) }))).toThrow(
      '"custom" is a reserved field name (widgets)',
    )
    expect(() => defineResource(base({ record: z.object({ id: z.string(), custom: z.any() }) }))).toThrow(
      '"custom" is a reserved field name (widgets)',
    )
  })
  it('agentWritable must name fields', () => {
    expect(() => defineResource(base({ agentWritable: ['nope'] }))).toThrow(
      'agentWritable names unknown field "nope" (widgets)',
    )
  })
  it('name shape', () => {
    expect(() => defineResource(base({ name: 'Tasks' }))).toThrow()
  })
  it('accepts a valid definition', () => {
    expect(() => defineResource(base({ agentWritable: ['title'] }))).not.toThrow()
  })
})

describe('toRecord', () => {
  it('converts dates and strips unlisted columns', () => {
    const r = toRecord(tasks, {
      id: '0190b2c4-0000-7000-8000-000000000001',
      organization_id: '0190b2c4-0000-7000-8000-000000000002',
      title: 't',
      notes: null,
      status: 'open',
      due_at: null,
      completed_at: null,
      assignee_id: null,
      created_by: '0190b2c4-0000-7000-8000-000000000003',
      created_at: new Date('2026-10-17T10:00:00Z'),
      updated_at: new Date('2026-10-17T10:00:00Z'),
      deleted_at: null,
    }) as Record<string, unknown>
    expect(r.created_at).toBe('2026-10-17T10:00:00.000Z')
    expect(r.due_at).toBeNull()
    expect('deleted_at' in r).toBe(false)
  })
})

describe('parseListQuery', () => {
  it('defaults', () => {
    expect(parseListQuery(tasks, {})).toEqual({ after: null, limit: 50, filters: {} })
  })
  it.each([0, 201, 'abc', 1.5])('rejects limit %j', async (limit) => {
    expect(await code(() => parseListQuery(tasks, { limit }))).toMatchObject({ status: 400, code: 'validation_error' })
  })
  it.each([200, '200'])('accepts limit %j', (limit) => {
    expect(parseListQuery(tasks, { limit }).limit).toBe(200)
  })
  it('after must be a UUID', async () => {
    expect(await code(() => parseListQuery(tasks, { after: 'x' }))).toMatchObject({ status: 400, code: 'validation_error' })
  })
  it('unknown filter', async () => {
    expect(await code(() => parseListQuery(tasks, { filters: { title: 'a' } }))).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: 'unknown filter: title',
    })
  })
  it('bad filter value', async () => {
    expect(await code(() => parseListQuery(tasks, { filters: { status: 'closed' } }))).toMatchObject({
      status: 400,
      code: 'validation_error',
    })
  })
  it('normaliser sees parsed siblings', () => {
    const normalize = vi.fn((v: unknown, f: Record<string, unknown>) => (f.kind === 'email' ? String(v).toLowerCase() : v))
    const def = base({
      filters: { kind: { schema: z.enum(['email', 'phone']) }, value: { schema: z.string(), normalize } },
    })
    const q = parseListQuery(def, { filters: { kind: 'email', value: 'Ori@Example.com' } })
    expect(q.filters.value).toBe('ori@example.com')
    expect(normalize).toHaveBeenCalledWith('Ori@Example.com', { kind: 'email', value: 'Ori@Example.com' })
  })
  it('normaliser ApiError passes through', async () => {
    const def = base({
      filters: {
        value: {
          schema: z.string(),
          normalize: () => {
            throw new ApiError(400, 'invalid_identity', 'x')
          },
        },
      },
    })
    expect(await code(() => parseListQuery(def, { filters: { value: 'a' } }))).toMatchObject({ code: 'invalid_identity' })
  })
})
