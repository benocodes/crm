import { describe, expect, it } from 'vitest'
import { StatementFailed } from '@vault/storage'
import { ApiError, mapStorageError } from './errors.js'

describe('errors', () => {
  it('body shape', () => {
    const e = new ApiError(404, 'not_found', 'task not found')
    expect(e.toBody()).toEqual({ error: { code: 'not_found', message: 'task not found' } })
    expect(e.status).toBe(404)
    expect(e).toBeInstanceOf(Error)
  })
  it('maps a storage foreign-key failure to invalid_reference without leaking the detail', () => {
    const mapped = mapStorageError(new StatementFailed('tasks.create', 'foreign_key', new Error('Key (assignee_id)=(abc) is not present')))
    expect(mapped).toBeInstanceOf(ApiError)
    const e = mapped as ApiError
    expect(e.status).toBe(400)
    expect(e.code).toBe('invalid_reference')
    expect(e.message).toBe('a referenced record does not exist')
    expect(e.message).not.toContain('abc')
  })
  it('passes a non-storage error through unchanged', () => {
    for (const x of [new Error('x'), new ApiError(409, 'c', 'm')]) expect(mapStorageError(x)).toBe(x)
  })
  it('passes a raw driver error object through: no raw 23503 reaches the app, so none is mapped', () => {
    const raw = { code: '23503' }
    expect(mapStorageError(raw)).toBe(raw)
  })
})
