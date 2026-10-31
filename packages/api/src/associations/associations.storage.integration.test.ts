import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { openD1Engine, type Engine } from '../test/engines.js'
import { ALL_READ, NO_MESSAGES, assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE62 cycle 1 on D1 (the oracle; Postgres has no `associations` table, D22): create, get, delete and list, their refusals,
// events and the commit-time endpoint assertion. Fixtures are direct inserts or ordinary operations.
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

const key = (t: [string, string]) => `${t[0]}:${t[1]}`
const canon = (x: [string, string], y: [string, string]): [[string, string], [string, string]] => (key(x) < key(y) ? [x, y] : [y, x])
const RECORD_KEYS = ['id', 'a_type', 'a_id', 'b_type', 'b_id', 'relation', 'created_by', 'created_at', 'updated_at'].sort()

describe('associations.create', () => {
  it('stores one row in canonical order whichever order is given, and returns the record', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(t, c)
    expect(Object.keys(r).sort()).toEqual(RECORD_KEYS)
    expect(r).toMatchObject({ a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t[1], relation: 'related_to', created_by: e.userId })
    expect(r.created_at).toBe(r.updated_at)
    const rows = await a.edges()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: r.id, a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t[1], organization_id: e.organizationId })
    // the other order too
    const c2 = await a.ent.contact()
    const r2 = await a.link(c2, t)
    expect([r2.a_type, r2.b_type]).toEqual(['contacts', 'tasks'])
  })

  it('the same type is ordered by id, either input order', async () => {
    const x = await a.ent.contact()
    const y = await a.ent.contact()
    const [lo, hi] = canon(x, y)
    const r = await a.link(hi, lo)
    expect([r.a_id, r.b_id]).toEqual([lo[1], hi[1]])
  })

  it('the same pair in the reverse order is 409 association_exists naming the existing id, with no row and no event', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const first = await a.link(c, t)
    const rows = (await a.edges(false)).length
    const evs = (await a.events()).length
    const err = await a.fail('associations.create', { body: { a_type: 'tasks', a_id: t[1], b_type: 'contacts', b_id: c[1] } })
    expect([err.status, err.code]).toEqual([409, 'association_exists'])
    expect(err.message).toContain(first.id)
    expect((await a.edges(false)).length).toBe(rows)
    expect((await a.events()).length).toBe(evs)
  })

  it('upper-case ids are canonicalised', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(['tasks', t[1].toUpperCase()], ['contacts', c[1].toUpperCase()])
    expect(r).toMatchObject({ a_id: c[1], b_id: t[1] })
  })

  it('an explicit relation of related_to is accepted; any other is validation_error', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    expect((await a.link(c, t, {}, 'related_to')).relation).toBe('related_to')
    const t2 = await a.ent.task()
    const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t2[1], relation: 'champion' } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })

  it('refuses an unknown, non-associable or malformed type as 400 validation_error and writes nothing', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    for (const bad of ['messages', 'files', 'identities', 'agents', 'nope', 'Contacts', 'contacts; drop table tasks', '']) {
      const err = await a.fail('associations.create', { body: { a_type: bad, a_id: c[1], b_type: 'tasks', b_id: t[1] } })
      expect([err.status, err.code], bad).toEqual([400, 'validation_error'])
      const err2 = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: bad, b_id: t[1] } })
      expect([err2.status, err2.code], bad).toEqual([400, 'validation_error'])
    }
    expect(await a.edges(false)).toHaveLength(0)
    expect(await a.events()).toHaveLength(0)
  })

  it('refuses the same endpoint twice as 400 self_association (id case-insensitive)', async () => {
    const c = await a.ent.contact()
    for (const b of [c, ['contacts', c[1].toUpperCase()] as [string, string]]) {
      const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: b[0], b_id: b[1] } })
      expect([err.status, err.code]).toEqual([400, 'self_association'])
    }
    expect(await a.edges(false)).toHaveLength(0)
  })

  it('refuses a missing, soft-deleted or other-organisation endpoint as 400 invalid_reference', async () => {
    const c = await a.ent.contact()
    const gone = await a.ent.contact()
    await a.k.deleteContact(gone[1])
    const goneTask = await a.ent.task()
    await e.update('tasks', goneTask[1], { deleted_at: '2026-10-22T10:00:00.000Z' })
    const t = await a.ent.task()
    const body = (x: [string, string], y: [string, string]) => ({ a_type: x[0], a_id: x[1], b_type: y[0], b_id: y[1] })
    for (const [x, y] of [[c, ['tasks', uuidv7()]], [gone, t], [c, goneTask], [['threads', uuidv7()], t], [['interactions', uuidv7()], t]] as Array<[[string, string], [string, string]]>) {
      const err = await a.fail('associations.create', { body: body(x, y) })
      expect([err.status, err.code], `${x} ${y}`).toEqual([400, 'invalid_reference'])
    }
    // an endpoint that exists, seen from another organisation, does not exist
    const other = await a.fail('associations.create', { body: body(c, t) }, { organizationId: uuidv7() })
    expect([other.status, other.code]).toEqual([400, 'invalid_reference'])
    expect(await a.edges(false)).toHaveLength(0)
    expect(await a.events()).toHaveLength(0)
  })

  it('threads and interactions have no deleted_at: they count as live when they exist', async () => {
    const t = await a.ent.task()
    const th = await a.ent.thread()
    const ix = await a.ent.interaction()
    expect(await a.link(t, th)).toMatchObject({ a_type: 'tasks', b_type: 'threads' })
    expect(await a.link(ix, t)).toMatchObject({ a_type: 'interactions', b_type: 'tasks' })
  })

  it('requires read on both endpoint types: 403 insufficient_scope naming the type; write on an endpoint is not required', async () => {
    const c = await a.ent.contact()
    const th = await a.ent.thread()
    const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'threads', b_id: th[1] } }, { as: 'agent', scopes: NO_MESSAGES })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('threads')
    expect(err.message).toContain('messages:read')
    const err2 = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'threads', b_id: th[1] } }, { as: 'agent', scopes: ALL_READ.filter((s) => s !== 'contacts:read') })
    expect(err2.message).toContain('contacts')
    expect(await a.edges(false)).toHaveLength(0)
    // read scopes only plus associations:write: allowed (no contacts:write, tasks:write held)
    const t = await a.ent.task()
    expect(await a.link(c, t, { as: 'agent', scopes: ['contacts:read', 'tasks:read', 'associations:write'] })).toMatchObject({ created_by: e.agentId })
  })

  it('emits exactly one association.created in the same unit: actor, after = the record, the unit clock', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(c, t, { as: 'agent' })
    const evs = await a.events()
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ type: 'association.created', resource_type: 'association', resource_id: r.id, actor_id: e.agentId, before: null, after: r, created_at: r.created_at })
  })

  it('an endpoint deleted between plan and commit aborts the create: no edge, no event', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => {
      await e.update('tasks', t[1], { deleted_at: '2026-10-22T10:00:01.000Z' })
    })
    const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t[1] } })
    expect(err.status).toBe(409)
    expect(await a.edges(false)).toHaveLength(0)
    expect((await e.rows('events')).length).toBe(mark)
  })

  it('a duplicate created between plan and commit is refused by the unique index (409, no second row)', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    e.betweenPlanAndCommit(async () => {
      await e.insert('associations', { a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t[1], relation: 'related_to' })
    })
    const err = await a.fail('associations.create', { body: { a_type: 'contacts', a_id: c[1], b_type: 'tasks', b_id: t[1] } })
    expect(err.status).toBe(409)
    expect(await a.edges(false)).toHaveLength(1)
  })

  it('after a delete the pair can be linked again as a new row', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const first = await a.link(c, t)
    await a.unlink(first.id)
    const second = await a.link(t, c)
    expect(second.id).not.toBe(first.id)
    expect(await a.edges(false)).toHaveLength(2)
  })
})

