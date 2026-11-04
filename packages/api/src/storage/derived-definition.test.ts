import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePreparedResource } from './definition.js'

// [[CORE131]] D1: the load-time checks of a derived declaration, on a synthetic definition (not `contacts`).
const base = { surface: 'api', name: 'tasks', eventName: 'task', table: 'tasks' } as const
const expression = (_qc: unknown, parent: (c: string) => unknown) => sql`length(${parent('title')})`
const derivedField = { kind: 'integer', expression } as const
const record = (extra: z.ZodRawShape = {}) => z.object({ id: z.uuid(), title: z.string(), age: z.number().nullable().optional(), ...extra })
// The checks are runtime guards behind a typed API; the cases deliberately build declarations the types may also reject.
const define = (over: Record<string, unknown>) => definePreparedResource({ ...base, record: record(), ...over } as never)

describe('derived declarations are checked when the definition is built (D1)', () => {
  it('a well-formed derived field is accepted', () => {
    expect(() => define({ derived: { age: derivedField } })).not.toThrow()
  })
  it('a derived name that is a column of the table is refused', () => {
    expect(() => define({ record: record({ title: z.string() }), derived: { title: derivedField } })).toThrow(/derived "title".*column/)
  })
  it('a derived name that is an embed is refused', () => {
    const embed = { age: { table: 'message_attachments', key: 'message_id', columns: ['id'], orderBy: ['position'] } }
    expect(() => define({ table: 'messages', name: 'messages', record: z.object({ id: z.uuid(), age: z.array(z.unknown()) }), embed, derived: { age: derivedField } })).toThrow(/derived "age".*embed/)
  })
  it('a derived name that is a filter key (filters or joinFilters) is refused', () => {
    expect(() => define({ filters: { age: { schema: z.string() } }, derived: { age: derivedField } })).toThrow(/derived "age".*filter/)
    const join = { schema: z.string(), where: () => sql<boolean>`1` }
    expect(() => define({ joinFilters: { age: join }, derived: { age: derivedField } })).toThrow(/derived "age".*filter/)
  })
  it('a derived name that is not a field of the record is refused', () => {
    expect(() => define({ derived: { ghost: derivedField } })).toThrow(/derived "ghost".*not a field of the record/)
  })
  it('a derived field naming a filter that is not a join filter of the definition is refused', () => {
    expect(() => define({ derived: { age: { ...derivedField, filters: ['nope'] } } })).toThrow(/derived "age".*nope/)
  })
})
