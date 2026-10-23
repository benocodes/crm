import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import { prepareCreate, prepareListQuery, prepareUpdate } from '../storage/prepare.js'
import { tasks } from './tasks.js'

const user = { id: '0190b2c4-0000-7000-8000-00000000b001', kind: 'user' as const }
const agent = { id: '0190b2c4-0000-7000-8000-00000000c001', kind: 'agent' as const }

const refused = (fn: () => unknown): ApiError => {
  try {
    fn()
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected a refusal')
}

describe('task preparation is pure and keeps the old validation', () => {
  it.each([
    ['no title', {}, 'Invalid input: expected string, received undefined'],
    ['empty title', { title: '' }, 'Too small: expected string to have >=1 characters'],
    ['system-owned field', { title: 'x', completed_at: '2026-10-22T09:00:00Z' }, 'Unrecognized key: "completed_at"'],
    ['date-only due_at', { title: 'x', due_at: '2026-10-25' }, 'Invalid ISO datetime'],
    ['unknown status', { title: 'x', status: 'blocked' }, 'Invalid option: expected one of "open"|"done"'],
    ['assignee not a uuid', { title: 'x', assignee_id: 'not-a-uuid' }, 'Invalid UUID'],
  ])('create refuses %s', (_name, input, message) => {
    const err = refused(() => prepareCreate(tasks, user, input))
    expect(err).toMatchObject({ status: 400, code: 'validation_error', message })
  })

  it('create trims the title, normalises an offset due_at to UTC and lowercases ids', () => {
    const values = prepareCreate(tasks, user, {
      title: '  Padded title  ',
      due_at: '2026-10-25T10:00:00+02:00',
      assignee_id: '0190B2C4-0000-7000-8000-00000000B002',
    })
    expect(values).toEqual({
      title: 'Padded title',
      due_at: '2026-10-25T08:00:00.000Z',
      assignee_id: '0190b2c4-0000-7000-8000-00000000b002',
    })
  })

  it('create keeps explicit nulls and omits what was not sent', () => {
    expect(prepareCreate(tasks, agent, { title: 'x', notes: null })).toEqual({ title: 'x', notes: null })
  })

  it('update: an empty patch stays empty, a same-value patch stays a patch, null clears', () => {
    expect(prepareUpdate(tasks, user, {})).toEqual({})
    expect(prepareUpdate(tasks, user, { title: 'same' })).toEqual({ title: 'same' })
    expect(prepareUpdate(tasks, user, { notes: null, due_at: null, assignee_id: null })).toEqual({ notes: null, due_at: null, assignee_id: null })
  })

  it('update refuses unknown fields exactly like before', () => {
    expect(refused(() => prepareUpdate(tasks, user, { zz_unknown: 1 }))).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: 'Unrecognized key: "zz_unknown"',
    })
  })

  it('does no I/O: preparing is a plain synchronous function', () => {
    expect(prepareCreate(tasks, user, { title: 'x' })).not.toBeInstanceOf(Promise)
  })

  it.each([
    [{ limit: '0' }, 'limit: Too small: expected number to be >=1'],
    [{ limit: '201' }, 'limit: Too big: expected number to be <=200'],
    [{ after: 'nope' }, 'after must be a UUID'],
    [{ filters: { title: 'x' } }, 'unknown filter: title'],
    [{ filters: { status: 'blocked' } }, 'filter status: Invalid option: expected one of "open"|"done"'],
  ])('list query %j is refused with the old message', (query, message) => {
    expect(refused(() => prepareListQuery(tasks, query))).toMatchObject({ status: 400, code: 'validation_error', message })
  })

  it('list query defaults to 50, lowercases the cursor and filter ids', () => {
    expect(prepareListQuery(tasks, {})).toEqual({ after: null, limit: 50, filters: {} })
    expect(prepareListQuery(tasks, { after: '0190B2C4-0000-7000-8000-00000000B002', filters: { assignee_id: '0190B2C4-0000-7000-8000-00000000B002' } })).toEqual({
      after: '0190b2c4-0000-7000-8000-00000000b002',
      limit: 50,
      filters: { assignee_id: '0190b2c4-0000-7000-8000-00000000b002' },
    })
  })
})
