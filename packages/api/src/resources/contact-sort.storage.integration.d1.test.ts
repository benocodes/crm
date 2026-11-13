import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileOperation } from '@vibase/storage'
import { sql } from 'kysely'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { ScopeSet } from '../scopes.js'
import { listOperation } from '../storage/crud.js'
import { definePreparedResource } from '../storage/definition.js'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openEngines, type Engine } from '../test/engines.js'
import { contacts } from './contacts.js'

// [[CORE133]] D8, D9 on the D1 oracle: the keyset order over derived values with nulls in both directions, ties on the same value,
// page breaks inside the nulls and inside a tie, the scope gate and the query plan. Interaction rows come only from the capture unit.
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const OWNER = 'owner@vibase.test'
const READ = ['contacts:read', 'contacts:write', 'interactions:read']
const T1 = '2026-10-01T08:00:00.000Z'
const T2 = '2026-10-10T08:00:00.000Z'
const T3 = '2026-10-20T08:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const NAMES = ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09'] as const
const byId = new Map(NAMES.map((n, i) => [id(i + 1), n]))

let engines: Engine[]
let e: Engine
beforeAll(async () => {
  engines = await openEngines(['d1'])
  e = engines[0]!
})
afterAll(async () => {
  for (const x of engines) await x.close()
})
beforeEach(async () => {
  await e.reset()
  await e.insert('identities', { kind: 'email', value: OWNER, contact_id: null, own: true })
})

const env = (scopes: readonly string[] = READ) => e.env({ scopes: ScopeSet.parse([...scopes]) })
const outbound = (to: string, at: string) =>
  runCapture(e, {
    connection_id: C1,
    messages: [
      captureMessage(e.organizationId, {
        occurred_at: at,
        sent_by_connection: true,
        author: { user_id: OWNER, user_name: OWNER, full_name: 'Owner', is_bot: false },
        participants: [
          { kind: 'email', value: OWNER, role: 'from' },
          { kind: 'email', value: to, role: 'to' },
        ],
      }),
    ],
  })
const inbound = (from: string, at: string) =>
  runCapture(e, {
    connection_id: C1,
    messages: [
      captureMessage(e.organizationId, {
        occurred_at: at,
        author: { user_id: from, user_name: from, full_name: from, is_bot: false },
        participants: [
          { kind: 'email', value: from, role: 'from' },
          { kind: 'email', value: OWNER, role: 'to' },
        ],
      }),
    ],
  })
/**
 * Nine contacts with ids in name order. last_contacted_at: c01-c03 never, c09 never (inbound only), c04 and c05 tie at T1, c06 at T2,
 * c07 and c08 tie at T3. last_interacted_at: c01-c03 never, c04 and c05 T1, c06 and c09 tie at T2, c07 and c08 T3.
 */
async function seed(): Promise<void> {
  for (const [i, n] of NAMES.entries()) {
    await e.insert('contacts', { id: id(i + 1), name: n })
    await e.insert('identities', { kind: 'email', value: `${n}@x.test`, contact_id: id(i + 1), own: false })
  }
  await outbound('c04@x.test', T1)
  await outbound('c05@x.test', T1)
  await outbound('c06@x.test', T2)
  await outbound('c07@x.test', T3)
  await outbound('c08@x.test', T3)
  await inbound('c09@x.test', T2)
}

type Page = { data: Array<Record<string, unknown>>; next_cursor: string | null }
type Raw = { after?: unknown; limit?: unknown; sort?: unknown; order?: unknown; filters?: Record<string, string> }
const page = async (raw: Raw, scopes?: readonly string[]): Promise<Page> => (await e.run(listOperation(contacts, env(scopes), raw as never))).value as Page
/** Walks every page at `limit` and returns the names in the order met, and the page sizes. */
async function walk(raw: Raw, limit: number): Promise<{ names: string[]; pages: string[][] }> {
  const pages: string[][] = []
  let after: string | undefined
  for (let guard = 0; guard < 40; guard++) {
    const p = await page({ ...raw, limit, ...(after ? { after } : {}) })
    pages.push(p.data.map((r) => byId.get(r.id as string)!))
    if (p.next_cursor === null) return { names: pages.flat(), pages }
    after = p.next_cursor
  }
  throw new Error('the walk did not end')
}
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))

