import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { applySchemaFile, type ObjectDeclaration, type Refusal } from '../index.js'

// [[CORE542]] D11, D31, D32, P2, P3, P4, P5: apply over a real D1. Declarations are built behind functions, never at import, so a red run fails per test.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-24T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['T'])
  d1 = local.bindings.T!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})
afterAll(async () => {
  await local.dispose()
})
const all = async <T = Record<string, any>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
beforeEach(async () => {
  const tables = await all<{ name: string }>(
    `select name from sqlite_master where type = 'table' and name like '%\\_\\_c' escape '\\'`,
  )
  if (tables.length > 0) await d1.batch(tables.map((t) => d1.prepare(`drop table "${t.name}"`)))
})
/** The whole custom schema as text: tables, columns' definitions and indexes, in a fixed order. */
const schema = async () =>
  JSON.stringify(
    await all(
      `select type, name, tbl_name, sql from sqlite_master where tbl_name like '%\\_\\_c' escape '\\' order by type, name`,
    ),
  )
const columns = async (t: string) =>
  (await all<{ name: string }>(`select name from pragma_table_info(?)`, t)).map((c) => c.name)
const insert = (table: string, n: number, over: Record<string, unknown> = {}) => {
  const r = { id: id(n), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, ...over }
  const cols = Object.keys(r)
  return d1
    .prepare(
      `insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
    )
    .bind(...Object.values(r))
    .run()
}

const projects = (): Record<string, ObjectDeclaration> => ({
  projects__c: {
    label: 'Projects',
    fields: {
      name: { kind: 'text', required: true },
      budget: { kind: 'integer' },
      active: { kind: 'boolean', default: true },
      stage: { kind: 'enum', values: ['planned', 'active'], default: 'planned' },
      starts: { kind: 'timestamp' },
      code: { kind: 'text', unique: true },
      company: { kind: 'reference', target: 'companies' },
    },
  },
})
const with_ = (field: string, f: ObjectDeclaration['fields'][string], key = 'projects__c') => {
  const o = projects()
  o[key]!.fields[field] = f
  return o
}
const without = (field: string) => {
  const o = projects()
  delete o.projects__c!.fields[field]
  return o
}
const rules = (r: Refusal[]) => r.map((x) => `${x.rule}:${x.object}${x.field ? `.${x.field}` : ''}`)

describe('apply from empty, and idempotence', () => {
  it('creates every table and its indexes, cross-references included', async () => {
    const objects: Record<string, ObjectDeclaration> = {
      ...projects(),
      clients__c: { fields: { name: { kind: 'text' }, project: { kind: 'reference', target: 'projects__c' } } },
    }
    objects.projects__c!.fields.client = { kind: 'reference', target: 'clients__c' }
    const r = await applySchemaFile(d1, objects)
    expect(r.refused).toEqual([])
    expect(r.created.sort()).toEqual(['clients__c', 'projects__c'])
    const idx = await all<{ name: string; unique: number; partial: number }>(
      `select name, "unique", partial from pragma_index_list('projects__c') where origin = 'c' order by name`,
    )
    const by = Object.fromEntries(idx.map((i) => [i.name, i]))
    expect(by.idx_projects__c_code_unique).toMatchObject({ unique: 1, partial: 1 })
    expect(by.idx_projects__c_company_id).toMatchObject({ unique: 0, partial: 0 })
    expect(by.idx_projects__c_client_id).toBeDefined()
    expect(by.idx_projects__c_organization_id_id).toBeDefined()
    expect(
      (await all(`select name from pragma_index_list('clients__c') where name = 'idx_clients__c_project_id'`)).length,
    ).toBe(1)
  })
  it('a second run plans and executes nothing and leaves the schema byte-equal', async () => {
    await applySchemaFile(d1, projects())
    const before = await schema()
    const again = await applySchemaFile(d1, projects())
    expect(again).toEqual({ created: [], added: [], indexed: [], archived: [], refused: [], statements: 0 })
    expect(await schema()).toBe(before)
  })
  it('a file with no objects on a database with no custom table plans nothing', async () => {
    expect(await applySchemaFile(d1, {})).toEqual({
      created: [],
      added: [],
      indexed: [],
      archived: [],
      refused: [],
      statements: 0,
    })
    expect(await schema()).toBe('[]')
  })
})

describe('allowed changes over data', () => {
  beforeEach(async () => {
    await applySchemaFile(d1, projects())
    await insert('projects__c', 1, { name: 'A', code: 'a1' })
    await insert('projects__c', 2, { name: 'B', code: 'b1' })
  })
  it('a new nullable field and a new required field with a default (existing rows take it)', async () => {
    const o = with_('note', { kind: 'text' })
    o.projects__c!.fields.tier = { kind: 'text', required: true, default: 'std' }
    const r = await applySchemaFile(d1, o)
    expect(r.refused).toEqual([])
    expect(r.added.map((a) => a.field).sort()).toEqual(['note', 'tier'])
    const rows = await all(`select note, tier from projects__c order by id`)
    expect(rows).toEqual([
      { note: null, tier: 'std' },
      { note: null, tier: 'std' },
    ])
  })
  it('a new reference field gets its index', async () => {
    const r = await applySchemaFile(d1, with_('deal', { kind: 'reference', target: 'deals' }))
    expect(r.refused).toEqual([])
    expect(r.indexed.map((i) => i.index)).toContain('idx_projects__c_deal_id')
    expect(
      (await all(`select name from pragma_index_list('projects__c') where name = 'idx_projects__c_deal_id'`)).length,
    ).toBe(1)
  })
  it('unique added to an existing field over clean data', async () => {
    const r = await applySchemaFile(d1, with_('budget', { kind: 'integer', unique: true }))
    expect(r.refused).toEqual([])
    expect(r.indexed.map((i) => i.index)).toEqual(['idx_projects__c_budget_unique'])
  })
  it('additions to an existing table, applied, leave nothing to plan on a second run; a column added later keeps its kind', async () => {
    const o = projects()
    const f = o.projects__c!.fields
    f.note = { kind: 'text' }
    f.tier = { kind: 'text', required: true, default: 'std' }
    f.deal = { kind: 'reference', target: 'deals' }
    f.budget = { kind: 'integer', unique: true }
    f.when = { kind: 'timestamp' }
    f.flag = { kind: 'boolean', default: false }
    f.size = { kind: 'enum', values: ['s', 'm'] }
    const first = await applySchemaFile(d1, o)
    expect(first.refused).toEqual([])
    const before = await schema()
    expect(await applySchemaFile(d1, o)).toEqual({
      created: [],
      added: [],
      indexed: [],
      archived: [],
      refused: [],
      statements: 0,
    })
    expect(await schema()).toBe(before)
    // each added column still reads back as the kind it was added as
    for (const [name, to] of [
      ['note', { kind: 'enum', values: ['a'] }],
      ['when', { kind: 'text' }],
      ['size', { kind: 'text' }],
      ['flag', { kind: 'integer', default: 0 }],
    ] as const) {
      const changed = projects()
      Object.assign(changed.projects__c!.fields, o.projects__c!.fields, { [name]: to })
      expect(rules((await applySchemaFile(d1, changed)).refused), name).toContain(`kind_changed:projects__c.${name}`)
    }
  })
  it('a new sibling object', async () => {
    const o = { ...projects(), notes__c: { fields: { body: { kind: 'text' as const } } } }
    const r = await applySchemaFile(d1, o)
    expect(r.created).toEqual(['notes__c'])
    expect((await all(`select count(*) n from projects__c`))[0]!.n).toBe(2)
  })
  it('label, description and enum-value changes plan no statement', async () => {
    const o = projects()
    o.projects__c!.label = 'Jobs'
    o.projects__c!.description = 'Work'
    o.projects__c!.fields.name!.label = 'Title'
    o.projects__c!.fields.stage = { kind: 'enum', values: ['planned', 'active', 'done'], default: 'planned' }
    const before = await schema()
    const r = await applySchemaFile(d1, o)
    expect(r).toEqual({ created: [], added: [], indexed: [], archived: [], refused: [], statements: 0 })
    expect(await schema()).toBe(before)
  })
  it('a removed field and a removed object are reported archived, and their column, table and values stay', async () => {
    await applySchemaFile(d1, { ...projects(), notes__c: { fields: { body: { kind: 'text' } } } })
    await insert('notes__c', 3, { body: 'keep me' })
    const r = await applySchemaFile(d1, without('budget'))
    expect(r.refused).toEqual([])
    expect(r.archived).toEqual(
      expect.arrayContaining([{ object: 'projects__c', field: 'budget' }, { object: 'notes__c' }]),
    )
    expect(await columns('projects__c')).toContain('budget')
    expect((await all(`select name from projects__c order by id`)).map((x) => x.name)).toEqual(['A', 'B'])
    expect(await all(`select body from notes__c`)).toEqual([{ body: 'keep me' }])
    // and a second run reports the same archive but plans no statement
    expect((await applySchemaFile(d1, without('budget'))).statements).toBe(0)
  })
})

describe('refusals', () => {
  type Case = [
    name: string,
    rule: string,
    field: string,
    base: () => Record<string, ObjectDeclaration>,
    next: () => Record<string, ObjectDeclaration>,
  ]
  const o = (fields: ObjectDeclaration['fields']): Record<string, ObjectDeclaration> => ({ projects__c: { fields } })
  const pair = (
    from: ObjectDeclaration['fields'][string],
    to: ObjectDeclaration['fields'][string],
  ): [() => Record<string, ObjectDeclaration>, () => Record<string, ObjectDeclaration>] => [
    () => o({ f: from }),
    () => o({ f: to }),
  ]
  const E = { kind: 'enum' as const, values: ['a', 'b'] }
  const T = { kind: 'text' as const }
  const TS = { kind: 'timestamp' as const }
  const I = { kind: 'integer' as const }
  const B = { kind: 'boolean' as const }
  const R = { kind: 'reference' as const, target: 'companies' }
  const cases: Case[] = [
    ['text to enum', 'kind_changed', 'f', ...pair(T, E)],
    ['text to timestamp', 'kind_changed', 'f', ...pair(T, TS)],
    ['enum to text', 'kind_changed', 'f', ...pair(E, T)],
    ['enum to timestamp', 'kind_changed', 'f', ...pair(E, TS)],
    ['timestamp to text', 'kind_changed', 'f', ...pair(TS, T)],
    ['timestamp to enum', 'kind_changed', 'f', ...pair(TS, E)],
    ['integer to boolean', 'kind_changed', 'f', ...pair(I, B)],
    ['boolean to integer', 'kind_changed', 'f', ...pair(B, I)],
    ['text to integer (across types)', 'kind_changed', 'f', ...pair(T, I)],
    ['text to reference', 'kind_changed', 'f', ...pair(T, R)],
    ['reference to text', 'kind_changed', 'f', ...pair(R, T)],
    ['reference target changed', 'target_changed', 'f', ...pair(R, { kind: 'reference', target: 'deals' })],
    ['required to optional', 'required_to_optional', 'f', ...pair({ kind: 'text', required: true }, T)],
    ['optional to required', 'optional_to_required', 'f', ...pair(T, { kind: 'text', required: true })],
    [
      'optional to required with a default',
      'optional_to_required',
      'f',
      ...pair({ kind: 'text', default: 'x' }, { kind: 'text', required: true, default: 'x' }),
    ],
    [
      'default changed',
      'default_changed',
      'f',
      ...pair({ kind: 'text', default: 'a' }, { kind: 'text', default: 'b' }),
    ],
    ['default added', 'default_changed', 'f', ...pair(T, { kind: 'text', default: 'a' })],
    ['default removed', 'default_changed', 'f', ...pair({ kind: 'integer', default: 1 }, I)],
    ['unique removed', 'unique_removed', 'f', ...pair({ kind: 'text', unique: true }, T)],
    [
      'new required field with no default',
      'required_without_default',
      'g',
      () => o({ f: T }),
      () => o({ f: T, g: { kind: 'text', required: true } }),
    ],
  ]
  it.each(cases)(
    '%s is refused as %s naming the object and field, with no statement run',
    async (_n, rule, field, base, next) => {
      await applySchemaFile(d1, base())
      const before = await schema()
      // an unrelated allowed change rides along: it must not run either (P2)
      const wanted = next()
      wanted.projects__c!.fields.extra_ok = { kind: 'text' }
      wanted.other__c = { fields: { x: { kind: 'text' } } }
      const r = await applySchemaFile(d1, wanted)
      expect(rules(r.refused)).toEqual([`${rule}:projects__c.${field}`])
      expect(r.statements).toBe(0)
      expect(r.created).toEqual([])
      expect(await schema()).toBe(before)
    },
  )
  it('the kind_changed message names the live kind with the right article ([[CORE561]] 561.20)', async () => {
    await applySchemaFile(d1, o({ e: E, t: T }))
    const r = await applySchemaFile(d1, o({ e: T, t: E }))
    expect(r.refused.filter((x) => x.rule === 'kind_changed').map((x) => x.message)).toEqual([
      'projects__c.e is an enum field and the file declares text: a kind never changes',
      'projects__c.t is a text field and the file declares enum: a kind never changes',
    ])
  })
  it('the column cap counts archived columns and names the table', async () => {
    const many = (names: string[]) => o(Object.fromEntries(names.map((n) => [n, { kind: 'text' as const }])))
    const first = Array.from({ length: 89 }, (_, i) => `f${i}`)
    expect((await applySchemaFile(d1, many(first))).refused).toEqual([])
    const before = await schema()
    const next = many([...first.slice(0, 10), 'n1', 'n2', 'n3', 'n4', 'n5'])
    const r = await applySchemaFile(d1, next)
    expect(rules(r.refused)).toEqual(['column_cap:projects__c'])
    expect(r.refused[0]!.message).toContain('projects__c')
    expect(await schema()).toBe(before)
    // 100 columns exactly is allowed
    expect((await applySchemaFile(d1, many([...first.slice(0, 10), 'n1', 'n2', 'n3', 'n4']))).refused).toEqual([])
  })
})

describe('violating data', () => {
  beforeEach(async () => {
    await applySchemaFile(d1, o2())
  })
  const o2 = (): Record<string, ObjectDeclaration> => ({ projects__c: { fields: { name: { kind: 'text' } } } })
  const withUnique = (): Record<string, ObjectDeclaration> => ({
    projects__c: { fields: { name: { kind: 'text', unique: true } } },
  })
  it('unique added over duplicate live values is refused naming the value and the ids, no statement run', async () => {
    await insert('projects__c', 1, { name: 'dup' })
    await insert('projects__c', 2, { name: 'dup' })
    await insert('projects__c', 3, { name: 'fine' })
    const wanted = withUnique()
    wanted.projects__c!.fields.extra_ok = { kind: 'text' }
    const before = await schema()
    const r = await applySchemaFile(d1, wanted)
    expect(rules(r.refused)).toEqual(['unique_violation:projects__c.name'])
    expect(r.refused[0]!.value).toBe('dup')
    expect(r.refused[0]!.ids).toEqual([id(1), id(2)])
    expect(r.refused[0]!.message).toContain('dup')
    expect(r.statements).toBe(0)
    expect(await schema()).toBe(before)
  })
  it('duplicates on a soft-deleted row, or as NULL, do not refuse', async () => {
    await insert('projects__c', 1, { name: 'dup' })
    await insert('projects__c', 2, { name: 'dup', deleted_at: AT })
    await insert('projects__c', 3, { name: null })
    await insert('projects__c', 4, { name: null })
    const r = await applySchemaFile(d1, withUnique())
    expect(r.refused).toEqual([])
    expect(r.indexed.map((i) => i.index)).toEqual(['idx_projects__c_name_unique'])
  })
  it('a new required + unique field with a default over two live rows is refused; over one row accepted', async () => {
    const wanted = (): Record<string, ObjectDeclaration> => ({
      projects__c: {
        fields: { name: { kind: 'text' }, slug: { kind: 'text', required: true, unique: true, default: 'x' } },
      },
    })
    await insert('projects__c', 1, { name: 'a' })
    await insert('projects__c', 2, { name: 'b' })
    await insert('projects__c', 3, { name: 'c', deleted_at: AT })
    const before = await schema()
    const r = await applySchemaFile(d1, wanted())
    expect(rules(r.refused)).toEqual(['unique_violation:projects__c.slug'])
    expect(r.refused[0]!.value).toBe('x')
    expect(r.refused[0]!.ids).toEqual([id(1), id(2)])
    expect(await schema()).toBe(before)
    await d1.prepare(`delete from projects__c where id = ?`).bind(id(2)).run()
    expect((await applySchemaFile(d1, wanted())).refused).toEqual([])
    expect(await all(`select slug from projects__c where id = ?`, id(1))).toEqual([{ slug: 'x' }])
  })
})
