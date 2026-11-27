import { afterEach, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { applySchemaFile, planApply, readLiveSchema } from './apply.js'
import { parseExtend, type ExtendDeclarations } from './extend.js'
import { DeclarationError, type ObjectDeclaration } from './declaration.js'

// [[CORE555]] P3 to P6: extension fields applied to the four built-in tables over a real, migrated D1. A fresh database per test (a column with a foreign key cannot be dropped to reset one).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-24T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const TABLES = ['contacts', 'companies', 'deals', 'tasks']

let local: LocalD1 | undefined
let d1: D1Like
const fresh = async () => {
  local = await openLocalD1(['T'])
  d1 = local.bindings.T!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
}
afterEach(async () => {
  await local?.dispose()
  local = undefined
})
const all = async <T = Record<string, any>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const tableSql = async (t: string) =>
  (await all<{ sql: string }>(`select sql from sqlite_master where name = ?`, t))[0]!.sql
const info = async (t: string) =>
  Object.fromEntries((await all(`select * from pragma_table_info(?)`, t)).map((c) => [c.name, c]))
const indexSql = async (name: string) =>
  (await all<{ sql: string }>(`select sql from sqlite_master where type = 'index' and name = ?`, name))[0]?.sql
/** The four tables' definitions and indexes as one text: a refused run must leave it as it was. */
const snapshot = async () =>
  JSON.stringify(
    await all(
      `select name, sql from sqlite_master where tbl_name in ('contacts','companies','deals','tasks') order by name`,
    ),
  )
const rowOf = (table: string, n: number, over: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = {
    id: id(n),
    organization_id: ORG,
    created_by: USER,
    created_at: AT,
    updated_at: AT,
  }
  if (table === 'companies') base.name = `c${n}`
  if (table === 'tasks') base.title = `t${n}`
  const r = { ...base, ...over }
  const cols = Object.keys(r)
  return d1
    .prepare(
      `insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
    )
    .bind(...Object.values(r))
    .run()
}
const rules = (r: { refused: { rule: string; object: string; field?: string }[] }) =>
  r.refused.map((x) => `${x.rule}:${x.object}.${x.field ?? ''}`)

const PROJECTS: ObjectDeclaration = { fields: { name: { kind: 'text' } } }
/** Every shape of P3 on one table. */
const shapes = (): ExtendDeclarations['contacts'] => ({
  note__c: { kind: 'text' },
  tier__c: { kind: 'enum', values: ['a', 'b'], required: true },
  status__c: { kind: 'enum', values: ['new', 'won'], required: true, default: 'new' },
  score__c: { kind: 'integer', default: 5 },
  vip__c: { kind: 'boolean' },
  since__c: { kind: 'timestamp' },
  ref_code__c: { kind: 'text', unique: true },
  company_ref__c: { kind: 'reference', target: 'companies' },
  proj__c: { kind: 'reference', target: 'projects__c' },
})
const everywhere = (): ExtendDeclarations => ({
  contacts: shapes(),
  companies: shapes(),
  deals: shapes(),
  tasks: shapes(),
})
const one = (fields: NonNullable<ExtendDeclarations['contacts']>): ExtendDeclarations => ({ contacts: fields })

describe("D8's shapes on the live table (P3)", () => {
  it('each shape reads only its own column, on all four tables, and a second apply plans nothing', async () => {
    await fresh()
    const r = await applySchemaFile(d1, { projects__c: PROJECTS }, everywhere())
    expect(r.refused).toEqual([])
    for (const t of TABLES) {
      const cols = await info(t)
      const sql = await tableSql(t)
      expect(cols.note__c, t).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      // required with no default: nullable (D8, enforced by the API, CORE559)
      expect(cols.tier__c, t).toMatchObject({ notnull: 0, dflt_value: null })
      expect(cols.status__c, t).toMatchObject({ notnull: 1, dflt_value: "'new'" })
      expect(cols.score__c, t).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: '5' })
      expect(cols.vip__c.type).toBe('INTEGER')
      // CORE683 D10: each CHECK is named `<table>_<column>_<kind>` and the nullable form is parenthesised.
      expect(sql).toContain(
        `"vip__c" INTEGER CONSTRAINT "${t}_vip__c" CHECK ("vip__c" IS NULL OR ("vip__c" IN (0, 1)))`,
      )
      expect(sql).toContain(
        `"note__c" TEXT CONSTRAINT "${t}_note__c_length" CHECK ("note__c" IS NULL OR (length("note__c") <= 10000))`,
      )
      expect(sql).toContain(
        `"since__c" TEXT CONSTRAINT "${t}_since__c_timestamp" CHECK ("since__c" IS NULL OR (coalesce(strftime(`,
      )
      expect(sql).not.toMatch(/"tier__c" TEXT[^,]*CHECK/)
      const fks = await all(`select "from", "table", "to" from pragma_foreign_key_list(?)`, t)
      expect(fks).toEqual(
        expect.arrayContaining([
          { from: 'company_ref__c', table: 'companies', to: 'id' },
          { from: 'proj__c', table: 'projects__c', to: 'id' },
        ]),
      )
      expect(await indexSql(`idx_${t}_ref_code__c_unique`), t).toMatch(
        new RegExp(
          `^CREATE UNIQUE INDEX "idx_${t}_ref_code__c_unique" ON "${t}" \\("organization_id", "ref_code__c"\\) WHERE "deleted_at" IS NULL AND "ref_code__c" IS NOT NULL$`,
        ),
      )
      expect(await indexSql(`idx_${t}_company_ref__c_id`), t).toMatch(/\("organization_id", "company_ref__c", "id"\)/)
      expect(await indexSql(`idx_${t}_proj__c_id`), t).toMatch(/\("organization_id", "proj__c", "id"\)/)
    }
    const again = await applySchemaFile(d1, { projects__c: PROJECTS }, everywhere())
    expect(again).toEqual({ created: [], added: [], indexed: [], archived: [], refused: [], statements: 0 })
    expect(planApply({ projects__c: PROJECTS }, await readLiveSchema(d1), everywhere()).statements).toEqual([])
  })
  it('a reference to a custom object in the same file applies in one run, the table first', async () => {
    await fresh()
    const plan = planApply(
      { projects__c: PROJECTS },
      await readLiveSchema(d1),
      one({ proj__c: { kind: 'reference', target: 'projects__c' } }),
    )
    expect(plan.statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "projects__c"/)
    expect(plan.statements.findIndex((s) => s.includes('ADD COLUMN "proj__c"'))).toBeGreaterThan(0)
    expect(
      (
        await applySchemaFile(
          d1,
          { projects__c: PROJECTS },
          one({ proj__c: { kind: 'reference', target: 'projects__c' } }),
        )
      ).refused,
    ).toEqual([])
  })
  it('a required field with no default is added to a table that has rows (D8)', async () => {
    await fresh()
    await rowOf('contacts', 1)
    const r = await applySchemaFile(d1, {}, one({ tier__c: { kind: 'text', required: true } }))
    expect(r.refused).toEqual([])
    expect((await all(`select tier__c from contacts`))[0]).toEqual({ tier__c: null })
  })
  it('a required field with a constant default fills existing rows', async () => {
    await fresh()
    await rowOf('contacts', 1)
    await applySchemaFile(d1, {}, one({ status__c: { kind: 'text', required: true, default: 'new' } }))
    expect((await all(`select status__c from contacts`))[0]).toEqual({ status__c: 'new' })
  })
  it('the built-ins keep working: rows insert and the core constraints still hold with every shape applied', async () => {
    await fresh()
    await applySchemaFile(d1, { projects__c: PROJECTS }, everywhere())
    for (const t of TABLES) if (t !== 'deals') await rowOf(t, 1)
    expect((await all(`select status__c from contacts`))[0]).toEqual({ status__c: 'new' })
  })
})

describe('refusals and archive on built-ins (P4, P5)', () => {
  const base = () =>
    one({
      note__c: { kind: 'text' },
      n__c: { kind: 'integer', default: 1 },
      req__c: { kind: 'text', required: true, default: 'x' },
      co__c: { kind: 'reference', target: 'companies' },
      u__c: { kind: 'text', unique: true },
    })
  const withBase = async () => {
    await fresh()
    expect((await applySchemaFile(d1, {}, base())).refused).toEqual([])
  }
  const change = (patch: Record<string, any>): ExtendDeclarations => ({ contacts: { ...base().contacts, ...patch } })
  const refusals: [string, Record<string, any>, string][] = [
    ['kind changed', { note__c: { kind: 'integer' } }, 'kind_changed:contacts.note__c'],
    ['target changed', { co__c: { kind: 'reference', target: 'deals' } }, 'target_changed:contacts.co__c'],
    ['default changed', { n__c: { kind: 'integer', default: 2 } }, 'default_changed:contacts.n__c'],
    ['default removed', { n__c: { kind: 'integer' } }, 'default_changed:contacts.n__c'],
    ['not-null removed', { req__c: { kind: 'text', default: 'x' } }, 'required_to_optional:contacts.req__c'],
    ['not-null added', { note__c: { kind: 'text', required: true, default: 'x' } }, 'default_changed:contacts.note__c'],
    ['unique removed', { u__c: { kind: 'text' } }, 'unique_removed:contacts.u__c'],
  ]
  for (const [name, patch, rule] of refusals)
    it(`${name} is refused by name and runs no statement`, async () => {
      await withBase()
      const before = await snapshot()
      const r = await applySchemaFile(d1, {}, { contacts: { ...change(patch).contacts!, fresh__c: { kind: 'text' } } })
      expect(rules(r)).toContain(rule)
      expect(r.statements).toBe(0)
      expect(await snapshot()).toBe(before)
    })
  it('the kind_changed message names the live kind with the right article, "an enum" and "a text" ([[CORE561]] 561.20)', async () => {
    await fresh()
    expect(
      (await applySchemaFile(d1, {}, one({ e__c: { kind: 'enum', values: ['a'] }, t__c: { kind: 'text' } }))).refused,
    ).toEqual([])
    const r = await applySchemaFile(d1, {}, one({ e__c: { kind: 'text' }, t__c: { kind: 'enum', values: ['a'] } }))
    const messages = r.refused.filter((x) => x.rule === 'kind_changed').map((x) => x.message)
    expect(messages).toEqual([
      'contacts.e__c is an enum field and the file declares text: a kind never changes',
      'contacts.t__c is a text field and the file declares enum: a kind never changes',
    ])
  })
  it('optional to required with the default kept is refused (not-null changes)', async () => {
    await fresh()
    await applySchemaFile(d1, {}, one({ s__c: { kind: 'text', default: 'x' } }))
    const r = await applySchemaFile(d1, {}, one({ s__c: { kind: 'text', default: 'x', required: true } }))
    expect(rules(r)).toContain('optional_to_required:contacts.s__c')
  })
  it('toggling required on a field with no default changes no DDL and is allowed, both ways', async () => {
    await fresh()
    await applySchemaFile(d1, {}, one({ t__c: { kind: 'text' } }))
    expect(planApply({}, await readLiveSchema(d1), one({ t__c: { kind: 'text', required: true } }))).toMatchObject({
      statements: [],
      refused: [],
    })
    await applySchemaFile(d1, {}, one({ t2__c: { kind: 'text', required: true } }))
    expect(planApply({}, await readLiveSchema(d1), one({ t2__c: { kind: 'text' } }))).toMatchObject({
      statements: [],
      refused: [],
    })
  })
  it('a unique field over live duplicates is refused with value and ids; a soft-deleted twin does not count; an empty table is fine', async () => {
    await fresh()
    expect((await applySchemaFile(d1, {}, one({ code__c: { kind: 'text', unique: true } }))).refused).toEqual([]) // empty state
    await fresh()
    await applySchemaFile(d1, {}, one({ code__c: { kind: 'text' } }))
    await rowOf('contacts', 1, { code__c: 'dup' })
    await rowOf('contacts', 2, { code__c: 'dup' })
    await rowOf('contacts', 3, { code__c: 'solo' })
    const before = await snapshot()
    const r = await applySchemaFile(d1, {}, one({ code__c: { kind: 'text', unique: true } }))
    expect(r.refused).toEqual([
      expect.objectContaining({
        rule: 'unique_violation',
        object: 'contacts',
        field: 'code__c',
        value: 'dup',
        ids: [id(1), id(2)],
      }),
    ])
    expect(await snapshot()).toBe(before)
    await d1.prepare(`update contacts set deleted_at = ? where id = ?`).bind(AT, id(2)).run()
    expect((await applySchemaFile(d1, {}, one({ code__c: { kind: 'text', unique: true } }))).refused).toEqual([])
    expect(await indexSql('idx_contacts_code__c_unique')).toBeDefined()
  })
  // [[CORE565]] 565.2: the file parser refuses unique + default (`unique_with_default`), so this is the defence for input built by hand: `applySchemaFile` takes parsed declarations and still refuses a collision it would create.
  it('a new unique field with a default over several live rows is refused (every row holds the default); the parser refuses the declaration first', async () => {
    expect(() =>
      parseExtend({ contacts: { fields: { k__c: { kind: 'text', unique: true, default: 'same' } } } }),
    ).toThrow(DeclarationError)
    await fresh()
    await rowOf('contacts', 1)
    await rowOf('contacts', 2)
    const r = await applySchemaFile(d1, {}, one({ k__c: { kind: 'text', unique: true, default: 'same' } }))
    expect(r.refused[0]).toMatchObject({ rule: 'unique_violation', value: 'same', ids: expect.any(Array) })
  })
  it('the 100-column cap counts the core columns', async () => {
    await fresh()
    const core = Object.keys(await info('contacts')).length
    const make = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}__c`, { kind: 'integer' as const }]))
    const over = await applySchemaFile(d1, {}, one(make(100 - core + 1)))
    expect(rules(over)).toContain('column_cap:contacts.')
    expect(over.statements).toBe(0)
    expect((await applySchemaFile(d1, {}, one(make(100 - core)))).refused).toEqual([])
    expect(Object.keys(await info('contacts'))).toHaveLength(100)
  })
  it('a removed field is archived: reported, kept, its data readable', async () => {
    await fresh()
    await applySchemaFile(d1, {}, one({ note__c: { kind: 'text' }, keep__c: { kind: 'text' } }))
    await rowOf('contacts', 1, { note__c: 'hello' })
    const r = await applySchemaFile(d1, {}, one({ keep__c: { kind: 'text' } }))
    expect(r.archived).toEqual([{ object: 'contacts', field: 'note__c' }])
    expect(r.statements).toBe(0)
    expect((await all(`select note__c from contacts`))[0]).toEqual({ note__c: 'hello' })
  })
})

