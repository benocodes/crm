import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileOperation, type PreparedOperation } from '@vibase/storage'
import type { TenantOperation } from '../registry.js'
import { createVibaseRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'
import { describeColumnFilter, parseCondition, type ColumnFilterSpec } from '../storage/column-filters.js'
import { FILTER_EXEMPT_LISTS, STATED_FILTER_COSTS } from '../storage/filter-costs.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { checkFilterContract, type FilterContractDef, type FilterContractInput } from '../test/filter-contract.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { PROJECTS_KEY, PROJECTS_REFS, createCustomTables, projectsRefsDefinition } from '../test/custom-objects.js'

// [[CORE541]] D31 (the schema.get part), D33, P1, P2: every declared field is a column filter with its kind's operators and an index cost derived from the declaration; the registry filter contract's real D1 plans agree with
// every reported cost; schema.get describes a custom table from its declaration, an undeclared __c table as archived, an undeclared column as not exposed, and leaves every built-in entry as it was.
const registry = createVibaseRegistry({ definitions: [projectsRefsDefinition()] })
const ALL = registry.declaredScopes()
const PATH = `/api/v1/${PROJECTS_KEY}`
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
  await createCustomTables(k.d1, PROJECTS_KEY, PROJECTS_REFS)
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.d1.prepare(`DELETE FROM "${PROJECTS_KEY}"`).run()
  await k.reset()
  owner = k.as(k.owner, ALL)
})
const call = (method: string, path: string, body?: unknown) => k.call(owner, method, path, body)
const ids = async (query: string) =>
  ((await call('GET', `${PATH}?${query}`)).body.data as Array<{ name: string }>).map((r) => r.name).sort()

describe('D33: every declared field is a column filter of its kind', () => {
  beforeEach(async () => {
    const company = (await call('POST', '/api/v1/companies', { name: 'Acme' })).body.id
    const rows = [
      {
        name: 'alpha',
        budget: 100,
        active: true,
        start_date: '2026-01-01T00:00:00Z',
        stage: 'planned',
        code: 'A',
        seq: 1,
        company,
      },
      {
        name: 'beta',
        budget: 500,
        active: false,
        start_date: '2026-06-01T00:00:00Z',
        stage: 'active',
        code: 'B',
        seq: 2,
      },
      { name: 'gamma', active: true, stage: 'done', owner: owner.id },
    ]
    for (const r of rows) expect((await call('POST', PATH, r)).status).toBe(201)
  })
  it('text: eq, like and ilike', async () => {
    expect(await ids('name=alpha')).toEqual(['alpha'])
    expect(await ids('name=ilike.*ETA')).toEqual(['beta'])
    expect(await ids('name=like.g*')).toEqual(['gamma'])
    expect(await ids('code=eq.B')).toEqual(['beta'])
  })
  it('integer: comparisons, in and is.null', async () => {
    expect(await ids('budget=gt.100')).toEqual(['beta'])
    expect(await ids('budget=in.(100,500)')).toEqual(['alpha', 'beta'])
    expect(await ids('budget=is.null')).toEqual(['gamma'])
    expect(await ids('seq=lte.1')).toEqual(['alpha'])
  })
  it('boolean: eq and neq', async () => {
    expect(await ids('active=eq.false')).toEqual(['beta'])
    expect(await ids('active=true')).toEqual(['alpha', 'gamma'])
  })
  it('timestamp: gte and is.null', async () => {
    expect(await ids('start_date=gte.2026-03-01')).toEqual(['beta'])
    expect(await ids('start_date=is.null')).toEqual(['gamma'])
  })
  it('enum (stored as text): eq and in', async () => {
    expect(await ids('stage=done')).toEqual(['gamma'])
    expect(await ids('stage=in.(planned,active)')).toEqual(['alpha', 'beta'])
  })
  it('reference (a uuid): eq, in and is.null', async () => {
    expect(await ids(`owner=${owner.id}`)).toEqual(['gamma'])
    expect(await ids('company=is.null')).toEqual(['beta', 'gamma'])
  })
  it('refuses an operator its kind does not have, and a filter that is not a field', async () => {
    expect((await call('GET', `${PATH}?active=gt.1`)).status).toBe(400)
    expect((await call('GET', `${PATH}?owner=ilike.a`)).status).toBe(400)
    expect((await call('GET', `${PATH}?colour=red`)).status).toBe(400)
  })
  it('a custom list declares no sorts and stays ordered by id', async () => {
    const all = (await call('GET', PATH)).body.data as Array<{ id: string }>
    expect(all.map((r) => r.id)).toEqual(all.map((r) => r.id).sort())
    expect((await call('GET', `${PATH}?sort=name`)).status).toBe(400)
  })
})