// Written out by hand from the seed above, never derived from the code under test.
const EXPECT = {
  last_contacted_at: {
    asc: ['c01', 'c02', 'c03', 'c09', 'c04', 'c05', 'c06', 'c07', 'c08'],
    desc: ['c08', 'c07', 'c06', 'c05', 'c04', 'c09', 'c03', 'c02', 'c01'],
  },
  last_interacted_at: {
    asc: ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c09', 'c07', 'c08'],
    desc: ['c08', 'c07', 'c09', 'c06', 'c05', 'c04', 'c03', 'c02', 'c01'],
  },
} as const

describe('keyset order with nulls, ties and page breaks (D8, D9)', () => {
  for (const sort of ['last_contacted_at', 'last_interacted_at'] as const) {
    for (const order of ['asc', 'desc'] as const) {
      it(`${sort} ${order}: nulls ${order === 'asc' ? 'first' : 'last'}, ties by id in the request's direction, every page size walks the full set once`, async () => {
        await seed()
        for (const limit of [1, 2, 3, 4, 50]) {
          const { names, pages } = await walk({ sort, order }, limit)
          expect(names, `limit ${limit}`).toEqual(EXPECT[sort][order])
          expect(new Set(names).size, `no repeats at limit ${limit}`).toBe(names.length)
          if (limit < 9) expect(pages.every((p) => p.length <= limit)).toBe(true)
        }
      })
    }
  }

  it('order defaults to asc when sort is given alone', async () => {
    await seed()
    expect((await walk({ sort: 'last_contacted_at' }, 4)).names).toEqual(EXPECT.last_contacted_at.asc)
  })

  it('the first page is the head of the sorted set (the page break falls inside the nulls, then inside a tie)', async () => {
    await seed()
    expect((await walk({ sort: 'last_contacted_at', order: 'asc' }, 2)).pages).toEqual([['c01', 'c02'], ['c03', 'c09'], ['c04', 'c05'], ['c06', 'c07'], ['c08']])
    expect((await walk({ sort: 'last_contacted_at', order: 'desc' }, 2)).pages).toEqual([['c08', 'c07'], ['c06', 'c05'], ['c04', 'c09'], ['c03', 'c02'], ['c01']])
    expect((await walk({ sort: 'last_interacted_at', order: 'desc' }, 3)).pages).toEqual([['c08', 'c07', 'c09'], ['c06', 'c05', 'c04'], ['c03', 'c02', 'c01']])
  })

  it('next_cursor is base64url of [sort, order, value or null, id] and the last page has none', async () => {
    await seed()
    const first = await page({ sort: 'last_contacted_at', order: 'asc', limit: 2 })
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decode(first.next_cursor!)).toEqual(['last_contacted_at', 'asc', null, id(2)])
    const mid = await page({ sort: 'last_contacted_at', order: 'desc', limit: 2 })
    expect(decode(mid.next_cursor!)).toEqual(['last_contacted_at', 'desc', T3, id(7)])
    const last = await page({ sort: 'last_contacted_at', order: 'asc', limit: 50 })
    expect(last.next_cursor).toBeNull()
  })

  it('sort combines with filters and limit: stale or never contacted, most recently interacted first', async () => {
    await seed()
    const filters = { not_contacted_since: '2026-10-05T00:00:00.000Z' }
    const out = await walk({ sort: 'last_interacted_at', order: 'desc', filters }, 2)
    expect(out.names).toEqual(['c09', 'c05', 'c04', 'c03', 'c02', 'c01'])
    const never = await walk({ sort: 'last_interacted_at', order: 'asc', filters: { never_contacted: 'true' } }, 1)
    expect(never.names).toEqual(['c01', 'c02', 'c03', 'c09'])
  })

  it('a sorted page carries the same records as the default order', async () => {
    await seed()
    const sorted = await page({ sort: 'last_contacted_at', order: 'desc', limit: 50 })
    const plain = await page({ limit: 50 })
    const key = (r: Record<string, unknown>) => String(r.id)
    expect(sorted.data.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort()).toEqual(plain.data.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort())
    expect(sorted.data.map(key)).not.toEqual(plain.data.map(key))
  })
})

