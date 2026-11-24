import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { applyExtensions, planApply, readLiveSchema } from './apply.js'
import { createTableStatements } from './ddl.js'
import { BAG_KEY, BAG_LIMITS } from '../storage/additional-props.js'
import { createVibaseRegistry } from '../operations.js'
import { toolName } from '../registry.js'
import { d1Backend } from '../test/d1-backend.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { PROJECTS, PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'

// [[CORE318]] D13 and [[CORE549]]: a custom object has the property bag. The table has the column and its CHECK, apply adds the column to a table that lacks it (once), the record creates, merge-patches and reads
// the bag with its events, and the custom object takes the filter, the `property_keys` read and the schema.get entry like a built-in.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-24T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

describe('the table and apply (D13)', () => {
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
  const run = (sqlText: string, ...binds: unknown[]) =>
    d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
      () => null,
      (e: Error) => e.message,
    )
  beforeEach(async () => {
    const tables = await all<{ name: string }>(
      `select name from sqlite_master where type = 'table' and name like '%\\_\\_c' escape '\\'`,
    )
    if (tables.length > 0) await d1.batch(tables.map((t) => d1.prepare(`drop table "${t.name}"`)))
  })
  const insert = (n: number, extra: Record<string, unknown> = {}) => {
    const r = { id: id(n), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, name: 'P', ...extra }
    const cols = Object.keys(r)
    return run(
      `INSERT INTO "${PROJECTS_KEY}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...Object.values(r),
    )
  }
  const columns = async () =>
    all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      `select name, type, "notnull", dflt_value from pragma_table_info(?)`,
      PROJECTS_KEY,
    )

  it('a table made by the DDL has additional_props TEXT NOT NULL DEFAULT {} and its CHECK refuses what is not a JSON object', async () => {
    await createCustomTables(d1)
    const bag = (await columns()).find((c) => c.name === 'additional_props')
    expect(bag).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'{}'" })
    expect(await insert(1)).toBeNull()
    expect((await all(`select additional_props from "${PROJECTS_KEY}"`))[0]!.additional_props).toBe('{}')
    expect(await insert(2, { additional_props: '{"a":1}' })).toBeNull()
    expect(await insert(3, { additional_props: '[]' })).toMatch(/CHECK|constraint/i)
    expect(await insert(4, { additional_props: 'not json' })).toMatch(/CHECK|constraint/i)
    expect(await insert(5, { additional_props: '3' })).toMatch(/CHECK|constraint/i)
  })

  /** The table as it was before the bag: the DDL's first statement without the bag's column line. */
  const oldShape = () => {
    const sql = createTableStatements(PROJECTS_KEY, PROJECTS)[0]!
    const without = sql.replace(/\n {2}"additional_props"[^\n]*/, '')
    expect(without).not.toContain('additional_props')
    return without
  }

  it('apply adds the column to a __c table created without it: rows read {}, a second apply plans nothing', async () => {
    await d1.batch([d1.prepare(oldShape())])
    expect((await columns()).map((c) => c.name)).not.toContain('additional_props')
    expect(await insert(1)).toBeNull()
    expect(await insert(2, { name: 'Q' })).toBeNull()
    const plan = planApply({ [PROJECTS_KEY]: PROJECTS }, await readLiveSchema(d1))
    expect(plan.statements.filter((s) => s.startsWith('ALTER TABLE'))).toHaveLength(1)
    expect(plan.statements.join('\n')).toContain('additional_props')
    expect(plan.refused).toEqual([])
    const report = await applyExtensions(d1, { [PROJECTS_KEY]: PROJECTS })
    expect(report.refused).toEqual([])
    const bag = (await columns()).find((c) => c.name === 'additional_props')
    expect(bag).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'{}'" })
    expect((await all(`select additional_props from "${PROJECTS_KEY}"`)).map((r) => r.additional_props)).toEqual([
      '{}',
      '{}',
    ])
    // its CHECK came with it
    expect(await insert(3, { additional_props: '[]' })).toMatch(/CHECK|constraint/i)
    const again = await applyExtensions(d1, { [PROJECTS_KEY]: PROJECTS })
    expect(again).toMatchObject({ statements: 0, created: [], added: [], indexed: [], refused: [] })
    expect(planApply({ [PROJECTS_KEY]: PROJECTS }, await readLiveSchema(d1)).statements).toEqual([])
  })

  it('the bag is never compared as a declared field: it is not archived, not refused, on a table that has it', async () => {
    await applyExtensions(d1, { [PROJECTS_KEY]: PROJECTS })
    const plan = planApply({ [PROJECTS_KEY]: PROJECTS }, await readLiveSchema(d1))
    expect(plan.archived).toEqual([])
    expect(plan.refused).toEqual([])
  })
})

describe('served: the record, its events, the filter, property_keys and schema.get', () => {
  const registry = createVibaseRegistry({ definitions: [projectsDefinition()] })
  const ALL = registry.declaredScopes()
  const PATH = `/api/v1/${PROJECTS_KEY}`
  const d1s: D1Like[] = []
  let s: ContractSession
  let a: ContractTenant
  beforeAll(async () => {
    s = await d1Backend({
      setup: async (d1) => {
        d1s.push(d1)
        await createCustomTables(d1)
      },
    }).open(registry)
  })
  afterAll(() => s.close())
  beforeEach(async () => {
    ;({ a } = await s.reset())
  })
  const call = (method: string, path: string, body?: unknown, scopes = ALL, actor: 'user' | 'agent' = 'user') =>
    s.call(a, actor, scopes, method, path, body)
  const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any })
  const make = async (name: string, additional_props?: unknown) => {
    const r = await json(
      await call('POST', PATH, { name, ...(additional_props === undefined ? {} : { additional_props }) }),
    )
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body as Record<string, any>
  }
  const names = async (condition: string) => {
    const r = await json(await call('GET', `${PATH}?additional_props=${encodeURIComponent(condition)}`))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return r.body.data.map((x: any) => x.name).sort() as string[]
  }

  it('creates, merge-patches and reads the bag, one event each carrying before and after objects', async () => {
    const p = await make('one', { city: 'Paris', n: 3 })
    expect(p.additional_props).toEqual({ city: 'Paris', n: 3 })
    expect((await make('empty')).additional_props).toEqual({})
    const u = await json(await call('PATCH', `${PATH}/${p.id}`, { additional_props: { city: null, flag: true } }))
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(u.body.additional_props).toEqual({ n: 3, flag: true })
    const got = await json(await call('GET', `${PATH}/${p.id}`))
    expect(got.body.additional_props).toEqual({ n: 3, flag: true })
    const events = await s.eventsOf(p.id)
    expect(events.map((e) => e.type)).toEqual([`${PROJECTS_KEY}.created`, `${PROJECTS_KEY}.updated`])
    expect(events[0]!.after.additional_props).toEqual({ city: 'Paris', n: 3 })
    expect(events[1]!.before.additional_props).toEqual({ city: 'Paris', n: 3 })
    expect(events[1]!.after.additional_props).toEqual({ n: 3, flag: true })
    // a patch that names no bag leaves it alone
    const named = await json(await call('PATCH', `${PATH}/${p.id}`, { name: 'renamed' }))
    expect(named.body.additional_props).toEqual({ n: 3, flag: true })
  })

  it('refuses a D2 rule on a custom record: a nested value, a bad key, a null bag', async () => {
    for (const bag of [{ nest: { a: 1 } }, { Abc: 1 }, { long: 'x'.repeat(1001) }, null]) {
      const r = await json(await call('POST', PATH, { name: 'x', additional_props: bag }))
      expect(r.status, JSON.stringify(bag)).toBe(400)
      expect(r.body.error.code).toBe('validation_error')
    }
    const p = await make('ok')
    const r = await json(await call('PATCH', `${PATH}/${p.id}`, { additional_props: { a__b: 1 } }))
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/key "a__b"/)
  })

  it('filters by a bag key (one eq case), refuses what the built-ins refuse', async () => {
    await make('hit', { tier: 'gold', n: 40 })
    await make('miss', { tier: 'tin' })
    await make('none')
    expect(await names('tier.eq.gold')).toEqual(['hit'])
    expect(await names('n.eq.40')).toEqual(['hit'])
    expect(await names('tier.is.null')).toEqual(['none'])
    const bad = await json(await call('GET', `${PATH}?additional_props=${encodeURIComponent('tier.gt.1')}`))
    expect([bad.status, bad.body.error.code]).toEqual([400, 'validation_error'])
  })

  it('property_keys counts live records, answers 403 without read, and its tool name is valid at the longest key', async () => {
    await make('a', { city: 'x', n: 1 })
    const b = await make('b', { city: 'y' })
    const c = await make('c', { gone: 1 })
    await call('DELETE', `${PATH}/${c.id}`)
    void b
    const r = await json(await call('GET', `${PATH}/property-keys`, undefined, [`${PROJECTS_KEY}:read`]))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      data: [
        { key: 'city', records: 2, types: ['string'] },
        { key: 'n', records: 1, types: ['number'] },
      ],
      truncated: false,
    })
    const empty = await json(await call('GET', `${PATH}/property-keys`, undefined, ['contacts:read']))
    expect(empty.status).toBe(403)
    const op = registry.operations().find((o) => o.name === `${PROJECTS_KEY}.property_keys`)
    expect(op).toBeDefined()
    expect((op as any).scope).toEqual({ resource: PROJECTS_KEY, action: 'read' })
    const longest = `${'a'.repeat(40)}__c`
    expect(longest).toHaveLength(43)
    expect(toolName(`${longest}.property_keys`)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    // empty table
    const none = await json(await call('GET', `${PATH}?limit=1`))
    expect(none.status).toBe(200)
  })

  it('schema.get: the bag column is exposed with a description of the rules; the filter is unindexed', async () => {
    const r = await json(await call('GET', '/meta/v1/schema'))
    expect(r.status).toBe(200)
    const t = r.body.tables.find((x: any) => x.name === PROJECTS_KEY)
    const col = t.columns.find((c: any) => c.name === 'additional_props')
    expect(col.exposed).toBe(true)
    for (const part of [
      BAG_KEY.source,
      String(BAG_LIMITS.string),
      String(BAG_LIMITS.keys),
      String(BAG_LIMITS.bytes),
      `${PROJECTS_KEY}.property_keys`,
      'merge patch',
      'additional_props=',
    ])
      expect(col.description, part).toContain(part)
    const f = t.resource.filters.find((x: any) => x.name === 'additional_props')
    expect(f.indexed).toBe(false)
    expect(t.resource.operations).toContain(`${PROJECTS_KEY}.property_keys`)
  })
})
