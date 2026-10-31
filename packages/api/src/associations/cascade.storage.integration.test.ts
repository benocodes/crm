import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mergeOperation } from '../identity/merge.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE62 D15 and D16 on D1: deleting an associable endpoint soft-deletes its live edges on both sides in the same unit, and a
// contact merge re-points them. The cascades keep their guards (planned set, exactly(n), "none left"), and every change has its event.
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
const live = async () => (await a.edges()).map((r) => r.id as string).sort()
const del = (type: 'contacts' | 'companies' | 'tasks', id: string) => a.call(`${type}.delete`, { params: { id } })

/** Each parent type, with a partner of the same type so the parent is stored on side a for one edge and side b for another. */
const PARENTS = [
  { type: 'contacts' as const, make: () => a.ent.contact('P'), other: () => a.ent.contact('Q'), row: 'contacts' },
  { type: 'companies' as const, make: () => a.ent.company('P'), other: () => a.ent.company('Q'), row: 'companies' },
  { type: 'tasks' as const, make: () => a.ent.task('P'), other: () => a.ent.task('Q'), row: 'tasks' },
]

describe.each(PARENTS)('$type.delete cascades the edges (D15)', ({ type, make, other, row }) => {
  it('soft-deletes the live edges on the a side and the b side, one association.deleted each, in the same unit', async () => {
    // ids are time-ordered and the kit's clock ticks: a partner made before the parent sorts below it, one made after sorts above
    const lo = await other()
    const p = await make()
    const hi = await other()
    const onB = await a.link(lo, p) // parent stored on side b
    const onA = await a.link(p, hi) // parent stored on side a
    const cross = type === 'tasks' ? await a.link(await a.ent.contact(), p) : await a.link(p, await a.ent.task())
    const unrelated = await a.link(lo, hi)
    const mark = (await e.rows('events')).length
    await del(type, p[1])
    expect(await live()).toEqual([unrelated.id])
    const rows = await a.edges(false)
    const at = (rows.find((r) => r.id === onA.id) as Rec).deleted_at
    for (const r of [onA, onB, cross]) expect(rows.find((x) => x.id === r.id)).toMatchObject({ deleted_at: at, updated_at: at })
    const evs = (await e.rows('events')).slice(mark)
    expect(evs[0]).toMatchObject({ type: `${row === 'tasks' ? 'task' : row === 'contacts' ? 'contact' : 'company'}.deleted`, resource_id: p[1] })
    const edgeEvents = evs.filter((x) => x.type === 'association.deleted')
    expect(edgeEvents.map((x) => x.resource_id).sort()).toEqual([onA.id, onB.id, cross.id].sort())
    for (const ev of edgeEvents) {
      expect(ev).toMatchObject({ actor_id: e.userId, after: null, created_at: at, resource_type: 'association' })
      expect(ev.before).toEqual([onA, onB, cross].find((x) => x.id === ev.resource_id))
    }
    expect(evs.filter((x) => x.type.startsWith('association.'))).toHaveLength(3)
  })

  it('an endpoint with no edges deletes with no association events', async () => {
    const p = await make()
    const mark = (await e.rows('events')).length
    await del(type, p[1])
    expect((await e.rows('events')).slice(mark).filter((x) => x.type.startsWith('association.'))).toEqual([])
    expect((await e.rows(row)).find((r) => r.id === p[1])!.deleted_at).not.toBeNull()
  })

  it('an edge added between plan and commit aborts the whole unit (the none-left guard)', async () => {
    const p = await make()
    const q = await other()
    const keep = await a.link(p, q)
    const r = await other()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => {
      await e.insert('associations', { a_type: type, a_id: p[1], b_type: type, b_id: r[1], relation: 'related_to' })
    })
    const err = await a.call(`${type}.delete`, { params: { id: p[1] } }).then(() => undefined, (x: unknown) => x)
    expect(err).toBeDefined()
    expect((await e.rows(row)).find((r) => r.id === p[1])!.deleted_at).toBeNull()
    expect((await a.edges()).find((r) => r.id === keep.id)).toBeDefined()
    expect((await a.edges()).every((r) => r.deleted_at === null)).toBe(true)
    expect((await e.rows('events')).length).toBe(mark)
  })
})

describe('the set limit', () => {
  it.each(['contacts', 'companies', 'tasks'] as const)('%s.delete with more live edges than the set limit is 400 set_limit_exceeded and changes nothing', async (type) => {
    const small = await openD1Engine({ maxSetSize: 2 })
    try {
      const k = assocKit(small)
      const p = await k.ent[type === 'contacts' ? 'contact' : type === 'companies' ? 'company' : 'task']()
      const ids: string[] = []
      for (let i = 0; i < 3; i++) ids.push((await k.link(p, await k.ent.thread())).id)
      const mark = (await small.rows('events')).length
      const err = await k.fail(`${type}.delete`, { params: { id: p[1] } })
      expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
      expect((await small.rows(type)).find((r) => r.id === p[1])!.deleted_at).toBeNull()
      expect(await k.edges()).toHaveLength(3)
      expect((await small.rows('events')).length).toBe(mark)
    } finally {
      await small.close()
    }
  })
})

