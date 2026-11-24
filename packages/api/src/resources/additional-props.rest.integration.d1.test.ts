import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor, type Res } from '../test/action-kit.js'

// [[CORE318]] cycle 1 (D1 to D8): the `additional_props` bag on contacts, companies, deals and tasks, over REST on D1 (the oracle). The bag is a flat
// object of scalars written as a one-level merge patch on the stamp-guarded before row; the migration over data is storage-d1's own suite.
let k: ActionKit
let writer: Actor
let proposer: Actor
let reader: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
const RESOURCES = ['contacts', 'companies', 'deals', 'tasks', 'pipelines', 'action_requests']
beforeEach(async () => {
  await k.reset()
  writer = await k.actor(
    'writer',
    'agent',
    RESOURCES.flatMap((r) => [`${r}:read`, `${r}:write`]),
  )
  proposer = await k.actor(
    'proposer',
    'agent',
    RESOURCES.flatMap((r) => [`${r}:read`, `${r}:request_approval`]),
  )
  reader = await k.actor(
    'reader',
    'agent',
    RESOURCES.map((r) => `${r}:read`),
  )
})

const KINDS = ['contacts', 'companies', 'deals', 'tasks'] as const
type Kind = (typeof KINDS)[number]
const EVENT: Record<Kind, string> = { contacts: 'contact', companies: 'company', deals: 'deal', tasks: 'task' }
let stageId = ''
async function base(kind: Kind): Promise<Record<string, unknown>> {
  if (kind === 'deals') {
    if (!stageId) {
      const p = (await k.call(k.owner, 'POST', '/meta/v1/pipelines', { name: `P${Math.random()}` })).body.id
      stageId = (
        await k.call(k.owner, 'POST', '/meta/v1/pipeline-stages', {
          pipeline_id: p,
          name: 'Open',
          kind: 'open',
          position: 1,
        })
      ).body.id
    }
    return { name: 'D', stage_id: stageId }
  }
  return kind === 'tasks' ? { title: 'T' } : { name: 'N' }
}
beforeEach(() => {
  stageId = ''
})
const path = (kind: Kind, id?: string) => `/api/v1/${kind}${id ? `/${id}` : ''}`
async function create(kind: Kind, bag?: unknown, as: Actor = writer): Promise<Res> {
  return k.call(as, 'POST', path(kind), {
    ...(await base(kind)),
    ...(bag === undefined ? {} : { additional_props: bag }),
  })
}
async function made(kind: Kind, bag?: unknown): Promise<any> {
  const r = await create(kind, bag)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}
const patch = (kind: Kind, id: string, body: unknown, as: Actor = writer) => k.call(as, 'PATCH', path(kind, id), body)
const stored = async (kind: Kind, id: string) =>
  ((await k.d1.prepare(`select additional_props from ${kind} where id = ?`).bind(id).first()) as any)
    .additional_props as string
const refusal = (r: Res) => [r.status, r.body?.error?.code] as const
const message = (r: Res) => String(r.body?.error?.message)

