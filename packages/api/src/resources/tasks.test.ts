import { describe, expect, it } from 'vitest'
import { taskCompletion, tasks } from './tasks.js'

const now = new Date('2026-10-17T12:00:00Z')

describe('taskCompletion', () => {
  it('create done', () => {
    expect(taskCompletion({ status: 'done' }, null, now)).toEqual({ completed_at: now })
  })
  it('create open', () => {
    expect(taskCompletion({ status: 'open' }, null, now)).toEqual({ completed_at: null })
  })
  it('create status omitted', () => {
    expect('completed_at' in taskCompletion({}, null, now)).toBe(false)
  })
  it('open to done', () => {
    expect(taskCompletion({ status: 'done' }, { status: 'open' }, now)).toEqual({ completed_at: now })
  })
  it('done to done keeps', () => {
    expect('completed_at' in taskCompletion({ status: 'done' }, { status: 'done' }, now)).toBe(false)
  })
  it('done to open clears', () => {
    expect(taskCompletion({ status: 'open' }, { status: 'done' }, now)).toEqual({ completed_at: null })
  })
  it('no status in update', () => {
    expect('completed_at' in taskCompletion({ title: 'x' }, { status: 'done' }, now)).toBe(false)
  })
})

describe('tasks.create schema', () => {
  it.each([
    ['no title', {}],
    ['empty title', { title: '' }],
    ['unknown key', { title: 'a', completed_at: '2026-10-17T10:00:00Z' }],
    ['date-only due_at', { title: 'a', due_at: '2026-10-17' }],
  ])('rejects %s', (_n, input) => {
    expect(tasks.create!.safeParse(input).success).toBe(false)
  })
  it('accepts offset datetimes and null assignee', () => {
    expect(tasks.create!.safeParse({ title: 'a', due_at: '2026-10-17T10:00:00+02:00', assignee_id: null }).success).toBe(true)
  })
})
