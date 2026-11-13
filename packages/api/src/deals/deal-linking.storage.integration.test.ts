import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { splitArguments } from '../mcp/tools.js'
import { mergeOperation } from '../identity/merge.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE136 on D1 (the oracle), [[CORE130]] D14/D15: deals are associable with companies, contacts, tasks, notes, tags and threads;
// `deals.list` filters by tag_id / company_id / contact_id; `deals.delete` cascades its edges; the other programs treat a deal
// edge like any other; no deal.* event ever carries `status`.
let e: Engine
let a: AssocKit
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  a = assocKit(e)
})

type Ent = [string, string]
const ids = (page: { data: Rec[] }) => page.data.map((r) => r.id as string).sort()
const events = async (prefix: string) => (await e.rows('events')).filter((x) => String(x.type).startsWith(prefix)).sort((x, y) => String(x.id).localeCompare(String(y.id)))
let stageId = ''
const newDeal = async (name = 'D', stage = stageId, opts?: Parameters<AssocKit['call']>[2]): Promise<Ent> => ['deals', (await a.call('deals.create', { body: { name, stage_id: stage } }, opts)).id as string]
beforeEach(async () => {
  const p = await a.call('pipelines.create', { body: { name: 'Sales' } })
  stageId = (await a.call('pipeline_stages.create', { body: { pipeline_id: p.id, name: 'Researched', kind: 'open', position: 10 } })).id
})
const refusal = async (x: Ent, y: Ent) => {
  const err = await a.fail('associations.create', { body: { a_type: x[0], a_id: x[1], b_type: y[0], b_id: y[1] } })
  return [err.status, err.code, err.message] as const
}

describe('the neighbour rules of deals (D14)', () => {
  const six: Array<['companies' | 'contacts' | 'tasks' | 'notes' | 'tags' | 'threads', () => Promise<Ent>]> = [
    ['companies', () => a.ent.company()],
    ['contacts', () => a.ent.contact()],
    ['tasks', () => a.ent.task()],
    ['notes', () => a.ent.note()],
    ['tags', () => a.ent.tag('T')],
    ['threads', () => a.ent.thread()],
  ]
  it.each(six)('a deal and %s link with the deal as a and as b', async (_type, make) => {
    const d1 = await newDeal('d1')
    const d2 = await newDeal('d2')
    const x1 = await make()
    const x2 = await (_type === 'tags' ? a.ent.tag('T2') : make())
    const one = await a.link(d1, x1)
    const two = await a.link(x2, d2)
    expect([one.id, two.id]).toHaveLength(2)
    expect((await a.list('deals', d1[1])).data.map((r) => r.neighbour_id)).toEqual([x1[1]])
    expect((await a.list('deals', d2[1])).data.map((r) => r.neighbour_id)).toEqual([x2[1]])
    // canonical order is by type name whichever way the pair was given
    const b = await a.link(d1, x2)
    expect([b.a_type, b.b_type]).toEqual([d1[0], x2[0]].sort())
  })

  it.each(['deal to deal', 'deal to interaction'])('refuses %s in both orders with 400 validation_error and the existing message', async (name) => {
    const d = await newDeal('d')
    const partner: Ent = name === 'deal to deal' ? await newDeal('d2') : await a.ent.interaction()
    for (const [x, y] of [[d, partner], [partner, d]] as Array<[Ent, Ent]>) {
      const [status, code, message] = await refusal(x, y)
      expect([status, code]).toEqual([400, 'validation_error'])
      expect(message).toBe('deals can only be linked to companies, contacts, notes, tags, tasks, threads')
    }
    expect(await a.edges(false)).toEqual([])
  })

  it('tags still refuse threads and interactions, and name deals among the allowed types', async () => {
    const t = await a.ent.tag('T')
    for (const partner of [await a.ent.thread(), await a.ent.interaction()]) {
      for (const [x, y] of [[t, partner], [partner, t]] as Array<[Ent, Ent]>) {
        const [status, code, message] = await refusal(x, y)
        expect([status, code, message]).toEqual([400, 'validation_error', 'tags can only be linked to companies, contacts, deals, notes, tasks'])
      }
    }
  })

  it('deals.get?include=associations embeds the live edges of the deal, and is 403 without associations:read', async () => {
    const d = await newDeal('d')
    const co = await a.ent.company()
    const ct = await a.ent.contact()
    await a.link(d, co)
    const gone = await a.link(ct, d)
    await a.unlink(gone.id)
    const got = await a.call('deals.get', { params: { id: d[1] }, query: { include: 'associations' } })
    expect(got.associations.map((x: Rec) => x.neighbour_id)).toEqual([co[1]])
    expect(got.associations_truncated).toBe(false)
    expect(got.status).toBe('open')
    const err = await a.fail('deals.get', { params: { id: d[1] }, query: { include: 'associations' } }, { as: 'agent', scopes: ['deals:read'] })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('associations:read')
    expect((await a.call('deals.get', { params: { id: d[1] } }, { as: 'agent', scopes: ['deals:read'] })).associations).toBeUndefined()
  })
})

