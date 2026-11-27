import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLUMN_KINDS } from '@vibase/storage'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { columnKinds, type BuiltInDeclaration, type BuiltInField } from './builtin.js'
import { companiesDeclaration } from './companies.js'
import { contactsDeclaration } from './contacts.js'
import { dealsDeclaration } from './deals.js'
import { driftProblems, type LiveTable } from './drift.js'
import { tasksDeclaration } from './tasks.js'

// [[CORE554]] P6 (D2, row 554.6): the four declarations equal the D1 migrations, in both directions, on an empty D1 with every migration applied.
const DECLARATIONS: BuiltInDeclaration[] = [
  contactsDeclaration,
  companiesDeclaration,
  dealsDeclaration,
  tasksDeclaration,
]

let local: LocalD1
let d1: D1Like
const live: Record<string, LiveTable> = {}
const all = async (q: string) => (await d1.prepare(q).all()).results as Record<string, any>[]

beforeAll(async () => {
  local = await openLocalD1(['DRIFT'])
  d1 = local.bindings.DRIFT!
  for (const { table } of DECLARATIONS) {
    const columns = (await all(`pragma table_info(${table})`)).map((c) => ({
      name: c.name as string,
      type: c.type as string,
      notnull: c.notnull === 1,
      pk: c.pk > 0,
    }))
    // A reference: a foreign key member paired with the target's `id` (the tenancy-composite keys carry `organization_id` beside it).
    const fkRows = await all(`pragma foreign_key_list(${table})`)
    const foreignKeys = fkRows
      .filter((r) => r.to === 'id')
      .map((r) => ({ column: r.from as string, table: r.table as string }))
    const uniqueColumns: string[] = []
    for (const ix of await all(`pragma index_list(${table})`)) {
      if (ix.unique !== 1 || ix.origin === 'pk') continue
      const cols = (await all(`pragma index_info(${ix.name})`))
        .map((c) => c.name as string)
        .filter((c) => c !== 'organization_id')
      if (cols.length === 1 && cols[0] !== 'id') uniqueColumns.push(cols[0]!)
    }
    live[table] = { columns, foreignKeys, uniqueColumns }
  }
})
afterAll(async () => {
  await local?.dispose()
})

const clone = (d: BuiltInDeclaration, edit: (fields: Record<string, BuiltInField>) => void): BuiltInDeclaration => {
  const fields: Record<string, BuiltInField> = Object.fromEntries(
    Object.entries(d.fields).map(([k, f]) => [k, { ...f }]),
  )
  edit(fields)
  return { ...d, fields }
}
const rules = (d: BuiltInDeclaration) => driftProblems(d, live[d.table]!).map((p) => `${p.rule}:${p.column}`)

describe('the declarations equal the migrations (both directions)', () => {
  it.each(DECLARATIONS.map((d) => [d.table, d] as const))('%s: no difference over every D1 migration', (_t, d) => {
    expect(driftProblems(d, live[d.table]!)).toEqual([])
  })
  it('the live tables are the real ones: columns exist and a unique index and foreign keys were read', () => {
    expect(live.companies!.uniqueColumns).toEqual(['domain'])
    expect(live.deals!.foreignKeys.map((k) => k.column).sort()).toEqual(
      ['created_by', 'organization_id', 'owner_id', 'pipeline_id', 'stage_id'].sort(),
    )
    expect(live.contacts!.columns.map((c) => c.name)).toContain('merged_into_id')
  })
})

describe('each kind of drift is named (a mutated declaration against the real table)', () => {
  it('a declared field with no column', () => {
    expect(rules(clone(tasksDeclaration, (f) => (f.priority = { kind: 'integer', nullable: true })))).toEqual([
      'declared_no_column:priority',
    ])
  })
  it('a column with no declaration', () => {
    expect(rules(clone(tasksDeclaration, (f) => delete f.description))).toEqual(['column_undeclared:description'])
  })
  it('a storage type mismatch', () => {
    expect(rules(clone(dealsDeclaration, (f) => (f.amount_minor = { ...f.amount_minor!, kind: 'text' })))).toEqual([
      'type_mismatch:amount_minor',
    ])
  })
  it('a nullability mismatch, either way', () => {
    expect(rules(clone(companiesDeclaration, (f) => (f.name = { ...f.name!, nullable: true })))).toEqual([
      'nullability_mismatch:name',
    ])
    expect(rules(clone(companiesDeclaration, (f) => (f.domain = { ...f.domain!, nullable: false })))).toEqual([
      'nullability_mismatch:domain',
    ])
  })
  it('a reference target mismatch, and a reference with no foreign key, and a foreign key no reference states', () => {
    expect(rules(clone(contactsDeclaration, (f) => (f.company_id = { ...f.company_id!, target: 'deals' })))).toEqual([
      'reference_mismatch:company_id',
    ])
    expect(
      rules(clone(dealsDeclaration, (f) => (f.currency = { kind: 'reference', target: 'principals', nullable: true }))),
    ).toEqual(['reference_no_fk:currency'])
    expect(
      rules(clone(tasksDeclaration, (f) => (f.assignee_id = { kind: 'text', format: 'uuid', nullable: true }))),
    ).toEqual(['fk_undeclared:assignee_id'])
  })
  it('a declared unique field with no unique index, and a unique index no field declares', () => {
    expect(rules(clone(tasksDeclaration, (f) => (f.title = { ...f.title!, unique: true })))).toEqual([
      'unique_no_index:title',
    ])
    expect(rules(clone(companiesDeclaration, (f) => (f.domain = { ...f.domain!, unique: false })))).toEqual([
      'unique_undeclared:domain',
    ])
  })
})

describe('P3 (row 554.4): the declaration derives the kinds COLUMN_KINDS holds', () => {
  it.each(DECLARATIONS.map((d) => [d.table, d] as const))('%s: the same columns, the same kinds', (_t, d) => {
    expect(columnKinds(d)).toEqual(COLUMN_KINDS[d.table as 'contacts'])
  })
  it('a changed kind or a missing column on either side is a difference', () => {
    const kinds = columnKinds(clone(dealsDeclaration, (f) => (f.owner_id = { ...f.owner_id!, kind: 'text' })))
    expect(kinds).not.toEqual(COLUMN_KINDS.deals)
    expect(columnKinds(clone(tasksDeclaration, (f) => delete f.due_at))).not.toEqual(COLUMN_KINDS.tasks)
    expect(columnKinds(clone(tasksDeclaration, (f) => (f.extra = { kind: 'text' })))).not.toEqual(COLUMN_KINDS.tasks)
  })
})
