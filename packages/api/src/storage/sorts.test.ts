import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { z } from 'zod'
import { COLUMN_KINDS } from '@vault/storage'
import { tasks } from '../resources/tasks.js'
import { contacts } from '../resources/contacts.js'
import { resolveSorts, withColumnSorts, type SortMetadata } from './sorts.js'

/** The definition before its rollout adoption (CORE175 wrapped every production list): the unsorted base these foundation tests opt in. */
const bare = <T extends { sorts?: unknown; sortKinds?: unknown }>(def: T): Omit<T, 'sorts' | 'sortKinds'> => {
  const { sorts: _sorts, sortKinds: _kinds, ...rest } = def
  return rest
}

const metadata: SortMetadata = {
  name: 'future_table',
  columns: { id: 'uuid', created_at: 'timestamp', updated_at: 'timestamp', launch_count: 'integer', secret: 'text', flag: 'boolean', payload: 'json', labels: 'string_array' },
  record: { shape: { id: {}, created_at: {}, updated_at: {}, launch_count: {}, flag: {}, payload: {}, labels: {}, age: {}, ghost: {} } },
  derived: { age: { kind: 'integer' } },
  sorts: ['launch_count', 'age'],
}

describe('column sort metadata (CORE170 D3/D11)', () => {
  it('resolves a newly supplied typed column and a derived field after conventions without resource code', () => {
    expect(resolveSorts(metadata)).toEqual({ id: 'uuid', created_at: 'timestamp', updated_at: 'timestamp', launch_count: 'integer', age: 'integer' })
    expect(resolveSorts({ ...metadata, columns: { id: 'uuid' }, sorts: [] })).toEqual({ id: 'uuid' })
  })
  it('opts in a copy of a real definition, reading kinds from COLUMN_KINDS', () => {
    const sorted = withColumnSorts(bare(tasks), ['title', 'due_at'])
    expect(sorted.sorts).toEqual(['id', 'created_at', 'updated_at', 'title', 'due_at'])
    expect(sorted).toHaveProperty('sortKinds.title', COLUMN_KINDS.tasks.title)
    expect('sorts' in bare(tasks)).toBe(false)
    expect(withColumnSorts(bare(contacts), ['last_contacted_at', 'last_interacted_at']).sorts).toEqual(['id', 'created_at', 'updated_at', 'last_contacted_at', 'last_interacted_at'])
  })
  for (const [title, sorts, error] of [
    ['unknown column', ['missing'], /missing.*unknown/],
    ['record-only field', ['ghost'], /ghost.*unknown/],
    ['non-record column', ['secret'], /secret.*record/],
    ['boolean', ['flag'], /flag.*boolean/],
    ['json', ['payload'], /payload.*json/],
    ['array', ['labels'], /labels.*string_array/],
    ['duplicate', ['launch_count', 'launch_count'], /launch_count.*twice/],
    ['convention repeat', ['created_at'], /created_at.*convention/],
  ] as const) {
    it(`refuses ${title} at load`, () => expect(() => resolveSorts({ ...metadata, sorts })).toThrow(error))
  }
  it('checks convention kinds and projection, derived kinds and record presence too', () => {
    expect(() => resolveSorts({ ...metadata, columns: { ...metadata.columns, id: 'json' } })).toThrow(/id.*json/)
    expect(() => resolveSorts({ ...metadata, record: { shape: { id: {} } } })).toThrow(/created_at.*record/)
    expect(() => resolveSorts({ ...metadata, derived: { age: { kind: 'boolean' } } })).toThrow(/age.*boolean/)
    expect(() => resolveSorts({ ...metadata, record: { shape: { ...metadata.record.shape, age: undefined } }, derived: { other: { kind: 'text' } }, sorts: ['other'] })).toThrow(/other.*record/)
  })
  it('refuses sort/order filter collisions on the opt-in capability', () => {
    expect(() => withColumnSorts({ ...bare(tasks), filters: { sort: { schema: z.string() } } } as never)).toThrow(/sort.*filter/)
    expect(() => withColumnSorts({ ...bare(tasks), customFilters: { order: { schema: z.string(), where: () => sql<boolean>`1` } } })).toThrow(/order.*filter/)
  })
})
