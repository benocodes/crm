import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { parseListQuery, resourcePath } from './define.js'
import { tasks } from './tasks.js'

const base = (over: { filters?: Record<string, { schema: z.ZodType; normalize?: (v: unknown, f: Record<string, unknown>) => unknown }> } = {}) => ({ ...over })

async function code(fn: () => unknown): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await fn()
  } catch (e) {
    const a = e as ApiError
    return { status: a.status, code: a.code, message: a.message }
  }
  throw new Error('did not throw')
}

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

describe('definition helpers (CORE15)', () => {
  it('resourcePath', () => expect(resourcePath({ name: 'api_keys' })).toBe('/api-keys'))
})
