import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openD1Engine, type Engine } from '../test/engines.js'
import { ALL_READ, NO_MESSAGES, assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE74 on D1 (the oracle; Postgres has no `notes` table, CORE62 D22): the notes resource, its events and attribution,
// association with the other built-in records, the delete cascade, and `include=associations` on get.
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

const create = (body: Rec, opts?: Parameters<AssocKit['call']>[2]) => a.call('notes.create', { body }, opts)
const bad = async (body: Rec) => {
  const err = await a.fail('notes.create', { body })
  return [err.status, err.code]
}
const noteEvents = async () => (await e.rows('events')).filter((x) => String(x.type).startsWith('note.'))

describe('notes validation (D17)', () => {
  it.each([
    ['empty content', { content: '' }],
    ['content of 100 001 characters', { content: 'x'.repeat(100_001) }],
    ['title of 501 characters', { content: 'c', title: 'x'.repeat(501) }],
    ['an unknown field', { content: 'c', colour: 'red' }],
    ['created_by in the input', { content: 'c', created_by: '0190a0a0-0000-7000-8000-000000000000' }],
    ['organization_id in the input', { content: 'c', organization_id: '0190a0a0-0000-7000-8000-000000000000' }],
    ['no content', { title: 't' }],
  ])('refuses %s with 400 validation_error', async (_n, body) => {
    expect(await bad(body as Rec)).toEqual([400, 'validation_error'])
    expect(await e.rows('notes')).toEqual([])
    expect(await noteEvents()).toEqual([])
  })

  it('accepts 100 000 characters of Markdown, a 500 character title and a null title', async () => {
    const big = await create({ content: '# h\n'.padEnd(100_000, 'x'), title: 'x'.repeat(500) })
    expect(big.content).toHaveLength(100_000)
    const untitled = await create({ content: 'only a body' })
    expect(untitled.title).toBeNull()
  })

  it('update validates the same way and takes no created_by', async () => {
    const n = await create({ content: 'c' })
    for (const body of [{ content: '' }, { title: 'x'.repeat(501) }, { created_by: n.created_by }]) {
      const err = await a.fail('notes.update', { params: { id: n.id }, body })
      expect([err.status, err.code]).toEqual([400, 'validation_error'])
    }
  })
})

describe('notes events and attribution (D8, D17)', () => {
  it('create, update and delete each emit exactly one note.* event with the editor as actor', async () => {
    const n = await create({ title: 't', content: 'c' })
    expect(n).toMatchObject({ organization_id: e.organizationId, created_by: e.userId, title: 't', content: 'c' })
    expect(Object.keys(n).sort()).toEqual(['content', 'created_at', 'created_by', 'id', 'organization_id', 'title', 'updated_at'])
    const upd = await a.call('notes.update', { params: { id: n.id }, body: { content: 'edited' } }, { as: 'agent' })
    expect(upd).toMatchObject({ content: 'edited', created_by: e.userId })
    await a.call('notes.delete', { params: { id: n.id } })
    const evs = await noteEvents()
    expect(evs.map((x) => [x.type, x.actor_id, x.resource_id])).toEqual([
      ['note.created', e.userId, n.id],
      ['note.updated', e.agentId, n.id],
      ['note.deleted', e.userId, n.id],
    ])
    expect(evs[0]!.after).toEqual(n)
    expect(evs[1]!.before).toEqual(n)
    expect(evs[1]!.after).toEqual(upd)
    expect(evs[2]!.after).toBeNull()
  })

  it('created_by and organization_id come from the caller and the deployment, and an update leaves them unchanged', async () => {
    const n = await create({ content: 'c' }, { as: 'agent' })
    expect(n).toMatchObject({ created_by: e.agentId, organization_id: e.organizationId })
    const after = await a.call('notes.update', { params: { id: n.id }, body: { title: 'x' } })
    expect(after).toMatchObject({ created_by: e.agentId, organization_id: e.organizationId })
    expect((await e.rows('notes'))[0]).toMatchObject({ created_by: e.agentId })
  })

  it('list filters by created_by', async () => {
    const mine = await create({ content: 'm' })
    await create({ content: 'a' }, { as: 'agent' })
    const r = await a.call('notes.list', { query: { created_by: e.userId } })
    expect(r.data.map((x: Rec) => x.id)).toEqual([mine.id])
  })
})

describe('notes are associable (D9)', () => {
  it.each(['contact', 'company', 'task', 'thread', 'interaction'] as const)('a note links to a %s and each lists the other', async (kind) => {
    const note = await a.ent.note()
    const other = await a.ent[kind]()
    const edge = await a.link(note, other)
    expect(edge).toMatchObject({ created_by: e.userId })
    expect((await a.list('notes', note[1])).data).toEqual([expect.objectContaining({ id: edge.id, neighbour_type: other[0], neighbour_id: other[1] })])
    expect((await a.list(other[0], other[1])).data).toEqual([expect.objectContaining({ id: edge.id, neighbour_type: 'notes', neighbour_id: note[1] })])
  })

  it('a caller without notes:read cannot link a note (403) and does not see note edges in a list', async () => {
    const note = await a.ent.note()
    const c = await a.ent.contact()
    const noRead = ALL_READ.filter((s) => s !== 'notes:read')
    const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'notes', b_id: note[1] } }, { as: 'agent', scopes: noRead })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('notes:read')
    await a.link(c, note)
    expect((await a.list('contacts', c[1], {}, { as: 'agent', scopes: noRead })).data).toEqual([])
    expect((await a.list('contacts', c[1])).data).toHaveLength(1)
  })
})