describe('contacts.merge re-points the edges (D16)', () => {
  const merge = (survivor: Ent, source: Ent) => a.k.run((env) => mergeOperation(env, survivor[1], source[1]))
  const assocEvents = async (mark: number) => (await e.rows('events')).slice(mark).filter((x) => x.type.startsWith('association.'))

  it('soft-deletes the source-survivor edge and an edge duplicating a live survivor edge; re-points the rest with association.updated', async () => {
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    const co = await a.ent.company()
    const t1 = await a.ent.task()
    const t2 = await a.ent.task()
    const direct = await a.link(s, r)
    const survivorCompany = await a.link(s, co)
    const dupCompany = await a.link(r, co)
    const survivorTask = await a.link(s, t1)
    const moving = await a.link(r, t2)
    const mark = (await e.rows('events')).length
    await merge(s, r)
    expect(await live()).toEqual([survivorCompany.id, survivorTask.id, moving.id].sort())
    const rows = await a.edges(false)
    const byId = (id: string) => rows.find((x) => x.id === id) as Rec
    expect(byId(direct.id).deleted_at).not.toBeNull()
    expect(byId(dupCompany.id).deleted_at).not.toBeNull()
    expect(byId(moving.id)).toMatchObject({ a_type: 'contacts', a_id: s[1], b_type: 'tasks', b_id: t2[1], deleted_at: null })
    const evs = await assocEvents(mark)
    expect(evs.filter((x) => x.type === 'association.deleted').map((x) => x.resource_id).sort()).toEqual([direct.id, dupCompany.id].sort())
    const upd = evs.filter((x) => x.type === 'association.updated')
    expect(upd.map((x) => x.resource_id)).toEqual([moving.id])
    expect(upd[0]!.before).toEqual(moving)
    expect(upd[0]!.after).toMatchObject({ id: moving.id, a_type: 'contacts', a_id: s[1], b_type: 'tasks', b_id: t2[1] })
    expect(upd[0]).toMatchObject({ actor_id: e.userId })
    expect(evs).toHaveLength(3)
    // the survivor now reads the moved edge
    expect((await a.list('contacts', s[1])).data.map((x) => x.neighbour_id).sort()).toEqual([co[1], t1[1], t2[1]].sort())
    expect((await a.list('contacts', r[1])).data).toEqual([])
  })

  it('a contact-to-contact edge whose order flips after re-pointing is re-canonicalised', async () => {
    // ids are time-ordered: source R < X < survivor S, so R-X is stored (R, X) and becomes (X, S) after the re-point
    const r = await a.ent.contact('R')
    const x = await a.ent.contact('X')
    const s = await a.ent.contact('S')
    const edge = await a.link(r, x)
    expect([edge.a_id, edge.b_id]).toEqual([r[1], x[1]])
    await merge(s, r)
    const row = (await a.edges()).find((q) => q.id === edge.id) as Rec
    expect([row.a_id, row.b_id]).toEqual([x[1], s[1]])
    expect(`${row.a_type}:${row.a_id}` < `${row.b_type}:${row.b_id}`).toBe(true)
    expect((await a.list('contacts', s[1])).data.map((q) => q.neighbour_id)).toEqual([x[1]])
    expect((await a.list('contacts', x[1])).data.map((q) => q.neighbour_id)).toEqual([s[1]])
  })

  it('a source with no edges merges with no association events', async () => {
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    const t = await a.ent.task()
    await a.link(s, t)
    const mark = (await e.rows('events')).length
    await merge(s, r)
    expect(await assocEvents(mark)).toEqual([])
    expect(await live()).toHaveLength(1)
  })

  it('leaves no live edge on the source, even when a survivor edge is added between plan and commit', async () => {
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    const co = await a.ent.company()
    const dup = await a.link(r, co)
    const mark = (await e.rows('events')).length
    // plan sees no survivor edge to the company, so it would re-point `dup`; the survivor edge then appears
    e.betweenPlanAndCommit(async () => {
      await e.insert('associations', { a_type: 'companies', a_id: co[1], b_type: 'contacts', b_id: s[1], relation: 'related_to' })
    })
    const err = await a.k.run((env) => mergeOperation(env, s[1], r[1])).then(() => undefined, (x: unknown) => x)
    expect(err).toBeDefined()
    expect((await e.rows('contacts')).find((c) => c.id === r[1])!.deleted_at).toBeNull()
    expect((await a.edges()).find((q) => q.id === dup.id)).toMatchObject({ a_id: co[1], b_id: r[1] })
    expect((await e.rows('events')).length).toBe(mark)
  })
})
