import { describe, expect, it } from 'vitest'
import { uuidv7 } from './index.js'

describe('uuidv7', () => {
  it('produces canonical lowercase version-7 UUIDs carrying the given time', () => {
    const id = uuidv7(new Date('2026-10-22T09:00:00.000Z'))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(Date.parse('2026-10-22T09:00:00.000Z'))
  })
  it('is strictly increasing within a millisecond and under a clock that goes backwards', () => {
    const t = new Date('2026-10-22T09:00:00.000Z')
    const ids = Array.from({ length: 5000 }, () => uuidv7(t))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(uuidv7(new Date('2026-10-22T08:00:00.000Z')) > ids.at(-1)!).toBe(true)
  })
})