describe('the scope gate (D5)', () => {
  const refused = (sort: string, scopes: readonly string[], raw: Raw = {}) => {
    try {
      listOperation(contacts, env(scopes), { sort, ...raw } as never)
    } catch (err) {
      return err as ApiError
    }
    return null
  }
  for (const sort of ['last_contacted_at', 'last_interacted_at']) {
    it(`sorting by ${sort} without interactions:read is 403 insufficient_scope naming the scope, before any query`, () => {
      const err = refused(sort, ['contacts:read'])
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 403, code: 'insufficient_scope' })
      expect(err!.message).toContain('interactions:read')
    })
    it(`with interactions:read the same sort is accepted (${sort})`, async () => {
      expect(refused(sort, READ)).toBeNull()
      expect((await page({ sort })).data).toEqual([])
    })
  }
  it('a malformed cursor is a 400 before the scope check, a well-formed one without the scope is a 403 (the check order)', () => {
    expect(refused('last_contacted_at', ['contacts:read'], { after: 'not-a-cursor' })).toMatchObject({ status: 400, code: 'validation_error' })
    const cursor = Buffer.from(JSON.stringify(['last_contacted_at', 'asc', null, id(1)])).toString('base64url')
    expect(refused('last_contacted_at', ['contacts:read'], { after: cursor })).toMatchObject({ status: 403 })
  })
})

describe('unsorted lists are unchanged', () => {
  it('without sort the cursor is the last id and the order is id order', async () => {
    await seed()
    const p = await page({ limit: 2 })
    expect(p.data.map((r) => byId.get(r.id as string))).toEqual(['c01', 'c02'])
    expect(p.next_cursor).toBe(id(2))
    expect((await page({ limit: 2, after: p.next_cursor! })).data.map((r) => byId.get(r.id as string))).toEqual(['c03', 'c04'])
  })
  it('a non-UUID after is still refused without sort', () => {
    expect(() => listOperation(contacts, env(), { after: 'nope' } as never)).toThrow(/after/)
  })
})

describe('query plan of a sorted list (D10)', () => {
  const planOf = async (op: Parameters<typeof compileOperation>[0]): Promise<string[]> => {
    const read = compileOperation(op, 'd1').reads[0]!
    const rows = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results as Array<{ detail: string }>
    return rows.map((r) => r.detail)
  }
  const assertSearches = (plan: string[]) => {
    const text = plan.join('\n')
    for (const table of ['identities', 'interaction_participants', 'interactions']) {
      expect(text, `${table} is touched`).toMatch(new RegExp(`SEARCH ${table}\\b`))
      expect(plan.filter((l) => new RegExp(`\\bSCAN ${table}\\b`).test(l)), `${table} is never scanned:\n${text}`).toEqual([])
    }
    expect(text).toMatch(/SEARCH identities USING INDEX idx_identities_contact_id \(contact_id=\?\)/)
    expect(text).toMatch(/SEARCH interaction_participants USING COVERING INDEX idx_interaction_participants_identity \(organization_id=\? AND identity_id=\?\)/)
    expect(text).toMatch(/SEARCH interactions USING INDEX \w+ \(organization_id=\? AND id=\?\)/)
  }
  it('a sorted first page and a sorted page behind a cursor (both directions) only SEARCH the three tables by index', async () => {
    const cursor = (sort: string, order: string, value: string | null) => Buffer.from(JSON.stringify([sort, order, value, id(5)])).toString('base64url')
    for (const order of ['asc', 'desc']) {
      assertSearches(await planOf(listOperation(contacts, env(), { sort: 'last_contacted_at', order, limit: 20 } as never)))
      assertSearches(await planOf(listOperation(contacts, env(), { sort: 'last_interacted_at', order, limit: 20, after: cursor('last_interacted_at', order, T2) } as never)))
      assertSearches(await planOf(listOperation(contacts, env(), { sort: 'last_contacted_at', order, limit: 20, after: cursor('last_contacted_at', order, null) } as never)))
    }
  })
})