describe('validation matrix (D2, D3, D7)', () => {
  // Each case: a name, the bag, and what the message must name (the key and the rule).
  const bad: Array<[string, unknown, RegExp]> = [
    ['a nested object', { nest: { a: 1 } }, /additional_props\.nest.*string, number or boolean/],
    ['an array', { list: [1, 2] }, /additional_props\.list.*string, number or boolean/],
    ['a string of 1,001 characters', { long: 'x'.repeat(1001) }, /additional_props\.long.*1000 characters/],
    ['a key with a dot', { 'a.b': 1 }, /key "a\.b".*lowercase snake_case/],
    ['a key with a capital', { Abc: 1 }, /key "Abc".*lowercase snake_case/],
    ['a key with a double underscore', { a__b: 1 }, /key "a__b".*lowercase snake_case/],
    ['a key with two colons', { 'a:b:c': 1 }, /key "a:b:c".*lowercase snake_case/],
    ['a key of 65 characters', { ['a'.repeat(65)]: 1 }, /key "a{65}".*64 characters/],
    ['an empty key', { '': 1 }, /key "".*lowercase snake_case/],
    ['a 51st key', Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])), /more than 50 keys/],
    [
      'a bag over 8 KiB',
      Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'y'.repeat(1000)])),
      /8192 bytes/,
    ],
    [
      'multi-byte text over 8 KiB although under 8,192 characters',
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, 'é'.repeat(1000)])),
      /8192 bytes/,
    ],
  ]
  it.each(bad)(
    'contacts create refuses %s with 400 validation_error naming the key and the rule',
    async (_n, bag, rule) => {
      const r = await create('contacts', bag)
      expect(refusal(r)).toEqual([400, 'validation_error'])
      expect(message(r)).toMatch(rule)
    },
  )
  it.each(bad)(
    'contacts update refuses %s with 400 validation_error naming the key and the rule',
    async (_n, bag, rule) => {
      const c = await made('contacts', { keep: 1 })
      const r = await patch('contacts', c.id, { additional_props: bag })
      expect(refusal(r)).toEqual([400, 'validation_error'])
      expect(message(r)).toMatch(rule)
      expect((await k.call(writer, 'GET', path('contacts', c.id))).body.additional_props).toEqual({ keep: 1 })
    },
  )

  it('accepts the limits: a 1,000-character string, 50 keys, a 64-character key, numbers, booleans and a prefixed key', async () => {
    const fifty = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`k${i}`, i]))
    const bag = { ...fifty, long: 'x'.repeat(1000), [`a${'b'.repeat(63)}`]: true }
    expect(Object.keys(bag)).toHaveLength(50)
    const c = await made('contacts', bag)
    expect(c.additional_props).toEqual(bag)
    const p = await made('contacts', { 'scorer:lead_grade': 'a', score: -1.5, ok: false })
    expect(p.additional_props).toEqual({ 'scorer:lead_grade': 'a', score: -1.5, ok: false })
  })

  it('refuses additional_props: null on create and update, and a stored null is impossible', async () => {
    const c = await created('contacts')
    expect(refusal(await create('contacts', null))).toEqual([400, 'validation_error'])
    expect(refusal(await patch('contacts', c.id, { additional_props: null }))).toEqual([400, 'validation_error'])
    const r = await create('contacts', { gone: null, here: 1 })
    expect(r.body.additional_props).toEqual({ here: 1 })
    expect(await stored('contacts', r.body.id)).not.toContain('null')
  })

  it('a bag over 8 KiB after the patch is refused although the patch is small; a record stored at the limit still updates its other fields', async () => {
    const full: Record<string, string> = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]),
    )
    full.pad = 'p'.repeat(118)
    expect(Buffer.byteLength(JSON.stringify(full))).toBe(8192)
    const c = await made('contacts', full)
    const over = await patch('contacts', c.id, { additional_props: { a: 1 } })
    expect(refusal(over)).toEqual([400, 'validation_error'])
    expect(message(over)).toMatch(/8192 bytes/)
    expect((await patch('contacts', c.id, { name: 'renamed' })).status).toBe(200)
    // shrinking a key and adding another within the budget works
    const ok = await patch('contacts', c.id, { additional_props: { pad: null, a: 1 } })
    expect(ok.status).toBe(200)
  })

  it.each(['companies', 'deals', 'tasks'] as const)(
    '%s refuses the same way as contacts (create and update)',
    async (kind) => {
      const r = await create(kind, { nest: { a: 1 } })
      expect(refusal(r)).toEqual([400, 'validation_error'])
      expect(message(r)).toMatch(/additional_props\.nest.*string, number or boolean/)
      const row = await made(kind, { keep: 1 })
      const u = await patch(kind, row.id, { additional_props: { Bad: 1 } })
      expect(refusal(u)).toEqual([400, 'validation_error'])
      expect(message(u)).toMatch(/key "Bad".*lowercase snake_case/)
      const n = await patch(kind, row.id, { additional_props: null })
      expect(refusal(n)).toEqual([400, 'validation_error'])
      const big = await patch(kind, row.id, {
        additional_props: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])),
      })
      expect(message(big)).toMatch(/more than 50 keys/)
    },
  )
})
const created = (kind: Kind) => made(kind)