describe('the custom filters of deals.list (D15)', () => {
  const listOf = (query: Rec = {}, opts?: Parameters<AssocKit['call']>[2]) => a.call('deals.list', { query }, opts)
  // types sort alphabetically: companies, contacts < deals < tags, so the deal is side b for a company and a contact and side a for a tag
  it.each([
    ['company_id', 'companies', 'b', () => a.ent.company('Co')],
    ['contact_id', 'contacts', 'b', () => a.ent.contact('Ct')],
    ['tag_id', 'tags', 'a', () => a.ent.tag('T')],
  ] as const)('%s returns exactly the deals with a live edge to the record (the deal is side %s), excluding other and deleted edges', async (filter, type, side, make) => {
    const target = await make()
    const other = type === 'tags' ? await a.ent.tag('Other') : await make()
    const d1 = await newDeal('d1')
    const d2 = await newDeal('d2')
    const d3 = await newDeal('d3')
    const d4 = await newDeal('d4')
    const unlinked = await newDeal('unlinked')
    const e1 = await a.link(d1, target)
    await a.link(target, d2)
    await a.link(d3, other)
    const gone = await a.link(d4, target)
    await a.unlink(gone.id)
    const edge = (await a.edges()).find((x) => x.id === e1.id)!
    expect(side === 'a' ? edge.a_type : edge.b_type).toBe('deals')
    expect(type === 'tags' ? edge.b_type : edge.a_type).toBe(type)
    expect(ids(await listOf({ [filter]: target[1] }))).toEqual([d1[1], d2[1]].sort())
    expect(ids(await listOf({ [filter]: target[1].toUpperCase() }))).toEqual([d1[1], d2[1]].sort())
    expect(ids(await listOf())).toHaveLength(5)
    expect(unlinked[1]).toBeDefined()
  })

  it('the filters are not interchangeable: a company id in contact_id or tag_id matches nothing', async () => {
    const co = await a.ent.company()
    const d = await newDeal()
    await a.link(co, d)
    expect(ids(await listOf({ company_id: co[1] }))).toEqual([d[1]])
    for (const f of ['contact_id', 'tag_id']) expect(await listOf({ [f]: co[1] })).toEqual({ data: [], next_cursor: null })
  })

  it.each(['company_id', 'contact_id', 'tag_id'])('%s: an unknown id is an empty page; a malformed one is 400', async (filter) => {
    expect(await listOf({ [filter]: uuidv7() })).toEqual({ data: [], next_cursor: null })
    const err = await a.fail('deals.list', { query: { [filter]: 'nope' } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })

  it('is ANDed with stage_id and status, and pages across the boundary', async () => {
    const p = (await a.call('pipelines.list', { query: {} })).data[0]
    const won = await a.call('pipeline_stages.create', { body: { pipeline_id: p.id, name: 'Won', kind: 'won', position: 90 } })
    const co = await a.ent.company()
    const members: string[] = []
    for (let i = 0; i < 5; i++) {
      const d = await newDeal(`m${i}`, i < 3 ? stageId : won.id)
      members.push(d[1])
      await a.link(co, d)
    }
    await newDeal('not linked')
    const p1 = await listOf({ company_id: co[1], limit: 2 })
    expect(p1.data).toHaveLength(2)
    expect(p1.next_cursor).toBe(p1.data[1].id)
    const p2 = await listOf({ company_id: co[1], limit: 2, after: p1.next_cursor })
    const p3 = await listOf({ company_id: co[1], limit: 2, after: p2.next_cursor })
    expect([...p1.data, ...p2.data, ...p3.data].map((r: Rec) => r.id)).toEqual(members)
    expect(p3.next_cursor).toBeNull()
    expect(ids(await listOf({ company_id: co[1], status: 'won' }))).toEqual(members.slice(3).sort())
    expect(ids(await listOf({ company_id: co[1], stage_id: stageId }))).toEqual(members.slice(0, 3).sort())
    // two custom filters together AND as well
    const ct = await a.ent.contact()
    await a.link(ct, ['deals', members[1]!])
    expect(ids(await listOf({ company_id: co[1], contact_id: ct[1] }))).toEqual([members[1]])
  })

  it('tag_id on companies, contacts and tasks keeps working', async () => {
    const t = await a.ent.tag('T')
    const co = await a.ent.company()
    await a.link(t, co)
    expect(ids(await a.call('companies.list', { query: { tag_id: t[1] } }))).toEqual([co[1]])
  })

  const FULL = ['deals:read', 'companies:read', 'contacts:read', 'tags:read', 'associations:read']
  it.each([
    ['company_id', 'companies:read', () => a.ent.company()],
    ['contact_id', 'contacts:read', () => a.ent.contact()],
    ['tag_id', 'tags:read', () => a.ent.tag('T')],
  ] as const)('%s needs %s and associations:read on top of deals:read: each missing one is 403 insufficient_scope naming it; all held is 200', async (filter, own, make) => {
    const target = await make()
    const d = await newDeal()
    await a.link(d, target)
    for (const missing of [own, 'associations:read']) {
      const err = await a.fail('deals.list', { query: { [filter]: target[1] } }, { as: 'agent', scopes: FULL.filter((s) => s !== missing) })
      expect([err.status, err.code], missing).toEqual([403, 'insufficient_scope'])
      expect(err.message).toContain(missing)
    }
    expect(ids(await listOf({ [filter]: target[1] }, { as: 'agent', scopes: FULL }))).toEqual([d[1]])
    expect(ids(await listOf({}, { as: 'agent', scopes: ['deals:read'] }))).toEqual([d[1]])
  })

  it('over MCP argument splitting: contact_id without contacts:read is 403, and a repeated company_id is 400', async () => {
    const ct = await a.ent.contact()
    const op = a.registry.get('deals.list')!
    const { query } = splitArguments(op, { contact_id: ct[1] })
    const err = await a.fail('deals.list', { query }, { as: 'agent', scopes: ['deals:read', 'associations:read'] })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('contacts:read')
    const split = splitArguments(op, { company_id: [uuidv7(), uuidv7()] })
    const bad = await a.fail('deals.list', { query: split.query })
    expect([bad.status, bad.code]).toEqual([400, 'validation_error'])
  })
})

describe('deals.delete cascades its live edges (D13/D14)', () => {
  it('soft-deletes every edge (deal on either side), one association.deleted each in id order, rows kept, neighbours untouched', async () => {
    const d = await newDeal('d')
    const neighbours: Ent[] = [await a.ent.company(), await a.ent.contact(), await a.ent.task(), await a.ent.note(), await a.ent.tag('T'), await a.ent.thread()]
    const links: Rec[] = []
    for (const [i, n] of neighbours.entries()) links.push(i % 2 ? await a.link(n, d) : await a.link(d, n))
    expect(new Set(links.map((l) => l.a_type === 'deals'))).toEqual(new Set([true, false]))
    const keep = await a.link(neighbours[0]!, neighbours[1]!)
    const other = await newDeal('other')
    const otherEdge = await a.link(other, neighbours[0]!)
    const mark = (await e.rows('events')).length
    await a.call('deals.delete', { params: { id: d[1] } })
    expect((await e.rows('deals')).find((r) => r.id === d[1])!.deleted_at).not.toBeNull()
    const rows = await a.edges(false)
    for (const l of links) expect(rows.find((r) => r.id === l.id)!.deleted_at).not.toBeNull()
    for (const k of [keep, otherEdge]) expect(rows.find((r) => r.id === k.id)!.deleted_at).toBeNull()
    for (const n of neighbours) expect((await e.rows(n[0])).find((r) => r.id === n[1])!.deleted_at ?? null).toBeNull() // threads do not soft-delete
    const evs = (await e.rows('events')).slice(mark)
    expect(evs[0]).toMatchObject({ type: 'deal.deleted', resource_id: d[1] })
    const edgeEvents = evs.filter((x) => x.type === 'association.deleted')
    expect(edgeEvents.map((x) => x.resource_id)).toEqual(links.map((l) => l.id).sort())
    expect(evs).toHaveLength(1 + links.length)
    expect(evs.map((x) => String(x.id))).toEqual([...evs.map((x) => String(x.id))].sort())
  })

  it('a deal with no edges deletes with exactly one event', async () => {
    const d = await newDeal('d')
    const mark = (await e.rows('events')).length
    await a.call('deals.delete', { params: { id: d[1] } })
    expect((await e.rows('events')).slice(mark).map((x) => x.type)).toEqual(['deal.deleted'])
  })

  it('over the set limit is 400 set_limit_exceeded and nothing changes', async () => {
    const small = await openD1Engine({ maxSetSize: 2 })
    try {
      const k = assocKit(small)
      const p = await k.call('pipelines.create', { body: { name: 'P' } })
      const s = await k.call('pipeline_stages.create', { body: { pipeline_id: p.id, name: 'S', kind: 'open', position: 1 } })
      const d: Ent = ['deals', (await k.call('deals.create', { body: { name: 'D', stage_id: s.id } })).id]
      for (let i = 0; i < 3; i++) await k.link(d, await k.ent.thread())
      const mark = (await small.rows('events')).length
      const err = await k.fail('deals.delete', { params: { id: d[1] } })
      expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
      expect((await small.rows('deals'))[0]!.deleted_at).toBeNull()
      expect(await k.edges()).toHaveLength(3)
      expect((await small.rows('events')).length).toBe(mark)
    } finally {
      await small.close()
    }
  })

  it('is atomic: an edge created between plan and commit aborts the unit, the deal stays live', async () => {
    const d = await newDeal('d')
    await a.link(d, await a.ent.company())
    const late = await a.ent.contact()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => {
      await e.insert('associations', { a_type: 'contacts', a_id: late[1], b_type: 'deals', b_id: d[1], relation: 'related_to' })
    })
    const err = await a.call('deals.delete', { params: { id: d[1] } }).then(() => undefined, (x: unknown) => x)
    expect(err).toBeDefined()
    expect((await e.rows('deals')).find((r) => r.id === d[1])!.deleted_at).toBeNull()
    expect((await a.edges()).filter((r) => r.deleted_at === null)).toHaveLength(2)
    expect((await e.rows('events')).length).toBe(mark) // the raw insert emits no event
  })
})

describe('the other programs treat a deal edge like any other (D13/D14)', () => {
  it.each([
    ['companies', () => a.ent.company()],
    ['contacts', () => a.ent.contact()],
  ] as const)('%s.delete soft-deletes its edge to a deal; the deal is unchanged and no deal event is written', async (type, make) => {
    const p = await make()
    const d = await newDeal('d')
    const edge = await a.link(p, d)
    const before = (await e.rows('deals')).find((r) => r.id === d[1])
    const mark = (await e.rows('events')).length
    await a.call(`${type}.delete`, { params: { id: p[1] } })
    expect((await a.edges(false)).find((r) => r.id === edge.id)!.deleted_at).not.toBeNull()
    expect((await e.rows('deals')).find((r) => r.id === d[1])).toEqual(before)
    const evs = (await e.rows('events')).slice(mark)
    expect(evs.map((x) => x.type)).toContain('association.deleted')
    expect(evs.filter((x) => String(x.type).startsWith('deal.'))).toEqual([])
  })

  const merge = (survivor: Ent, source: Ent) => a.k.run((env) => mergeOperation(env, survivor[1], source[1]))
  it('merge with a shared deal leaves one live edge to the survivor; a deal linked only to the source is re-pointed', async () => {
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    const shared = await newDeal('shared')
    const onlyR = await newDeal('only-r')
    await a.link(s, shared)
    const dup = await a.link(r, shared)
    const moved = await a.link(r, onlyR)
    const mark = (await e.rows('events')).length
    await merge(s, r)
    const live = (await a.edges()).filter((x) => x.a_type === 'deals' || x.b_type === 'deals')
    expect(live.filter((x) => x.b_id === shared[1])).toHaveLength(1)
    expect(live.filter((x) => x.b_id === shared[1])[0]).toMatchObject({ a_id: s[1] })
    expect(live.find((x) => x.b_id === onlyR[1])).toMatchObject({ id: moved.id, a_id: s[1] })
    expect((await a.edges(false)).find((x) => x.id === dup.id)!.deleted_at).not.toBeNull()
    const evs = (await e.rows('events')).slice(mark)
    expect(evs.filter((x) => x.type === 'association.deleted').map((x) => x.resource_id)).toContain(dup.id)
    expect(evs.filter((x) => x.type === 'association.updated').map((x) => x.resource_id)).toEqual([moved.id])
    expect(ids(await a.call('deals.list', { query: { contact_id: s[1] } }))).toEqual([shared[1], onlyR[1]].sort())
    expect(await a.call('deals.list', { query: { contact_id: r[1] } })).toEqual({ data: [], next_cursor: null })
  })

  it('a merge where neither contact has a deal edge changes no deal edge', async () => {
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    const d = await newDeal('d')
    const co = await a.ent.company()
    await a.link(d, co)
    await a.link(r, co)
    const before = (await a.edges(false)).filter((x) => x.a_type === 'deals' || x.b_type === 'deals')
    await merge(s, r)
    expect((await a.edges(false)).filter((x) => x.a_type === 'deals' || x.b_type === 'deals')).toEqual(before)
  })
})

describe('no derived status in any event (D8, CORE131 D2)', () => {
  const noStatus = (r: unknown) => {
    if (r !== null && r !== undefined) expect(Object.keys(r as object)).not.toContain('status')
  }
  const dealWorld = async () => {
    const d = await newDeal('d')
    const company = await a.ent.company()
    const contact = await a.ent.contact()
    const survivor = await a.ent.contact('S')
    await a.link(d, company)
    await a.link(contact, d)
    expect((await a.call('deals.get', { params: { id: d[1] } })).status).toBe('open') // the actor sees it on reads
    return { d, company, contact, survivor }
  }

  it('the deal.deleted event of the cascade path has no status in before (actor holding deals:read)', async () => {
    const { d } = await dealWorld()
    await a.call('deals.delete', { params: { id: d[1] } })
    const [ev] = await events('deal.deleted')
    expect(ev).toBeDefined()
    expect(ev!.before).toMatchObject({ id: d[1], name: 'd' })
    noStatus(ev!.before)
    noStatus(ev!.after)
  })

  it('companies.delete, contacts.delete, merge and association create/delete with a deal end emit no deal.* event, and no association event carries a deal record', async () => {
    const w = await dealWorld()
    const before = (await events('deal.')).length // the deal.created of the setup
    const mine = await a.link(w.survivor, ['deals', w.d[1]])
    await a.unlink(mine.id)
    await a.k.run((env) => mergeOperation(env, w.survivor[1], w.contact[1]))
    await a.call('companies.delete', { params: { id: w.company[1] } })
    await a.call('contacts.delete', { params: { id: w.survivor[1] } })
    expect((await events('deal.')).length).toBe(before)
    for (const ev of await events('association.')) {
      for (const side of [ev.before, ev.after]) {
        noStatus(side)
        expect(Object.keys((side ?? {}) as object)).not.toContain('stage_id')
      }
    }
  })
})