describe('the mechanism beyond contacts (D8)', () => {
  const record = z.object({ id: z.uuid(), title: z.string(), shout: z.number().int().nullable().optional() })
  // title length, but null for a title of exactly four characters: a second derived field with nulls and ties.
  const shout = { kind: 'integer', requires: [{ resource: 'notes', action: 'read' }], expression: (_qc: unknown, parent: (c: string) => unknown) => sql`case when length(${parent('title')}) = 4 then null else length(${parent('title')}) end` } as const
  const synthetic = () =>
    definePreparedResource({ surface: 'api', name: 'tasks', eventName: 'task', table: 'tasks', record, derived: { shout }, sorts: ['shout'] } as never) as unknown as Parameters<typeof listOperation>[0]
  const taskId = (n: number) => `0190b2c4-0000-7000-8000-${String(n + 500).padStart(12, '0')}`
  const titles = ['aaaa', 'bb', 'bbbbbb', 'cc', 'dddd', 'eeeeee', 'f'] // lengths 4(null) 2 6 2 4(null) 6 1
  const names = new Map(titles.map((t, i) => [taskId(i + 1), `${i + 1}:${t}`]))
  const run = async (raw: Raw, scopes = ['tasks:read', 'notes:read']) => (await e.run(listOperation(synthetic(), env(scopes), raw as never))).value as Page
  async function walkTasks(raw: Raw, limit: number): Promise<string[]> {
    const out: string[] = []
    let after: string | undefined
    for (let guard = 0; guard < 30; guard++) {
      const p = await run({ ...raw, limit, ...(after ? { after } : {}) })
      out.push(...p.data.map((r) => names.get(r.id as string)!))
      if (p.next_cursor === null) return out
      after = p.next_cursor
    }
    throw new Error('the walk did not end')
  }
  beforeEach(async () => {
    for (const [i, t] of titles.entries()) await e.insertTask({ id: taskId(i + 1), title: t })
  })

  it('a definition that declares sorts gets sort and order and a sorted cursor, over a derived field that is not a contact one', async () => {
    const asc = ['1:aaaa', '5:dddd', '7:f', '2:bb', '4:cc', '3:bbbbbb', '6:eeeeee']
    const desc = ['6:eeeeee', '3:bbbbbb', '4:cc', '2:bb', '7:f', '5:dddd', '1:aaaa']
    for (const limit of [1, 2, 3, 50]) {
      expect(await walkTasks({ sort: 'shout', order: 'asc' }, limit), `asc ${limit}`).toEqual(asc)
      expect(await walkTasks({ sort: 'shout', order: 'desc' }, limit), `desc ${limit}`).toEqual(desc)
    }
    const first = await run({ sort: 'shout', order: 'asc', limit: 1 })
    expect(decode(first.next_cursor!)).toEqual(['shout', 'asc', null, taskId(1)])
    const mid = await run({ sort: 'shout', order: 'desc', limit: 2 })
    expect(decode(mid.next_cursor!)).toEqual(['shout', 'desc', 6, taskId(3)])
  })

  it('the synthetic field is gated by its own scope', () => {
    expect(() => listOperation(synthetic(), env(['tasks:read']), { sort: 'shout' } as never)).toThrow(/notes:read/)
  })

  it('a cursor of the synthetic sort does not fit another sort name or a wrong value type', async () => {
    const wrongType = Buffer.from(JSON.stringify(['shout', 'asc', 'two', taskId(1)])).toString('base64url')
    expect(() => listOperation(synthetic(), env(['tasks:read', 'notes:read']), { sort: 'shout', after: wrongType } as never)).toThrow(/cursor/)
  })

  it('a list that declares no sorts refuses sort and order exactly as before (an unknown filter)', async () => {
    const plain = definePreparedResource({ surface: 'api', name: 'tasks', eventName: 'task', table: 'tasks', record: z.object({ id: z.uuid(), title: z.string() }) } as never) as unknown as Parameters<typeof listOperation>[0]
    expect(() => listOperation(plain, env(['tasks:read']), { sort: 'title' } as never)).toThrow(/unknown filter: sort|sort/)
    expect(() => listOperation(plain, env(['tasks:read']), { filters: { sort: 'title' } } as never)).toThrow(/unknown filter: sort/)
    expect(() => listOperation(plain, env(['tasks:read']), { filters: { order: 'asc' } } as never)).toThrow(/unknown filter: order/)
  })
})