describe('merge patch and the race (D4)', () => {
  it.each(KINDS)(
    '%s: one patch sets, removes and leaves keys alone; null removes; typed fields and the bag are independent',
    async (kind) => {
      const row = await made(kind, { a: 1, b: 'x', c: true })
      expect(row.additional_props).toEqual({ a: 1, b: 'x', c: true })
      const r = await patch(kind, row.id, { additional_props: { a: null, b: 'y', d: 2 } })
      expect(r.body.additional_props).toEqual({ b: 'y', c: true, d: 2 })
      expect(await stored(kind, row.id)).toBe('{"b":"y","c":true,"d":2}')
      // a patch naming only the bag leaves the typed fields untouched
      const typed = Object.fromEntries(
        Object.entries(row).filter(([key]) => ['name', 'title', 'stage_id'].includes(key)),
      )
      expect(Object.fromEntries(Object.entries(r.body).filter(([key]) => key in typed))).toEqual(typed)
      // a typed-field patch leaves the bag untouched
      const t = await patch(kind, row.id, kind === 'tasks' ? { title: 'new' } : { name: 'new' })
      expect(t.body.additional_props).toEqual({ b: 'y', c: true, d: 2 })
    },
  )

  it('on create a null value for a key is simply absent', async () => {
    const r = await made('companies', { a: null, b: 1 })
    expect(r.additional_props).toEqual({ b: 1 })
  })

  it('a bag-unchanged patch is a real update, as a same-value patch is today', async () => {
    k.setNow(new Date('2026-11-24T10:00:00.000Z'))
    const row = await made('contacts', { a: 1 })
    const before = (await k.events('contact.updated')).length
    k.setNow(new Date('2026-11-24T10:05:00.000Z'))
    const r = await patch('contacts', row.id, { additional_props: { a: 1, absent: null } })
    expect(r.status).toBe(200)
    expect(r.body.additional_props).toEqual({ a: 1 })
    expect(r.body.updated_at).toBe('2026-11-24T10:05:00.000Z')
    expect((await k.events('contact.updated')).length).toBe(before + 1)
  })

  it('two writers racing: the loser gets 409 conflict and, after its retry, both writers keys are present', async () => {
    k.setNow(new Date('2026-11-24T11:00:00.000Z'))
    const row = await made('contacts', { base: 1 })
    k.setNow(new Date('2026-11-24T11:01:00.000Z'))
    k.beforeCommit(async () => {
      k.setNow(new Date('2026-11-24T11:02:00.000Z'))
      const other = await patch('contacts', row.id, { additional_props: { theirs: 2 } })
      expect(other.status).toBe(200)
    })
    const loser = await patch('contacts', row.id, { additional_props: { mine: 3 } })
    expect(refusal(loser)).toEqual([409, 'conflict'])
    expect((await k.call(writer, 'GET', path('contacts', row.id))).body.additional_props).toEqual({
      base: 1,
      theirs: 2,
    })
    k.setNow(new Date('2026-11-24T11:03:00.000Z'))
    const retry = await patch('contacts', row.id, { additional_props: { mine: 3 } })
    expect(retry.status).toBe(200)
    expect(retry.body.additional_props).toEqual({ base: 1, theirs: 2, mine: 3 })
  })
})

describe('events and reads (D5)', () => {
  it.each(KINDS)(
    '%s: created and updated events carry the bag as a JSON object in before and after; get and list return an object',
    async (kind) => {
      const row = await made(kind, { a: 1 })
      const created = (await k.events(`${EVENT[kind]}.created`)).find((e) => e.resource_id === row.id)!
      expect(created.before).toBeNull()
      expect(created.after.additional_props).toEqual({ a: 1 })
      await patch(kind, row.id, { additional_props: { b: 'two', a: null } })
      const updated = (await k.events(`${EVENT[kind]}.updated`)).find((e) => e.resource_id === row.id)!
      expect(updated.before.additional_props).toEqual({ a: 1 })
      expect(updated.after.additional_props).toEqual({ b: 'two' })
      expect((await k.call(writer, 'GET', path(kind, row.id))).body.additional_props).toEqual({ b: 'two' })
      const list = await k.call(writer, 'GET', path(kind))
      expect(list.body.data.find((r: any) => r.id === row.id).additional_props).toEqual({ b: 'two' })
    },
  )
  it.each(KINDS)(
    '%s: a record created without a bag reads {} (an object, never null) in the answer and the event',
    async (kind) => {
      const row = await made(kind)
      expect(row.additional_props).toEqual({})
      const ev = (await k.events(`${EVENT[kind]}.created`)).find((e) => e.resource_id === row.id)!
      expect(ev.after.additional_props).toEqual({})
    },
  )
})

