import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { CONVENTION_EXEMPTIONS, checkConventions, openLocalD1, readCatalogue, type LocalD1 } from '@vibase/storage-d1/test'
import { applySchemaFile } from './apply.js'
import { createTableStatements } from './ddl.js'
import type { ExtendDeclarations } from './extend.js'
import type { ObjectDeclaration } from './declaration.js'

// [[CORE683]] D10 (obligation 5): the DDL a custom object and an `extend` write follows the schema conventions ([[CORE679]]): named CHECKs
// (`<table>_<column>_uuid`, `_timestamp`, `_length`, `<table>_<column>` for the boolean), the parenthesised nullable forms and a unique
// `(organization_id, id)` index. The checker of `@vibase/storage-d1/test` runs over a D1 with one object holding a field of every kind and an
// `extend` on each of the four built-ins. Planner rule P2 (683.3): the fixture gives an `_id`, `_at` suffix only to reference and timestamp
// fields; a custom non-reference field named `x_id` is not refused (the checker never runs on an instance).
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['DDLCONV'])
  d1 = local.bindings.DDLCONV!
})
afterAll(() => local.dispose())

const PROJECTS: ObjectDeclaration = {
  fields: {
    name: { kind: 'text', required: true },
    notes: { kind: 'text' },
    code: { kind: 'text', unique: true },
    seats: { kind: 'integer', required: true, default: 1 },
    budget: { kind: 'integer' },
    active: { kind: 'boolean' },
    paid: { kind: 'boolean', required: true, default: false },
    stage: { kind: 'enum', values: ['new', 'won'], required: true, default: 'new' },
    due_at: { kind: 'timestamp' },
    started_at: { kind: 'timestamp', required: true },
    lead_id: { kind: 'reference', target: 'contacts' },
  },
}
const PHASES: ObjectDeclaration = {
  fields: { title: { kind: 'text' }, project_id: { kind: 'reference', target: 'projects__c', required: true } },
}
const shapes = (): NonNullable<ExtendDeclarations['contacts']> => ({
  note__c: { kind: 'text' },
  must__c: { kind: 'text', required: true, default: 'x' },
  tier__c: { kind: 'enum', values: ['a', 'b'], required: true },
  status__c: { kind: 'enum', values: ['new', 'won'], required: true, default: 'new' },
  score__c: { kind: 'integer', default: 5 },
  vip__c: { kind: 'boolean' },
  since__c: { kind: 'timestamp' },
  ref_code__c: { kind: 'text', unique: true },
  company_ref__c: { kind: 'reference', target: 'companies' },
  proj__c: { kind: 'reference', target: 'projects__c' },
})
const problems = async () =>
  checkConventions(await readCatalogue(d1), CONVENTION_EXEMPTIONS, 'crm').map(
    (p) => `${p.rule} ${p.object}: ${p.message}`,
  )

describe('custom-object and extension DDL meets the conventions', () => {
  it('a custom object with a field of every kind and an extend on each built-in gives the checker no problem', async () => {
    const r = await applySchemaFile(
      d1,
      { projects__c: PROJECTS, phases__c: PHASES },
      { contacts: shapes(), companies: shapes(), deals: shapes(), tasks: shapes() },
    )
    expect(r.refused).toEqual([])
    expect(r.created).toEqual(expect.arrayContaining(['projects__c', 'phases__c']))
    expect(await problems()).toEqual([])
  })

  it('the second apply plans nothing, so the new names and the unique pair index are idempotent', async () => {
    const again = await applySchemaFile(
      d1,
      { projects__c: PROJECTS, phases__c: PHASES },
      { contacts: shapes(), companies: shapes(), deals: shapes(), tasks: shapes() },
    )
    expect(again).toEqual({ created: [], added: [], indexed: [], archived: [], refused: [], statements: 0 })
  })

  it('names what it writes: the pair index is unique and each kind of CHECK carries its reserved name', async () => {
    const [table, ...indexes] = createTableStatements('things__c', PROJECTS)
    expect(indexes).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_things__c_organization_id_id" ON "things__c" ("organization_id", "id")',
    )
    for (const name of [
      'things__c_id_uuid',
      'things__c_created_at_timestamp',
      'things__c_updated_at_timestamp',
      'things__c_deleted_at_timestamp',
      'things__c_name_length',
      'things__c_notes_length',
      'things__c_due_at_timestamp',
      'things__c_started_at_timestamp',
      'things__c_active',
      'things__c_paid',
    ])
      expect(table, name).toContain(`CONSTRAINT "${name}" CHECK (`)
  })
})
