import { describe, expect, it } from 'vitest'
import { parseObjectDeclaration, DeclarationError } from '../custom/declaration.js'
import { CATALOG } from '../schema/catalog.js'
import { companies } from '../resources/companies.js'
import { contacts } from '../resources/contacts.js'
import { deals } from '../resources/deals.js'
import { tasks } from '../resources/tasks.js'
import {
  catalogText,
  createSchema,
  filterNotes,
  filterOptions,
  recordSchema,
  updateRefusals,
  updateSchema,
  type BuiltInDeclaration,
} from './builtin.js'
import { companiesDeclaration } from './companies.js'
import { contactsDeclaration } from './contacts.js'
import { dealsDeclaration } from './deals.js'
import { tasksDeclaration } from './tasks.js'

// [[CORE554]] (D1, D15, P1, P2, P4): what each declaration derives, and what the file's validator still refuses. The wire as a whole is held by
// `resources/wire-snapshot.rest.integration.d1.test.ts`; the migrations by `drift.integration.d1.test.ts`.
const ALL: BuiltInDeclaration[] = [contactsDeclaration, companiesDeclaration, dealsDeclaration, tasksDeclaration]
const keys = (s: { shape: Record<string, unknown> }) => Object.keys(s.shape)

describe('P2: only the four extensible built-ins are declared', () => {
  it('the declared tables', () => {
    expect(ALL.map((d) => d.table)).toEqual(['contacts', 'companies', 'deals', 'tasks'])
  })
})

describe('what a declaration derives', () => {
  it('the record schema lists the fields in declaration order, without the columns that are no record field and with the derived ones', () => {
    expect(keys(recordSchema(contactsDeclaration))).toEqual([
      'id',
      'organization_id',
      'name',
      'company_id',
      'merged_into_id',
      'additional_props',
      'created_by',
      'created_at',
      'updated_at',
      'last_contacted_at',
      'last_interacted_at',
    ])
    expect(keys(recordSchema(dealsDeclaration))).toEqual([
      'id',
      'organization_id',
      'name',
      'pipeline_id',
      'stage_id',
      'status',
      'amount_minor',
      'currency',
      'expected_close_date',
      'owner_id',
      'closed_at',
      'additional_props',
      'created_by',
      'created_at',
      'updated_at',
    ])
    expect(keys(recordSchema(tasksDeclaration))).not.toContain('deleted_at')
  })
  it('create takes the normal fields and the bag, and a deal also its stage; update takes the normal fields only, all optional', () => {
    expect(keys(createSchema(contactsDeclaration))).toEqual(['name', 'company_id', 'additional_props'])
    expect(keys(createSchema(companiesDeclaration))).toEqual(['name', 'domain', 'additional_props'])
    expect(keys(createSchema(tasksDeclaration))).toEqual([
      'title',
      'description',
      'status',
      'due_at',
      'assignee_id',
      'additional_props',
    ])
    expect(keys(createSchema(dealsDeclaration))).toEqual([
      'name',
      'amount_minor',
      'currency',
      'expected_close_date',
      'owner_id',
      'additional_props',
      'stage_id',
    ])
    expect(keys(updateSchema(dealsDeclaration))).toEqual([
      'name',
      'amount_minor',
      'currency',
      'expected_close_date',
      'owner_id',
      'additional_props',
    ])
    expect(updateSchema(tasksDeclaration).safeParse({}).success).toBe(true)
    expect(createSchema(dealsDeclaration).safeParse({ name: 'x' }).success).toBe(false)
    expect(createSchema(companiesDeclaration).safeParse({}).success).toBe(false)
    expect(createSchema(tasksDeclaration).safeParse({ title: 'x' }).success).toBe(true)
  })
  it('a system-set field is in no input schema', () => {
    for (const [d, field] of [
      [contactsDeclaration, 'merged_into_id'],
      [dealsDeclaration, 'closed_at'],
      [dealsDeclaration, 'pipeline_id'],
      [tasksDeclaration, 'completed_at'],
    ] as const) {
      expect(keys(createSchema(d))).not.toContain(field)
      expect(keys(updateSchema(d))).not.toContain(field)
    }
  })
  it('the resource definitions carry what the declarations derive: filters in order, sorts, the update refusals, the notes', () => {
    expect(Object.keys(deals.filters ?? {})).toEqual(['pipeline_id', 'stage_id', 'owner_id', 'created_by', 'currency'])
    expect(Object.keys(contacts.filters ?? {})).toEqual(['company_id'])
    expect(Object.keys(companies.filters ?? {})).toEqual(['domain'])
    expect(Object.keys(tasks.filters ?? {})).toEqual(['status', 'assignee_id'])
    expect(Object.keys(filterOptions(dealsDeclaration))).toEqual(Object.keys(deals.filters ?? {}))
    expect(contacts.sorts).toEqual(['id', 'created_at', 'updated_at', ...contactsDeclaration.sorts])
    expect(tasks.sorts).toEqual(['id', 'created_at', 'updated_at', 'due_at', 'title'])
    expect(deals.createOnly).toEqual(updateRefusals(dealsDeclaration))
    expect(Object.keys(deals.createOnly ?? {})).toEqual(['pipeline_id', 'stage_id'])
    expect(Object.keys(filterNotes(dealsDeclaration))).toEqual(['amount_minor'])
  })
  it('a filterOrder that does not name the option-carrying fields is refused', () => {
    expect(() => filterOptions({ ...dealsDeclaration, filterOrder: ['stage_id'] })).toThrow(/filterOrder/)
  })
})