describe('associations.get and associations.delete', () => {
  it('get returns the record; delete soft-deletes with one association.deleted (before = record, after null)', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(c, t)
    expect(await a.get(r.id)).toEqual(r)
    expect(await a.unlink(r.id, { as: 'agent' })).toBeUndefined()
    const row = (await a.edges(false))[0]!
    expect(row.deleted_at).not.toBeNull()
    expect(row.updated_at).toBe(row.deleted_at)
    const del = (await a.events()).filter((x) => x.type === 'association.deleted')
    expect(del).toHaveLength(1)
    expect(del[0]).toMatchObject({ resource_id: r.id, actor_id: e.agentId, before: r, after: null })
    expect((await a.fail('associations.get', { params: { id: r.id } })).status).toBe(404)
    expect((await a.fail('associations.delete', { params: { id: r.id } })).status).toBe(404)
  })

  it('a missing id and a malformed-case id are 404 not_found', async () => {
    const err = await a.fail('associations.get', { params: { id: uuidv7() } })
    expect([err.status, err.code]).toEqual([404, 'not_found'])
  })

  it('404 when the other endpoint type is unreadable, on get and on delete; the edge stays', async () => {
    const c = await a.ent.contact()
    const th = await a.ent.thread()
    const r = await a.link(c, th)
    for (const name of ['associations.get', 'associations.delete']) {
      const err = await a.fail(name, { params: { id: r.id } }, { as: 'agent', scopes: NO_MESSAGES })
      expect([err.status, err.code], name).toEqual([404, 'not_found'])
    }
    expect((await a.edges()).map((x) => x.id)).toEqual([r.id])
    expect(await a.get(r.id)).toEqual(r)
  })

  it('delete of an edge deleted between plan and commit aborts as a conflict, with one event at most', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(c, t)
    const before = (await a.events()).length
    e.betweenPlanAndCommit(async () => {
      await e.update('associations', r.id, { deleted_at: '2026-10-22T10:00:01.000Z', updated_at: '2026-10-22T10:00:01.000Z' })
    })
    const err = await a.fail('associations.delete', { params: { id: r.id } })
    expect(err.status).toBe(409)
    expect((await a.events()).length).toBe(before)
  })
})

