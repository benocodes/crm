import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, type SortKind } from './sort-cursor.js'
import { parseListQuery } from './define.js'
import { withColumnSorts } from '../storage/sorts.js'
import { tasks } from './tasks.js'

const ID = '0190b2c4-0000-7000-8000-000000000001'
const envelope = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const def = () => withColumnSorts(tasks, ['title', 'due_at'])

describe('typed column cursors (CORE170 D5)', () => {
  it('round trips timestamp, text, uuid, safe integers and null of every kind', () => {
    for (const [kind, value] of [['timestamp', '2026-10-01T08:00:00.123Z'], ['text', 'Z/é😀'], ['uuid', ID], ['integer', Number.MAX_SAFE_INTEGER], ['integer', Number.MIN_SAFE_INTEGER]] as const) {
      expect(decodeCursor(encodeCursor('field', 'desc', value, ID), 'field', 'desc', kind as SortKind)).toEqual({ value, id: ID })
      expect(decodeCursor(encodeCursor('field', 'asc', null, ID), 'field', 'asc', kind as SortKind)).toEqual({ value: null, id: ID })
    }
  })
  it('validates uuid values independently of the row id', () => {
    expect(() => decodeCursor(envelope(['field', 'asc', 'not-a-uuid', ID]), 'field', 'asc', 'uuid' as SortKind)).toThrow(/value does not fit/)
    expect(decodeCursor(envelope(['field', 'asc', ID.toUpperCase(), ID.toUpperCase()]), 'field', 'asc', 'uuid' as SortKind)).toEqual({ value: ID, id: ID })
  })
  it('refuses non-ISO timestamps and invalid safe integers', () => {
    for (const value of ['yesterday', '2026-10-01', '2026-10-01T08:00:00+01:00']) expect(() => decodeCursor(envelope(['f', 'asc', value, ID]), 'f', 'asc', 'timestamp')).toThrow(/value does not fit/)
    for (const value of [1.2, Number.MAX_SAFE_INTEGER + 1, '1']) expect(() => decodeCursor(envelope(['f', 'asc', value, ID]), 'f', 'asc', 'integer')).toThrow(/value does not fit/)
  })
  it('refuses malformed envelopes, kind mismatches and a changed sort or order', () => {
    for (const raw of ['%', 'x', envelope({}), envelope(['f', 'asc', null]), envelope(['f', 'sideways', null, ID]), envelope(['f', 'asc', null, 'bad']), envelope(['f', 'asc', 5, ID])]) {
      expect(() => decodeCursor(raw, 'f', 'asc', 'text')).toThrow(/after is not a valid cursor/)
    }
    expect(() => decodeCursor(encodeCursor('other', 'asc', null, ID), 'f', 'asc', 'text')).toThrow(/belongs to/)
    expect(() => decodeCursor(encodeCursor('f', 'desc', null, ID), 'f', 'asc', 'text')).toThrow(/belongs to/)
  })
  it('binds query cursors, refuses plain UUID with sort and opaque without sort, and requires sort for order', () => {
    expect(parseListQuery(def(), { sort: 'id', after: encodeCursor('id', 'asc', ID, ID) }).sort).toMatchObject({ kind: 'uuid', position: { value: ID, id: ID } })
    expect(() => parseListQuery(def(), { sort: 'id', after: ID })).toThrow(/cursor/)
    expect(() => parseListQuery(def(), { after: encodeCursor('id', 'asc', ID, ID) })).toThrow(/sorted cursor needs/)
    expect(() => parseListQuery(def(), { order: 'desc' })).toThrow(/order needs sort/)
    expect(() => parseListQuery(def(), { sort: 'title', order: 'sideways' })).toThrow(/order must be/)
    expect(() => parseListQuery(def(), { sort: 'unknown' })).toThrow(/sort must be/)
  })
  it('sort=id carries its own non-null id as the value', () => {
    for (const value of [null, '0190b2c4-0000-7000-8000-000000000002']) {
      expect(() => decodeCursor(envelope(['id', 'asc', value, ID]), 'id', 'asc', 'uuid')).toThrow(/value does not fit/)
    }
  })
})