describe('the boundary and the snapshot (P5, P6)', () => {
  it('a plan with extend emits only ADD COLUMN of a __c column and CREATE INDEX on such columns on a built-in table', async () => {
    await fresh()
    const plan = planApply({}, await readLiveSchema(d1), everywhere())
    expect(plan.statements.length).toBeGreaterThan(0)
    for (const s of plan.statements) {
      const add = /^ALTER TABLE "(contacts|companies|deals|tasks)" ADD COLUMN "([a-z0-9_]+__c)" /.exec(s)
      const idx =
        /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+__c[^"]*" ON "(?:contacts|companies|deals|tasks)" \(.*\)/.exec(s)
      expect(add !== null || idx !== null, s).toBe(true)
      if (idx) expect(/\("organization_id", "[a-z0-9_]+__c"/.test(s), s).toBe(true)
    }
  })
  it('the four tables are never created or archived, with extend or without, also over a fully applied database', async () => {
    await fresh()
    for (const extend of [undefined, {}, everywhere()]) {
      const r = await applySchemaFile(d1, { projects__c: PROJECTS }, extend)
      expect(r.created.filter((t) => TABLES.includes(t))).toEqual([])
      expect(r.archived.filter((a) => TABLES.includes(a.object) && a.field === undefined)).toEqual([])
    }
    expect((await applySchemaFile(d1, { projects__c: PROJECTS })).archived.every((a) => a.field !== undefined)).toBe(
      true,
    )
  })
  it('a __c column left on a built-in with no declaration is archived and kept', async () => {
    await fresh()
    await applySchemaFile(d1, {}, everywhere())
    const r = await applySchemaFile(d1, {})
    expect(r.archived).toHaveLength(Object.keys(shapes()!).length * 4)
    expect(r.archived).toContainEqual({ object: 'tasks', field: 'note__c' })
    expect(r.statements).toBe(0)
  })
  it('the snapshot covers the four tables beside the __c tables', async () => {
    await fresh()
    await applySchemaFile(d1, { projects__c: PROJECTS }, one({ note__c: { kind: 'text' } }))
    const live = await readLiveSchema(d1)
    expect(Object.keys(live.tables)).toEqual(['projects__c'])
    expect(Object.keys(live.builtins ?? {}).sort()).toEqual(['companies', 'contacts', 'deals', 'tasks'])
    expect(live.builtins!.contacts!.columns.map((c) => c.name)).toContain('note__c')
  })
  it('extend naming a table the snapshot lacks is refused, not planned', async () => {
    const plan = planApply({}, { tables: {} }, one({ note__c: { kind: 'text' } }))
    expect(plan.statements).toEqual([])
    expect(plan.refused.map((r) => r.rule)).toEqual(['table_missing'])
  })
})
