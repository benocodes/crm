import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import {
  ONE_OF_EACH,
  RESOURCES,
  RULES,
  baseBody,
  company,
  every,
  openExtendedKit,
  resetKit,
  pathOf,
  type Resource,
} from '../test/extension-kit.js'

// [[CORE559]] P5, P6 (D33, D31): each extension field is a column filter of its kind, reported indexed when unique or a reference and unindexed otherwise, derived from the definition; `schema.get` shows a declared
// column exposed with its metadata, and an undeclared (archived) one `exposed: false`, the table staying `built_in`.
const FIELDS = {
  note__c: { kind: 'text', label: 'Note', description: 'A free note' },
  seats__c: { kind: 'integer' },
  vip__c: { kind: 'boolean' },
  renew__c: { kind: 'timestamp' },
  tier__c: { kind: 'enum', values: ['gold', 'silver'], label: 'Tier', description: 'The plan' },
  parent__c: { kind: 'reference', target: 'companies' },
  code__c: { kind: 'text', unique: true },
} as const
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openExtendedKit(every(FIELDS as never))
  // a column no declaration names (an archived field, D31): applied from a declaration the registry below does not carry
  await k.d1.prepare(`alter table "contacts" add column "old__c" text`).run()
})
afterAll(() => k.close())
beforeEach(async () => {
  await resetKit(k)
  owner = k.owner
})
const schema = async () => (await k.call(owner, 'GET', '/meta/v1/schema')).body as any
const ids = (res: { body: any }) => (res.body.data as any[]).map((x) => x.name ?? x.title).sort()