describe('notes.delete cascades the edges (D15)', () => {
  it('soft-deletes the live edges on both sides with one association.deleted each, in the same unit', async () => {
    // 'contacts' < 'notes' < 'tasks': the note is side b of the first edge and side a of the second
    const note = await a.ent.note()
    const onB = await a.link(await a.ent.contact(), note)
    const onA = await a.link(note, await a.ent.task())
    const unrelated = await a.link(await a.ent.contact(), await a.ent.task())
    const mark = (await e.rows('events')).length
    await a.call('notes.delete', { params: { id: note[1] } })
    expect((await a.edges()).map((r) => r.id)).toEqual([unrelated.id])
    const evs = (await e.rows('events')).slice(mark)
    expect(evs[0]).toMatchObject({ type: 'note.deleted', resource_id: note[1] })
    const edgeEvents = evs.filter((x) => x.type === 'association.deleted')
    expect(edgeEvents.map((x) => x.resource_id).sort()).toEqual([onA.id, onB.id].sort())
    expect(evs).toHaveLength(3)
    const rows = await a.edges(false)
    const at = (rows.find((r) => r.id === onA.id) as Rec).deleted_at
    expect(at).not.toBeNull()
    expect(evs.every((x) => x.created_at === at)).toBe(true)
    expect((await e.rows('notes'))[0]!.deleted_at).toBe(at)
  })

  it('a note with no edges deletes cleanly with only its own event', async () => {
    const note = await a.ent.note()
    const mark = (await e.rows('events')).length
    await a.call('notes.delete', { params: { id: note[1] } })
    const evs = (await e.rows('events')).slice(mark)
    expect(evs.map((x) => x.type)).toEqual(['note.deleted'])
  })

  it('more live edges than the set limit is 400 set_limit_exceeded and changes nothing', async () => {
    const small = await openD1Engine({ maxSetSize: 2 })
    try {
      const k = assocKit(small)
      const note = await k.ent.note()
      for (let i = 0; i < 3; i++) await k.link(note, await k.ent.thread())
      const mark = (await small.rows('events')).length
      const err = await k.fail('notes.delete', { params: { id: note[1] } })
      expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
      expect((await small.rows('notes'))[0]!.deleted_at).toBeNull()
      expect(await k.edges()).toHaveLength(3)
      expect((await small.rows('events')).length).toBe(mark)
    } finally {
      await small.close()
    }
  })
})

