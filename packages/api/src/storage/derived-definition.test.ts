import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resourceOperations } from '../registry.js'
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
  it('a derived name that is a filter key (filters or customFilters) is refused', () => {
    expect(() => define({ filters: { age: { schema: z.string() } }, derived: { age: derivedField } })).toThrow(/derived "age".*filter/)
    const join = { schema: z.string(), where: () => sql<boolean>`1` }
    expect(() => define({ customFilters: { age: join }, derived: { age: derivedField } })).toThrow(/derived "age".*filter/)
  })
  it('a custom filter of the derived field\'s own name is accepted when the field lists it (CORE130 D8: deals.status), a column filter never', () => {
    const join = { schema: z.string(), where: () => sql<boolean>`1` }
    expect(() => define({ customFilters: { age: join }, derived: { age: { ...derivedField, filters: ['age'] } } })).not.toThrow()
    expect(() => define({ filters: { age: { schema: z.string() } }, customFilters: { age: join }, derived: { age: { ...derivedField, filters: ['age'] } } })).toThrow(/"age"/)
  })
  it('a derived name that is not a field of the record is refused', () => {
    expect(() => define({ derived: { ghost: derivedField } })).toThrow(/derived "ghost".*not a field of the record/)
  })
  it('a derived field naming a filter that is not a custom filter of the definition is refused', () => {
    expect(() => define({ derived: { age: { ...derivedField, filters: ['nope'] } } })).toThrow(/derived "age".*nope/)
  })
})

describe('sorts are checked when the definition is built ([[CORE133]] D8)', () => {
  it('a sorts name that is a derived field is accepted', () => {
    expect(() => define({ derived: { age: derivedField }, sorts: ['age'] })).not.toThrow()
  })
  it('a sorts name that is not a derived field is refused: a column, a record field, or nothing at all', () => {
    expect(() => define({ derived: { age: derivedField }, sorts: ['title'] })).toThrow(/sorts "title".*not a derived field/)
    expect(() => define({ derived: { age: derivedField }, sorts: ['ghost'] })).toThrow(/sorts "ghost".*not a derived field/)
    expect(() => define({ sorts: ['age'] })).toThrow(/sorts "age".*not a derived field/)
  })
  it('a derived field of a kind with no order (boolean) is refused', () => {
    expect(() => define({ record: record({ flag: z.boolean().nullable().optional() }), derived: { flag: { kind: 'boolean', expression } }, sorts: ['flag'] })).toThrow(/sorts "flag".*boolean/)
  })
  it('a list that declares sorts cannot also have a filter named sort or order, or a repeated name', () => {
    expect(() => define({ derived: { age: derivedField }, sorts: ['age'], filters: { sort: { schema: z.string() } } })).toThrow(/"sort"/)
    const join = { schema: z.string(), where: () => sql<boolean>`1` }
    expect(() => define({ derived: { age: derivedField }, sorts: ['age'], customFilters: { order: join } })).toThrow(/"order"/)
    expect(() => define({ derived: { age: derivedField }, sorts: ['age', 'age'] })).toThrow(/sorts "age".*twice/)
  })
})

describe('the list operation of a synthetic sorted definition ([[CORE133]] D8, D9)', () => {
  const sorted = () => define({ derived: { age: derivedField }, sorts: ['age'] }) as never
  const listOf = (def: never) => resourceOperations(def).find((o) => o.name === 'tasks.list')!
  const keys = (def: never) => Object.keys((listOf(def).request!.query as z.ZodObject).shape)
  it('gets sort and order, an opaque string after and next_cursor, from the declaration alone', () => {
    const op = listOf(sorted())
    expect(keys(sorted())).toEqual(expect.arrayContaining(['after', 'limit', 'sort', 'order']))
    const shape = (op.request!.query as z.ZodObject).shape
    expect(z.toJSONSchema(shape.sort as z.ZodType)).toMatchObject({ enum: ['age'] })
    expect(JSON.stringify(z.toJSONSchema(shape.after as z.ZodType))).not.toContain('uuid')
    expect(JSON.stringify(z.toJSONSchema((op.response.schema as z.ZodObject).shape.next_cursor as z.ZodType))).not.toContain('uuid')
  })
  it('a definition without sorts has neither parameter and keeps the uuid cursor', () => {
    const plain = define({ derived: { age: derivedField } }) as never
    expect(keys(plain)).not.toContain('sort')
    expect(keys(plain)).not.toContain('order')
    expect(JSON.stringify(z.toJSONSchema((listOf(plain).request!.query as z.ZodObject).shape.after as z.ZodType))).toContain('uuid')
  })
})