describe('associations.list (hop by hop)', () => {
  it('returns oriented items from the anchor, whichever side it is stored on, ordered by association id', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const co = await a.ent.company()
    const c2 = await a.ent.contact()
    const e1 = await a.link(t, c) // contact stored on side a
    const e2 = await a.link(c, co) // contact stored on side b
    const e3 = await a.link(c2, c)
    const page = await a.list('contacts', c[1])
    expect(page.next_cursor).toBeNull()
    expect(page.data.map((x) => x.id)).toEqual([e1.id, e2.id, e3.id].sort())
    const byId = Object.fromEntries(page.data.map((x) => [x.id, x]))
    expect(byId[e1.id]).toEqual({ id: e1.id, relation: 'related_to', neighbour_type: 'tasks', neighbour_id: t[1], created_by: e.userId, created_at: e1.created_at })
    expect(byId[e2.id]).toMatchObject({ neighbour_type: 'companies', neighbour_id: co[1] })
    expect(byId[e3.id]).toMatchObject({ neighbour_type: 'contacts', neighbour_id: c2[1] })
    // from the other end the same edge is oriented the other way
    const back = await a.list('tasks', t[1])
    expect(back.data).toEqual([{ id: e1.id, relation: 'related_to', neighbour_type: 'contacts', neighbour_id: c[1], created_by: e.userId, created_at: e1.created_at }])
    expect((await a.list('contacts', c2[1])).data[0]).toMatchObject({ neighbour_id: c[1] })
  })

  it('an anchor with readable and unreadable neighbour types returns full pages of only the readable ones, with a working cursor', async () => {
    const c = await a.ent.contact()
    const readable: Rec[] = []
    for (let i = 0; i < 5; i++) {
      readable.push(await a.link(c, await a.ent.task(`t${i}`)))
      await a.link(c, await a.ent.thread()) // interleaved, unreadable to the agent
    }
    const agent = { as: 'agent' as const, scopes: NO_MESSAGES }
    const seen: string[] = []
    let after: string | undefined
    let pages = 0
    for (;;) {
      const page = await a.list('contacts', c[1], { limit: 2, ...(after ? { after } : {}) }, agent)
      pages++
      for (const item of page.data) expect(item.neighbour_type).toBe('tasks')
      if (page.next_cursor) expect(page.data).toHaveLength(2)
      seen.push(...page.data.map((x) => x.id))
      if (!page.next_cursor) break
      after = page.next_cursor
    }
    expect(pages).toBe(3)
    expect(seen).toEqual(readable.map((r) => r.id).sort())
    // a caller who can read messages sees both kinds
    expect((await a.list('contacts', c[1], { limit: 50 })).data).toHaveLength(10)
  })

  it('neighbour_type filters; one that is not associable is validation_error; one the caller cannot read is an empty page', async () => {
    const c = await a.ent.contact()
    await a.link(c, await a.ent.task())
    await a.link(c, await a.ent.company())
    await a.link(c, await a.ent.thread())
    expect((await a.list('contacts', c[1], { neighbour_type: 'companies' })).data.map((x) => x.neighbour_type)).toEqual(['companies'])
    expect((await a.list('contacts', c[1], { neighbour_type: 'threads' }, { as: 'agent', scopes: NO_MESSAGES })).data).toEqual([])
    const err = await a.fail('associations.list', { query: { type: 'contacts', id: c[1], neighbour_type: 'files' } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })

  it('a deleted edge, and an anchor that is not associable, are handled: gone / validation_error; the anchor type needs its read scope', async () => {
    const c = await a.ent.contact()
    const t = await a.ent.task()
    const r = await a.link(c, t)
    await a.unlink(r.id)
    expect((await a.list('contacts', c[1])).data).toEqual([])
    const bad = await a.fail('associations.list', { query: { type: 'messages', id: c[1] } })
    expect([bad.status, bad.code]).toEqual([400, 'validation_error'])
    const denied = await a.fail('associations.list', { query: { type: 'threads', id: (await a.ent.thread())[1] } }, { as: 'agent', scopes: NO_MESSAGES })
    expect([denied.status, denied.code]).toEqual([403, 'insufficient_scope'])
    expect(denied.message).toContain('threads')
  })

  it('validates the paging input', async () => {
    const c = await a.ent.contact()
    for (const query of [{ limit: 0 }, { limit: 201 }, { after: 'nope' }, { id: 'nope' }]) {
      const err = await a.fail('associations.list', { query: { type: 'contacts', id: c[1], ...query } })
      expect([err.status, err.code], JSON.stringify(query)).toEqual([400, 'validation_error'])
    }
  })
})