describe('P1, D33: the registry filter contract on D1 agrees with every reported cost', () => {
  let e: Engine
  let input: FilterContractInput
  let def: FilterContractDef & {
    columnFilters: Record<string, ColumnFilterSpec>
    statedFilterCosts: Array<{ filter: string; reason: string }>
  }
  const indexedOn = (details: readonly string[], table: string, column: string) =>
    details.some((d) => {
      const m = new RegExp(`^SEARCH ${table}(?: AS \\w+)? USING (?:COVERING )?INDEX \\S+ \\((.*)\\)$`).exec(d)
      return m !== null && m[1]!.split(' AND ').some((term) => new RegExp(`^${column}[=<>]`).test(term))
    })
  beforeAll(async () => {
    e = await openD1Engine()
    await createCustomTables(e.d1!, PROJECTS_KEY, PROJECTS_REFS)
    const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
    def = registry.resources().find((d) => d.name === PROJECTS_KEY) as unknown as typeof def
    const SAMPLES = ['018f0000-0000-7000-8000-000000000001', 'x', '1', '2026-01-01', 'true']
    const plans: Record<string, { indexed: boolean }> = {}
    const descriptions: Record<string, string> = {}
    for (const [filter, spec] of Object.entries(def.columnFilters)) {
      const key = `${PROJECTS_KEY}.${filter}`
      descriptions[key] = describeColumnFilter(filter, spec)
      const options = (spec.schema as unknown as { options?: string[] } | undefined)?.options ?? []
      const operand = [...SAMPLES, ...options].find((c) => {
        try {
          parseCondition(filter, spec, `eq.${c}`)
          return true
        } catch {
          return false
        }
      })!
      const op = registry.get(`${PROJECTS_KEY}.list`) as TenantOperation
      const read = compileOperation(
        (await op.prepare(env, {
          query: { [filter]: `eq.${operand}` },
          params: {},
          body: undefined,
        })) as PreparedOperation<unknown>,
        'd1',
      ).reads[0]!
      const rows = (
        await e
          .d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
          .bind(...read.parameters)
          .all()
      ).results as Array<{ detail: string }>
      plans[key] = {
        indexed: indexedOn(
          rows.map((r) => r.detail),
          PROJECTS_KEY,
          filter,
        ),
      }
    }
    input = {
      lists: [{ name: PROJECTS_KEY, def }],
      plans,
      costs: def.statedFilterCosts.map((c) => ({ list: PROJECTS_KEY, ...c })),
      exemptions: [],
      descriptions,
      nocase: new Set(),
    }
  })
  afterAll(() => e?.close())
  it('reports indexed true for the reference and unique fields and the id, and false for every other column', () => {
    const indexed = Object.entries(input.plans)
      .filter(([, p]) => p.indexed)
      .map(([key]) => key.slice(PROJECTS_KEY.length + 1))
      .sort()
    expect(indexed).toEqual(['code', 'company', 'deal', 'id', 'owner', 'parent', 'seq', 'task'])
    expect(def.statedFilterCosts.map((c) => c.filter).sort()).toEqual(
      ['active', 'budget', 'created_at', 'created_by', 'name', 'stage', 'start_date', 'updated_at'].sort(),
    )
  })
  it('checkFilterContract finds no violation in the custom list as built', () => {
    expect(checkFilterContract(input)).toEqual([])
    expect(STATED_FILTER_COSTS.some((c) => c.list === PROJECTS_KEY)).toBe(false)
    expect(FILTER_EXEMPT_LISTS.some((c) => c.list === PROJECTS_KEY)).toBe(false)
  })
  it('a cost that disagrees with its plan is named (an index claimed that the plan does not use)', () => {
    const lying = { ...input, plans: { ...input.plans, [`${PROJECTS_KEY}.owner`]: { indexed: false } } }
    expect(checkFilterContract(lying).map((v) => [v.check, v.filter])).toEqual([['missing-cost', 'owner']])
  })
})