describe('get with include=associations (D6)', () => {
  const get = (name: string, id: string, query: Rec = { include: 'associations' }, opts?: Parameters<AssocKit['call']>[2]) => a.call(name, { params: { id }, query }, opts)
  const KINDS = [
    ['contacts', 'contact'],
    ['companies', 'company'],
    ['tasks', 'task'],
    ['notes', 'note'],
    ['threads', 'thread'],
    ['interactions', 'interaction'],
  ] as const

  it.each(KINDS)('%s: a record with no edges returns [] and associations_truncated false', async (type, kind) => {
    const rec = await a.ent[kind]()
    const r = await get(`${type}.get`, rec[1])
    expect(r.associations).toEqual([])
    expect(r.associations_truncated).toBe(false)
  })

  it.each(KINDS)('%s: without the parameter the response has neither field', async (type, kind) => {
    const rec = await a.ent[kind]()
    await a.link(rec, await a.ent[kind === 'task' ? 'contact' : 'task']())
    const r = await get(`${type}.get`, rec[1], {})
    expect(Object.keys(r)).not.toContain('associations')
    expect(Object.keys(r)).not.toContain('associations_truncated')
  })

  it('lists oriented items, newest first, with deleted edges absent', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const n = await a.ent.note()
    const e1 = await a.link(c, t)
    const e2 = await a.link(n, c)
    const gone = await a.link(c, await a.ent.company())
    await a.unlink(gone.id)
    const r = await get('contacts.get', c[1])
    expect(r.associations.map((x: Rec) => x.id)).toEqual([e2.id, e1.id])
    expect(r.associations[0]).toEqual({ id: e2.id, relation: 'related_to', neighbour_type: 'notes', neighbour_id: n[1], created_by: e.userId, created_at: e2.created_at })
    expect(r.associations[1]).toMatchObject({ neighbour_type: 'tasks', neighbour_id: t[1] })
    expect(r.associations_truncated).toBe(false)
  })

  it('caps at the 50 newest visible edges: false at exactly 50, true at 51', async () => {
    const c = await a.ent.contact()
    const ids: string[] = []
    for (let i = 0; i < 50; i++) ids.push((await a.link(c, await a.ent.task())).id)
    let r = await get('contacts.get', c[1])
    expect(r.associations).toHaveLength(50)
    expect(r.associations_truncated).toBe(false)
    const newest = (await a.link(c, await a.ent.task())).id
    r = await get('contacts.get', c[1])
    expect(r.associations).toHaveLength(50)
    expect(r.associations_truncated).toBe(true)
    expect(r.associations[0].id).toBe(newest)
    expect(r.associations.map((x: Rec) => x.id)).not.toContain(ids[0])
  })

  it('filters neighbour types the caller cannot read before the cap', async () => {
    const c = await a.ent.contact()
    for (let i = 0; i < 50; i++) await a.link(c, await a.ent.task())
    for (let i = 0; i < 3; i++) await a.link(c, await a.ent.thread()) // the newest edges, unreadable below
    const r = await get('contacts.get', c[1], { include: 'associations' }, { as: 'agent', scopes: NO_MESSAGES })
    expect(r.associations).toHaveLength(50)
    expect(r.associations.every((x: Rec) => x.neighbour_type === 'tasks')).toBe(true)
    expect(r.associations_truncated).toBe(false)
    await a.link(c, await a.ent.task())
    const more = await get('contacts.get', c[1], { include: 'associations' }, { as: 'agent', scopes: NO_MESSAGES })
    expect(more.associations_truncated).toBe(true)
    // the full-scope caller sees the threads
    const all = await get('contacts.get', c[1])
    expect(all.associations.filter((x: Rec) => x.neighbour_type === 'threads')).toHaveLength(3)
  })

  it('without associations:read it is 403 insufficient_scope naming associations:read', async () => {
    const c = await a.ent.contact()
    const err = await a.fail('contacts.get', { params: { id: c[1] }, query: { include: 'associations' } }, { as: 'agent', scopes: ALL_READ.filter((s) => s !== 'associations:read') })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('associations:read')
    // without the parameter the same caller is fine
    expect((await a.call('contacts.get', { params: { id: c[1] } }, { as: 'agent', scopes: ALL_READ.filter((s) => s !== 'associations:read') })).id).toBe(c[1])
  })
})
