import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { splitArguments } from '../mcp/tools.js'
import { mergeOperation } from '../identity/merge.js'
import { uuidv7 } from '@vault/storage'
import { openD1Engine, type Engine } from '../test/engines.js'
import { assocKit, type AssocKit, type Rec } from '../test/assoc-kit.js'

// CORE129 on D1 (the oracle): the `tags` resource, its name rules, events, the taggable set, the `tag_id` list filter on
// companies, contacts and tasks (both canonical sides, live edges only, scopes), the delete cascade and the merge re-pointing.
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
const create = (body: Rec, opts?: Parameters<AssocKit['call']>[2]) => a.call('tags.create', { body }, opts)
const failure = async (name: string, input: Parameters<AssocKit['fail']>[1], opts?: Parameters<AssocKit['fail']>[2]) => {
  const err = await a.fail(name, input, opts)
  return [err.status, err.code, err.message] as const
}
const tagEvents = async () => (await e.rows('events')).filter((x) => String(x.type).startsWith('tag.'))
const assocEvents = async () => (await e.rows('events')).filter((x) => String(x.type).startsWith('association.'))
const ids = (page: { data: Rec[] }) => page.data.map((r) => r.id as string).sort()

describe('tags validation and shape (D3, D4, D5, D13)', () => {
  it('creates a tag in the record shape, trimmed, attributed to the caller', async () => {
    const t = await create({ name: '  Prospects  ', description: ' GTM list ' })
    expect(t).toMatchObject({ organization_id: e.organizationId, created_by: e.userId, name: 'Prospects', description: 'GTM list' })
    expect(Object.keys(t).sort()).toEqual(['created_at', 'created_by', 'description', 'id', 'name', 'organization_id', 'updated_at'])
    expect((await create({ name: 'No description' })).description).toBeNull()
  })

  it.each([
    ['a whitespace-only name', { name: '   ' }],
    ['a name of 101 characters', { name: 'x'.repeat(101) }],
    ['no name', { description: 'd' }],
    ['a description of 1001 characters', { name: 'n', description: 'x'.repeat(1001) }],
    ['a color (D3)', { name: 'n', color: 'red' }],
    ['created_by in the input', { name: 'n', created_by: uuidv7() }],
    ['organization_id in the input', { name: 'n', organization_id: uuidv7() }],
  ])('refuses %s with 400 validation_error', async (_n, body) => {
    const err = await a.fail('tags.create', { body })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
    expect(await e.rows('tags')).toEqual([])
    expect(await tagEvents()).toEqual([])
  })

  it('accepts a 100 character name and a 1000 character description; update takes no color', async () => {
    const t = await create({ name: 'x'.repeat(100), description: 'y'.repeat(1000) })
    expect(t.name).toHaveLength(100)
    const err = await a.fail('tags.update', { params: { id: t.id }, body: { color: 'red' } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })

  it('tags.list filters name case-insensitively and created_by, ordered by id', async () => {
    const x = await create({ name: 'Alpha' })
    const y = await create({ name: 'Beta' }, { as: 'agent' })
    expect(ids(await a.call('tags.list', { query: { name: 'alpha' } }))).toEqual([x.id])
    expect(ids(await a.call('tags.list', { query: { name: 'ALPHA' } }))).toEqual([x.id])
    expect(ids(await a.call('tags.list', { query: { created_by: e.agentId } }))).toEqual([y.id])
    expect((await a.call('tags.list', { query: {} })).data.map((r: Rec) => r.id)).toEqual([x.id, y.id])
  })
})

describe('tag names are unique among live tags, case-insensitively (D4)', () => {
  it('create of a case variant is 409 tag_exists naming the first id, nothing written', async () => {
    const first = await create({ name: 'Prospects' })
    const mark = (await e.rows('events')).length
    const [status, code, message] = await failure('tags.create', { body: { name: 'prospects' } })
    expect([status, code]).toEqual([409, 'tag_exists'])
    expect(message).toContain(first.id)
    expect(await e.rows('tags')).toHaveLength(1)
    expect((await e.rows('events')).length).toBe(mark)
  })

  it('the trimmed name is compared', async () => {
    await create({ name: 'Prospects' })
    expect((await failure('tags.create', { body: { name: '  PROSPECTS ' } }))[1]).toBe('tag_exists')
  })

  it('rename into a live name is 409; rename to its own name in another case succeeds', async () => {
    const x = await create({ name: 'One' })
    const y = await create({ name: 'Two' })
    const [status, code, message] = await failure('tags.update', { params: { id: y.id }, body: { name: 'one' } })
    expect([status, code]).toEqual([409, 'tag_exists'])
    expect(message).toContain(x.id)
    const renamed = await a.call('tags.update', { params: { id: x.id }, body: { name: 'ONE' } })
    expect(renamed.name).toBe('ONE')
  })

  it('a soft-deleted tag frees its name; with no live row to compare the create succeeds', async () => {
    const x = await create({ name: 'Prospects' })
    await a.call('tags.delete', { params: { id: x.id } })
    const again = await create({ name: 'prospects' })
    expect(again.id).not.toBe(x.id)
    expect((await e.rows('tags')).filter((r) => r.deleted_at === null)).toHaveLength(1)
  })

  it('the partial unique index refuses a racing duplicate at commit as a 409, not a 500', async () => {
    e.betweenPlanAndCommit(async () => {
      await e.insert('tags', { name: 'Raced' })
    })
    const [status, code] = await failure('tags.create', { body: { name: 'raced' } })
    expect([status, code]).toEqual([409, 'conflict'])
    expect(await e.rows('tags')).toHaveLength(1)
  })
})

describe('tag events (D7)', () => {
  it('create, rename and delete each emit exactly one tag.* event with the actor; tagging and renaming stay apart', async () => {
    const t = await create({ name: 'List' })
    const co = await a.ent.company()
    const edge = await a.link(['tags', t.id], co)
    expect((await tagEvents()).map((x) => x.type)).toEqual(['tag.created'])
    expect((await assocEvents()).map((x) => x.type)).toEqual(['association.created'])
    const upd = await a.call('tags.update', { params: { id: t.id }, body: { name: 'Renamed' } }, { as: 'agent' })
    expect((await assocEvents()).map((x) => x.type)).toEqual(['association.created'])
    await a.unlink(edge.id)
    expect((await tagEvents()).map((x) => x.type)).toEqual(['tag.created', 'tag.updated'])
    await a.call('tags.delete', { params: { id: t.id } })
    const evs = await tagEvents()
    expect(evs.map((x) => [x.type, x.actor_id, x.resource_id])).toEqual([
      ['tag.created', e.userId, t.id],
      ['tag.updated', e.agentId, t.id],
      ['tag.deleted', e.userId, t.id],
    ])
    expect(evs[0]!.after).toEqual(t)
    expect(evs[1]!.after).toEqual(upd)
    expect(evs[2]!.after).toBeNull()
  })
})

describe('the taggable set (D8)', () => {
  const others: Array<['companies' | 'contacts' | 'tasks' | 'notes', () => Promise<Ent>]> = [
    ['companies', () => a.ent.company()],
    ['contacts', () => a.ent.contact()],
    ['tasks', () => a.ent.task()],
    ['notes', () => a.ent.note()],
  ]
  it.each(others)('tag and %s link in either argument order', async (_type, make) => {
    const t = await a.ent.tag('T1')
    const u = await a.ent.tag('T2')
    const r1 = await make()
    const r2 = await make()
    const one = await a.link(t, r1)
    const two = await a.link(r2, u)
    expect([one.id, two.id]).toHaveLength(2)
    expect((await a.list('tags', t[1])).data.map((x) => x.neighbour_id)).toEqual([r1[1]])
    expect((await a.list('tags', u[1])).data.map((x) => x.neighbour_id)).toEqual([r2[1]])
  })

  it.each(['tag to tag', 'tag to thread', 'tag to interaction'])('refuses %s in both orders with 400 validation_error naming the allowed types', async (name) => {
    const t = await a.ent.tag('T')
    const t2 = await a.ent.tag('T2')
    const partner: Ent = name === 'tag to tag' ? t2 : name === 'tag to thread' ? await a.ent.thread() : await a.ent.interaction()
    for (const [x, y] of [[t, partner], [partner, t]] as Array<[Ent, Ent]>) {
      const err = await a.fail('associations.create', { body: { a_type: x[0], a_id: x[1], b_type: y[0], b_id: y[1] } })
      expect([err.status, err.code]).toEqual([400, 'validation_error'])
      for (const allowed of ['companies', 'contacts', 'tasks', 'notes']) expect(err.message).toContain(allowed)
    }
    expect(await a.edges(false)).toEqual([])
  })

  it('a pair of other associable types is unchanged', async () => {
    const link = await a.link(await a.ent.company(), await a.ent.thread())
    expect(link.id).toBeDefined()
    expect((await a.link(await a.ent.contact(), await a.ent.note())).id).toBeDefined()
  })
})

describe('tagging scopes (D6)', () => {
  it('an agent with associations:write, tags:read and the record read scope can tag without tags:write; without tags:read it is 403', async () => {
    const t = await a.ent.tag('T')
    const co = await a.ent.company()
    const scopes = ['associations:write', 'associations:read', 'tags:read', 'companies:read']
    const edge = await a.link(t, co, { as: 'agent', scopes })
    expect(edge.created_by).toBe(e.agentId)
    const err = await a.fail('associations.create', { body: { a_type: 'tags', a_id: t[1], b_type: 'companies', b_id: co[1] } }, { as: 'agent', scopes: scopes.filter((s) => s !== 'tags:read') })
    expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
    expect(err.message).toContain('tags:read')
  })
})

describe('the tag_id list filter (D9)', () => {
  // ids are time-ordered, so tags < tasks makes the tag side `a` for tasks, and side `b` for companies, contacts and notes
  const listOf = (type: 'companies' | 'contacts' | 'tasks', query: Rec = {}, opts?: Parameters<AssocKit['call']>[2]) => a.call(`${type}.list`, { query }, opts)

  it.each([
    ['companies', 'b', () => a.ent.company('Co')],
    ['contacts', 'b', () => a.ent.contact('Ct')],
    ['tasks', 'a', () => a.ent.task('Ta')],
  ] as const)('%s.list?tag_id returns exactly the members (the tag is side %s), excluding untagged and soft-deleted edges', async (type, side, make) => {
    const t = await a.ent.tag('T')
    const other = await a.ent.tag('Other')
    const m1 = await make()
    const m2 = await make()
    const untagged = await make()
    const otherTag = await make()
    const unlinked = await make()
    const e1 = await a.link(t, m1)
    await a.link(m2, t)
    await a.link(other, otherTag)
    const gone = await a.link(t, unlinked)
    await a.unlink(gone.id)
    const edge = (await a.edges()).find((x) => x.id === e1.id)!
    expect(side === 'a' ? edge.a_type : edge.b_type).toBe('tags')
    expect(ids(await listOf(type, { tag_id: t[1] }))).toEqual([m1[1], m2[1]].sort())
    expect(ids(await listOf(type, { tag_id: t[1].toUpperCase() }))).toEqual([m1[1], m2[1]].sort())
    expect(ids(await listOf(type))).toHaveLength(5)
    expect(untagged[1]).toBeDefined()
  })

  it('an unknown id, a deleted tag and another type\'s id return an empty page, not an error', async () => {
    const t = await a.ent.tag('T')
    const co = await a.ent.company()
    await a.link(t, co)
    const doomed = await a.ent.tag('Doomed')
    await a.link(doomed, await a.ent.company())
    await a.call('tags.delete', { params: { id: doomed[1] } })
    for (const id of [uuidv7(), doomed[1], co[1]]) expect(await a.call('companies.list', { query: { tag_id: id } })).toEqual({ data: [], next_cursor: null })
  })

  it('is ANDed with another filter and pages across the boundary', async () => {
    const t = await a.ent.tag('T')
    const members: string[] = []
    for (let i = 0; i < 5; i++) {
      const c = await a.k.company({ name: `C${i}`, domain: i < 3 ? `d${i}.example.com` : null })
      members.push(c.id)
      await a.link(t, ['companies', c.id])
    }
    await a.k.company({ name: 'untagged', domain: 'd0b.example.com' })
    const p1 = await a.call('companies.list', { query: { tag_id: t[1], limit: 2 } })
    expect(p1.data).toHaveLength(2)
    expect(p1.next_cursor).toBe(p1.data[1].id)
    const p2 = await a.call('companies.list', { query: { tag_id: t[1], limit: 2, after: p1.next_cursor } })
    const p3 = await a.call('companies.list', { query: { tag_id: t[1], limit: 2, after: p2.next_cursor } })
    expect([...p1.data, ...p2.data, ...p3.data].map((r: Rec) => r.id)).toEqual(members)
    expect(p3.next_cursor).toBeNull()
    const both = await a.call('companies.list', { query: { tag_id: t[1], domain: 'd1.example.com' } })
    expect(ids(both)).toEqual([members[1]])
  })

  it('needs tags:read and associations:read on top of the list scope, checked before any query; without tag_id only the own scope is needed', async () => {
    const t = await a.ent.tag('T')
    const co = await a.ent.company()
    await a.link(t, co)
    const base = ['companies:read', 'tags:read', 'associations:read']
    for (const missing of ['tags:read', 'associations:read']) {
      const err = await a.fail('companies.list', { query: { tag_id: t[1] } }, { as: 'agent', scopes: base.filter((s) => s !== missing) })
      expect([err.status, err.code]).toEqual([403, 'insufficient_scope'])
      expect(err.message).toContain(missing)
    }
    const both = await a.fail('companies.list', { query: { tag_id: t[1] } }, { as: 'agent', scopes: ['companies:read'] })
    expect(both.message).toContain('tags:read')
    expect(ids(await a.call('companies.list', { query: {} }, { as: 'agent', scopes: ['companies:read'] }))).toEqual([co[1]])
    expect(ids(await a.call('companies.list', { query: { tag_id: t[1] } }, { as: 'agent', scopes: base }))).toEqual([co[1]])
  })

  it('a malformed tag_id is 400 validation_error', async () => {
    const err = await a.fail('companies.list', { query: { tag_id: 'nope' } })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })
})

describe('tags.delete cascades the live edges (D11)', () => {
  it('soft-deletes every edge, one association.deleted each, members untouched, in one unit', async () => {
    const t = await a.ent.tag('T')
    const members: Ent[] = [await a.ent.company(), await a.ent.contact(), await a.ent.task(), await a.ent.note()]
    const links: Rec[] = []
    for (const m of members) links.push(await a.link(t, m))
    const keep = await a.link(members[0]!, members[1]!)
    const mark = (await e.rows('events')).length
    await a.call('tags.delete', { params: { id: t[1] } })
    expect((await e.rows('tags'))[0]!.deleted_at).not.toBeNull()
    const rows = await a.edges(false)
    for (const l of links) expect(rows.find((r) => r.id === l.id)!.deleted_at).not.toBeNull()
    expect(rows.find((r) => r.id === keep.id)!.deleted_at).toBeNull()
    for (const m of members) expect((await e.rows(m[0])).find((r) => r.id === m[1])!.deleted_at).toBeNull()
    const evs = (await e.rows('events')).slice(mark)
    expect(evs[0]).toMatchObject({ type: 'tag.deleted', resource_id: t[1] })
    expect(evs.filter((x) => x.type === 'association.deleted').map((x) => x.resource_id).sort()).toEqual(links.map((l) => l.id).sort())
    expect(evs).toHaveLength(1 + links.length)
  })

  const edgeRows = async (tagId: string, n: number) => {
    for (let i = 0; i < n; i++) await e.insert('associations', { a_type: 'companies', a_id: uuidv7(), b_type: 'tags', b_id: tagId, relation: 'related_to' })
  }
  it('exactly 100 live edges succeed; 101 is 400 set_limit_exceeded and nothing changes', async () => {
    const ok = await a.ent.tag('Hundred')
    await edgeRows(ok[1], 100)
    await a.call('tags.delete', { params: { id: ok[1] } })
    expect((await a.edges()).filter((r) => r.b_id === ok[1])).toEqual([])

    const big = await a.ent.tag('HundredAndOne')
    await edgeRows(big[1], 101)
    const mark = (await e.rows('events')).length
    const err = await a.fail('tags.delete', { params: { id: big[1] } })
    expect([err.status, err.code]).toEqual([400, 'set_limit_exceeded'])
    expect((await e.rows('tags')).find((r) => r.id === big[1])!.deleted_at).toBeNull()
    expect((await a.edges()).filter((r) => r.b_id === big[1])).toHaveLength(101)
    expect((await e.rows('events')).length).toBe(mark)
  })

  it('is atomic: an edge removed between plan and commit aborts the unit, the tag stays live', async () => {
    const t = await a.ent.tag('T')
    const l1 = await a.link(t, await a.ent.company())
    await a.link(t, await a.ent.company())
    const mark = (await e.rows('events')).length
    e.betweenPlanAndCommit(async () => {
      await e.update('associations', l1.id, { deleted_at: '2026-10-22T11:00:00.000Z', updated_at: '2026-10-22T11:00:00.000Z' })
    })
    const err = await a.call('tags.delete', { params: { id: t[1] } }).then(() => undefined, (x: unknown) => x)
    expect(err).toBeDefined()
    expect((await e.rows('tags'))[0]!.deleted_at).toBeNull()
    expect((await a.edges()).filter((r) => r.id !== l1.id)).toHaveLength(1)
    expect((await e.rows('events')).length).toBe(mark)
  })
})

describe('contacts.merge with a shared tag (CORE62 D16)', () => {
  it('leaves one live edge between the tag and the survivor', async () => {
    const t = await a.ent.tag('T')
    const s = await a.ent.contact('S')
    const r = await a.ent.contact('R')
    await a.link(t, s)
    await a.link(t, r)
    await a.k.run((env) => mergeOperation(env, s[1], r[1]))
    const live = (await a.edges()).filter((x) => x.a_type === 'tags' || x.b_type === 'tags')
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ a_id: s[1], b_id: t[1] })
    expect(ids(await a.call('contacts.list', { query: { tag_id: t[1] } }))).toEqual([s[1]])
  })
})

describe('a repeated tag_id over MCP (D10)', () => {
  it('two values in one argument never run as one: the list is 400 validation_error', async () => {
    const x = await a.ent.tag('X')
    const y = await a.ent.tag('Y')
    const op = a.registry.get('companies.list')!
    const { query } = splitArguments(op, { tag_id: [x[1], y[1]] })
    const err = await a.fail('companies.list', { query })
    expect([err.status, err.code]).toEqual([400, 'validation_error'])
  })
})