describe('P4 (row 554.5): the catalog text comes from the declaration', () => {
  it.each(ALL.map((d) => [d.table, d] as const))(
    '%s: CATALOG holds exactly what the declaration yields',
    (table, d) => {
      expect(CATALOG.tables[table]).toEqual(catalogText(d))
    },
  )
  it('the table text is the declaration text; a derived field has its own section', () => {
    expect(catalogText(dealsDeclaration)).toMatchObject({
      label: 'Deals',
      derived: { status: expect.stringContaining('filter with ?status=') },
    })
    expect(catalogText(contactsDeclaration).columns.company_id).toEqual({
      label: 'Primary company',
      description: "The contact's primary company; further affiliations are associations.",
    })
    expect(Object.keys(catalogText(tasksDeclaration).columns)).toEqual([
      'title',
      'description',
      'status',
      'due_at',
      'completed_at',
      'assignee_id',
    ])
  })
  it('an edited description shows in the catalog text', () => {
    const edited = {
      ...tasksDeclaration,
      fields: { ...tasksDeclaration.fields, title: { ...tasksDeclaration.fields.title, description: 'EDITED' } },
    }
    expect(catalogText(edited).columns.title).toBe('EDITED')
  })
})

describe('P1 (row 554.2): a built-in declaration is a code-only superset of the file field; the file cannot use the core-only properties', () => {
  // Every property a built-in field has beyond the file's FieldDeclaration, with a value of the right shape.
  const CORE_ONLY: Record<string, unknown> = {
    nullable: true,
    input: 'system',
    updateRefusal: 'x',
    inRecord: false,
    derived: true,
    format: 'uuid',
    trim: true,
    minLength: 1,
    maxLength: 5,
    min: 0,
    max: 5,
    pattern: { regex: 'a', message: 'm' },
    apiDescription: 'x',
    filter: {},
    filterNote: 'x',
  }
  it.each(Object.entries(CORE_ONLY))('the file refuses %s on a field', (prop, value) => {
    let refused: unknown
    try {
      parseObjectDeclaration('x__c', { fields: { a: { kind: 'text', [prop]: value } } })
    } catch (e) {
      refused = e
    }
    expect(refused).toBeInstanceOf(DeclarationError)
    expect((refused as DeclarationError).rule).toBe('unknown_property')
  })
  it('the properties the four declarations use are the file field properties plus exactly the core-only ones (D15: no order, view, icon or layout key)', () => {
    const FILE = ['kind', 'label', 'description', 'required', 'default', 'values', 'unique', 'target']
    const used = new Set(ALL.flatMap((d) => Object.values(d.fields).flatMap((f) => Object.keys(f))))
    for (const k of used) expect([...FILE, ...Object.keys(CORE_ONLY)], `unexpected field property "${k}"`).toContain(k)
    for (const k of ['order', 'position', 'view', 'icon', 'layout', 'group', 'section', 'column', 'hidden', 'visible'])
      expect(used.has(k)).toBe(false)
  })
})
