import { describe, expect, it } from 'vitest'
import { ApiError, mapDatabaseError } from './errors.js'

describe('errors', () => {
  it('body shape', () => {
    const e = new ApiError(404, 'not_found', 'task not found')
    expect(e.toBody()).toEqual({ error: { code: 'not_found', message: 'task not found' } })
    expect(e.status).toBe(404)
    expect(e).toBeInstanceOf(Error)
  })
  it('maps 23503', () => {
    const mapped = mapDatabaseError({ code: '23503', detail: 'Key (assignee_id)=(abc) is not present' })
    expect(mapped).toBeInstanceOf(ApiError)
    const e = mapped as ApiError
    expect(e.status).toBe(400)
    expect(e.code).toBe('invalid_reference')
    expect(e.message).toBe('a referenced record does not exist')
    expect(e.message).not.toContain('abc')
  })
  it('passes others through', () => {
    for (const x of [{ code: '23505' }, new Error('x'), new ApiError(409, 'c', 'm')]) {
      expect(mapDatabaseError(x)).toBe(x)
    }
  })
})