describe('contact merge fill (D6)', () => {
  const merge = (survivor: string, source: string) =>
    k.call(writer, 'POST', `/api/v1/contacts/${survivor}/merge`, { source_id: source })
  const fills = async (id: string) => (await k.events('contact.updated')).filter((e) => e.resource_id === id)

  it('keeps survivor keys, fills missing ones from the source, a shared key keeps the survivor value, with one contact.updated', async () => {
    const s = await made('contacts', { shared: 'mine', only_s: 1 })
    const r = await made('contacts', { shared: 'theirs', only_r: 2 })
    const out = await merge(s.id, r.id)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.additional_props).toEqual({ shared: 'mine', only_s: 1, only_r: 2 })
    const f = await fills(s.id)
    expect(f).toHaveLength(1)
    expect(f[0]!.before.additional_props).toEqual({ shared: 'mine', only_s: 1 })
    expect(f[0]!.after.additional_props).toEqual({ shared: 'mine', only_s: 1, only_r: 2 })
    // the tombstoned source keeps its bag
    expect(JSON.parse(await stored('contacts', r.id))).toEqual({ shared: 'theirs', only_r: 2 })
  })
  it('empty source bag and empty survivor bag', async () => {
    const s = await made('contacts', { a: 1 })
    const empty = await made('contacts')
    expect((await merge(s.id, empty.id)).body.additional_props).toEqual({ a: 1 })
    expect(await fills(s.id)).toHaveLength(0)
    const s2 = await made('contacts')
    const r2 = await made('contacts', { b: 2 })
    expect((await merge(s2.id, r2.id)).body.additional_props).toEqual({ b: 2 })
    expect(await fills(s2.id)).toHaveLength(1)
  })
  it('a fill of a typed field with no bag change still emits one contact.updated, and none when nothing fills', async () => {
    const s = await made('contacts', { a: 1 })
    const r = await k.call(writer, 'POST', '/api/v1/contacts', { name: 'Rita', additional_props: { a: 9 } })
    const s2 = (await k.call(writer, 'POST', '/api/v1/contacts', { additional_props: { a: 1 } })).body
    await merge(s2.id, r.body.id)
    expect((await fills(s2.id)).length).toBe(1)
    const n1 = await made('contacts', { a: 1 })
    const n2 = await made('contacts', { a: 1 })
    await merge(n1.id, n2.id)
    expect(await fills(n1.id)).toHaveLength(0)
    expect(s.id).not.toBe(n1.id)
  })
  it('keys that would push the survivor past 50 keys or 8 KiB stay on the source; the merge still succeeds', async () => {
    const mk = (from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, i]))
    const s = await made('contacts', mk(0, 49))
    const r = await made('contacts', { x1: 1, x2: 2, x3: 3 })
    const out = await merge(s.id, r.id)
    expect(out.status).toBe(200)
    // key order: the first source key fits (50), the others do not
    expect(Object.keys(out.body.additional_props)).toHaveLength(50)
    expect(out.body.additional_props.x1).toBe(1)
    expect(out.body.additional_props.x2).toBeUndefined()
    expect(JSON.parse(await stored('contacts', r.id))).toEqual({ x1: 1, x2: 2, x3: 3 })

    const big: Record<string, string> = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]),
    )
    const s3 = await made('contacts', big)
    const r3 = await made('contacts', { small: 1, huge: 'y'.repeat(1000) })
    const out3 = await merge(s3.id, r3.id)
    expect(out3.status).toBe(200)
    expect(Buffer.byteLength(JSON.stringify(out3.body.additional_props))).toBeLessThanOrEqual(8192)
    expect(out3.body.additional_props.small).toBe(1)
  })
})

describe('authority (D8)', () => {
  const AR = '/api/v1/action-requests'
  it('a caller with contacts:read only is refused a bag update by the scope refusal', async () => {
    const c = await made('contacts', { a: 1 })
    const r = await patch('contacts', c.id, { additional_props: { b: 2 } }, reader)
    expect(refusal(r)).toEqual([403, 'insufficient_scope'])
    expect((await k.call(writer, 'GET', path('contacts', c.id))).body.additional_props).toEqual({ a: 1 })
  })
  it('a proposal of a bag update under request_approval merges, once approved, onto the record as it is at execution time', async () => {
    const c = await made('contacts', { a: 1 })
    const prop = await k.call(proposer, 'POST', AR, {
      operation: 'contacts.update',
      arguments: { id: c.id, additional_props: { mine: 'p' } },
      reason: 'enrich',
    })
    expect(prop.status, JSON.stringify(prop.body)).toBe(201)
    // nothing applied yet; another writer sets a key between proposal and approval
    expect((await k.call(writer, 'GET', path('contacts', c.id))).body.additional_props).toEqual({ a: 1 })
    k.setNow(new Date(k.now().getTime() + 60_000))
    expect((await patch('contacts', c.id, { additional_props: { theirs: 2 } })).status).toBe(200)
    k.setNow(new Date(k.now().getTime() + 60_000))
    const approved = await k.call(k.owner, 'POST', `${AR}/${prop.body.id}/approve`)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect((await k.call(writer, 'GET', path('contacts', c.id))).body.additional_props).toEqual({
      a: 1,
      theirs: 2,
      mine: 'p',
    })
  })
})