describe('D31, P2: schema.get', () => {
  const doc = async (who = owner) => (await k.call(who, 'GET', '/meta/v1/schema')).body
  const tableOf = (d: any, name: string) => d.tables.find((t: any) => t.name === name)

  it('describes a custom table from its declaration: origin, archived, kinds, labels, descriptions, enum values, reference and filters', async () => {
    const t = tableOf(await doc(), PROJECTS_KEY)
    expect(t).toMatchObject({
      name: PROJECTS_KEY,
      origin: 'custom',
      archived: false,
      label: 'Projects',
      description: 'A piece of client work',
    })
    const col = (n: string) => t.columns.find((c: any) => c.name === n)
    expect(col('name')).toMatchObject({ kind: 'text', label: 'Name', exposed: true, nullable: false })
    expect(col('budget')).toMatchObject({ kind: 'integer', label: 'Budget', exposed: true })
    expect(col('active')).toMatchObject({ kind: 'boolean' })
    expect(col('start_date')).toMatchObject({ kind: 'timestamp' })
    expect(col('stage')).toMatchObject({ kind: 'text', values: ['planned', 'active', 'done'] })
    expect(col('owner')).toMatchObject({ kind: 'uuid', references: { table: 'principals', column: 'id' } })
    expect(col('parent')).toMatchObject({ kind: 'uuid', references: { table: PROJECTS_KEY, column: 'id' } })
    expect(col('id')).toMatchObject({ kind: 'uuid', exposed: true })
    expect(col('organization_id')).toMatchObject({ kind: 'uuid' })
    expect(col('deleted_at')).toMatchObject({ kind: 'timestamp', exposed: false })
    expect(t.resource).toMatchObject({
      name: PROJECTS_KEY,
      surface: 'api',
      path: PATH,
      read_scope: `${PROJECTS_KEY}:read`,
      write_scope: `${PROJECTS_KEY}:write`,
      sorts: [],
    })
    const filter = (n: string) => t.resource.filters.find((f: any) => f.name === n)
    expect(filter('code')).toMatchObject({ kind: 'text', custom: false, indexed: true })
    expect(filter('seq')).toMatchObject({ kind: 'integer', indexed: true })
    expect(filter('owner')).toMatchObject({ kind: 'uuid', indexed: true })
    expect(filter('name')).toMatchObject({ kind: 'text', indexed: false })
    expect(filter('budget')).toMatchObject({ indexed: false })
    expect(filter('active')).toMatchObject({ kind: 'boolean', indexed: false })
    expect(filter('stage')).toMatchObject({ kind: 'text', indexed: false })
    expect(filter('id')).toMatchObject({ indexed: true })
    expect(filter('organization_id')).toBeUndefined()
  })

  it('an undeclared __c table is archived: rows kept, resource null, not exposed, not served', async () => {
    await k.d1.exec(`CREATE TABLE "old__c" (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT) STRICT`)
    await k.d1
      .prepare(`INSERT INTO "old__c" (id, organization_id, name) VALUES (?, ?, 'kept')`)
      .bind('0190b2c4-0000-7000-8000-0000000000b1', k.organizationId)
      .run()
    const t = tableOf(await doc(), 'old__c')
    expect(t).toMatchObject({ origin: 'custom', archived: true, resource: null, associable: false })
    expect(t.columns.every((c: any) => c.exposed === false)).toBe(true)
    expect((await call('GET', '/api/v1/old__c')).status).toBe(404)
    expect((await k.d1.prepare(`SELECT name FROM "old__c"`).all()).results).toEqual([{ name: 'kept' }])
    await k.d1.exec(`DROP TABLE "old__c"`)
  })

  it('a column of a declared table that the declaration lacks is not exposed', async () => {
    await k.d1.exec(`ALTER TABLE "${PROJECTS_KEY}" ADD COLUMN legacy TEXT`)
    const t = tableOf(await doc(), PROJECTS_KEY)
    expect(t.columns.find((c: any) => c.name === 'legacy')).toMatchObject({ exposed: false, kind: null })
    expect(t.columns.find((c: any) => c.name === 'name')).toMatchObject({ exposed: true })
    expect(t.resource.filters.map((f: any) => f.name)).not.toContain('legacy')
    await k.d1.exec(`ALTER TABLE "${PROJECTS_KEY}" DROP COLUMN legacy`)
  })

  it('every built-in entry equals the entry of a database with no custom object, apart from archived (false); the empty state lists no custom entry', async () => {
    const plain = await openActionKit()
    try {
      const strip = (d: any) =>
        JSON.stringify(
          d.tables
            .filter((t: any) => t.origin === 'built_in')
            .map((t: any) => {
              expect(t.archived, t.name).toBe(false)
              const { archived: _a, ...rest } = t
              return rest
            }),
        )
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      const before = (await plain.call(plain.owner, 'GET', '/meta/v1/schema')).body
      expect(before.tables.filter((t: any) => t.origin === 'custom' || t.name.endsWith('__c'))).toEqual([])
      const after = await doc()
      expect(hash(strip(after))).toBe(hash(strip(before)))
      expect(after.tables.filter((t: any) => t.origin === 'custom').map((t: any) => t.name)).toEqual([PROJECTS_KEY])
      expect(after.associations.associable).toContain(PROJECTS_KEY)
    } finally {
      await plain.close()
    }
  })
})