describe.each(RESOURCES)('%s', (r: Resource) => {
  const mk = async (name: string, extra: Record<string, unknown>) => {
    const body = await baseBody(k, owner, r)
    const key = 'name' in body ? 'name' : 'title'
    const res = await k.call(owner, 'POST', pathOf(r), { ...body, [key]: name, ...extra })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body
  }
  it('each kind filters with its operators', async () => {
    const co = await company(k, owner)
    await mk('a', {
      note__c: 'alpha',
      seats__c: 5,
      vip__c: true,
      renew__c: '2027-01-01T00:00:00Z',
      tier__c: 'gold',
      parent__c: co,
    })
    await mk('b', {
      note__c: 'beta',
      seats__c: 10,
      vip__c: false,
      renew__c: '2027-06-01T00:00:00Z',
      tier__c: 'silver',
      code__c: 'X',
    })
    await mk('c', {})
    const q = async (query: string) => {
      const res = await k.call(owner, 'GET', `${pathOf(r)}?${query}`)
      expect(res.status, `${query} ${JSON.stringify(res.body)}`).toBe(200)
      return ids(res)
    }
    expect(await q('note__c=alpha')).toEqual(['a'])
    expect(await q('note__c=like.*et*')).toEqual(['b'])
    expect(await q('seats__c=gt.5')).toEqual(['b'])
    expect(await q('seats__c=in.(5,10)')).toEqual(['a', 'b'])
    expect(await q('vip__c=true')).toEqual(['a'])
    expect(await q('renew__c=lt.2027-03-01')).toEqual(['a'])
    expect(await q('tier__c=eq.silver')).toEqual(['b'])
    expect(await q('parent__c=' + co)).toEqual(['a'])
    expect(await q('code__c=X')).toEqual(['b'])
    expect(await q('seats__c=is.null')).toContain('c')
    expect(await q('seats__c=is.null')).not.toContain('a')
    // a filter on a field no row holds: the empty state
    expect(await q('note__c=nothing')).toEqual([])
    expect(await q('tier__c=eq.gold&seats__c=gt.5')).toEqual([])
    // the operators of the kind only
    const wrong = await k.call(owner, 'GET', `${pathOf(r)}?vip__c=gt.1`)
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.message).toContain('vip__c')
  })

  it("schema.get lists the filters with the kind's operators and the cost derived from the definition", async () => {
    const t = (await schema()).tables.find((x: any) => x.name === r)
    const f = (name: string) => t.resource.filters.find((x: any) => x.name === name)
    expect(f('seats__c')).toMatchObject({ custom: false, kind: 'integer', indexed: false })
    expect(f('seats__c').operators).toEqual(expect.arrayContaining(['eq', 'gt', 'lt', 'in']))
    expect(f('vip__c')).toMatchObject({ kind: 'boolean', indexed: false })
    expect(f('note__c')).toMatchObject({ kind: 'text', indexed: false })
    expect(f('renew__c')).toMatchObject({ kind: 'timestamp', indexed: false })
    expect(f('tier__c')).toMatchObject({ indexed: false })
    expect(f('parent__c')).toMatchObject({ kind: 'uuid', indexed: true })
    expect(f('code__c')).toMatchObject({ kind: 'text', indexed: true })
    // no sort on an extension field
    expect(t.resource.sorts.map((s: any) => s.name).filter((n: string) => n.endsWith('__c'))).toEqual([])
    const sorted = await k.call(owner, 'GET', `${pathOf(r)}?sort=seats__c`)
    expect(sorted.status).toBe(400)
  })

  it('schema.get shows a declared column exposed, with kind, label, description, values and reference target', async () => {
    const t = (await schema()).tables.find((x: any) => x.name === r)
    expect(t.origin).toBe('built_in')
    const col = (name: string) => t.columns.find((c: any) => c.name === name)
    expect(col('note__c')).toMatchObject({
      exposed: true,
      kind: 'text',
      label: 'Note',
      description: 'A free note',
      nullable: true,
      type: 'TEXT',
    })
    expect(col('tier__c')).toMatchObject({ exposed: true, kind: 'text', label: 'Tier', values: ['gold', 'silver'] })
    expect(col('seats__c')).toMatchObject({ exposed: true, kind: 'integer', type: 'INTEGER' })
    expect(col('vip__c')).toMatchObject({ exposed: true, kind: 'boolean' })
    expect(col('renew__c')).toMatchObject({ exposed: true, kind: 'timestamp' })
    expect(col('parent__c')).toMatchObject({
      exposed: true,
      kind: 'uuid',
      references: { table: 'companies', column: 'id' },
    })
    // the core columns are what they were: their kind and their enum values
    expect(col('id')).toMatchObject({ exposed: true, kind: 'uuid' })
    if (r === 'tasks') expect(col('status')).toMatchObject({ exposed: true, values: ['open', 'done'] })
  })
})

describe('an undeclared column (archived, D31)', () => {
  it('stays exposed false on the table it was added to, and is in no record', async () => {
    const t = (await schema()).tables.find((x: any) => x.name === 'contacts')
    expect(t.columns.find((c: any) => c.name === 'old__c')).toMatchObject({ exposed: false })
    expect(t.origin).toBe('built_in')
    const made = await k.call(owner, 'POST', '/api/v1/contacts', { name: 'x' })
    expect(Object.keys(made.body)).not.toContain('old__c')
  })
})

describe('the shapes of every rule are declared once and used for the stated cost', () => {
  it('a registry built with the kinds of the rules lists unique and reference filters indexed', async () => {
    const kk = await openExtendedKit(every({ ...ONE_OF_EACH, ...RULES }))
    try {
      await resetKit(kk)
      const t = ((await kk.call(kk.owner, 'GET', '/meta/v1/schema')).body as any).tables.find(
        (x: any) => x.name === 'tasks',
      )
      const idx = Object.fromEntries(t.resource.filters.map((x: any) => [x.name, x.indexed]))
      expect(idx).toMatchObject({
        code__c: true,
        seq__c: true,
        co__c: true,
        parent__c: true,
        req__c: false,
        lvl__c: false,
      })
    } finally {
      await kk.close()
    }
  })
})
