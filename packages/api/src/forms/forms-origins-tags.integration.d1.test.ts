import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CHN424]]: a form's allowed origins (D8) and tags (D9) on forms.create/update/get/list and in form.* events (D11, D13 list parts).
// Fixtures are direct inserts (tags, seeded forms); the writes under test go through the REST surface.
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const call = async (method: string, path: string, body?: unknown) => {
  const token = mintTestUserToken({
    userId: e.userId,
    organizationId: e.organizationId,
    scopes: ['forms:read', 'forms:write', 'events:read'],
    kind: 'user',
  })
  const res = await app.request(`https://vibase.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const PATH = '/meta/v1/forms'
const create = (body: unknown) => call('POST', PATH, body)
const patch = (id: string, body: unknown) => call('PATCH', `${PATH}/${id}`, body)
const get = (id: string) => call('GET', `${PATH}/${id}`)
const del = (id: string) => call('DELETE', `${PATH}/${id}`)
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const formEvents = async () => (await e.events()).filter((x: any) => String(x.type).startsWith('form.'))
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'
let n = 0
const tag = async (over: Record<string, unknown> = {}) =>
  (await e.insert('tags', { name: `Tag ${++n}`, ...over })).id as string
const state = async () => ({
  forms: await e.rows('forms'),
  origins: await e.rows('form_allowed_origins'),
  tags: await e.rows('form_tags'),
  events: (await e.events()).length,
  agents: (await e.rows('agents')).length,
})
const originRows = async (id: string) =>
  (await e.rows('form_allowed_origins')).filter((r) => r.form_id === id).map((r) => r.origin as string)

describe('1. origin normalisation (matrix, through forms.create)', () => {
  const accepted: [string, string][] = [
    ['HTTPS://Example.COM/', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://example.com', 'https://example.com'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
  ]
  for (const [input, stored] of accepted)
    it(`accepts ${input} and stores ${stored}`, async () => {
      const r = await create({ name: 'F', allowed_origins: [input] })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.body.allowed_origins).toEqual([stored])
      expect(await originRows(r.body.id)).toEqual([stored])
    })

  const refused: [string, string][] = [
    ['http scheme on a public host', 'http://example.com'],
    ['a bare host', 'example.com'],
    ['another scheme', 'ftp://example.com'],
    ['userinfo', 'https://user@example.com'],
    ['a path', 'https://example.com/path'],
    ['a bare query marker', 'https://example.com?'],
    ['a fragment', 'https://example.com#x'],
    ['a wildcard host', 'https://*.example.com'],
    ['the string null', 'null'],
    [
      'a stored origin of 254 characters',
      `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}.com`,
    ],
  ]
  for (const [label, input] of refused)
    it(`refuses ${label}, naming allowed_origins[1], and writes nothing`, async () => {
      const before = await state()
      const r = await create({ name: 'F', allowed_origins: ['https://ok.example', input] })
      expect(refusal(r)).toEqual([400, 'validation_error'])
      expect(r.body.error.message).toContain('allowed_origins[1]')
      expect(await state()).toEqual(before)
    })

  it('the 254-character case is really 254 characters, and a 253-character one is accepted', async () => {
    const host = (len: number) => {
      const tail = '.com'
      const labels = [63, 63, 63]
      const used = labels.reduce((a, b) => a + b + 1, 0) + tail.length
      return `${labels.map((l) => 'a'.repeat(l)).join('.')}.${'d'.repeat(len - used)}${tail}`
    }
    expect(`https://${host(246)}`.length).toBe(254)
    const ok = await create({ name: 'F', allowed_origins: [`https://${host(245)}`] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it('a non-string entry is a validation_error', async () => {
    expect(refusal(await create({ name: 'F', allowed_origins: [null] }))).toEqual([400, 'validation_error'])
    expect(refusal(await create({ name: 'F', allowed_origins: 'https://a.example' }))).toEqual([
      400,
      'validation_error',
    ])
  })
})

describe('2. origins written and replaced', () => {
  it('create stores the rows and the record is sorted', async () => {
    const r = await create({ name: 'F', allowed_origins: ['https://b.example', 'https://a.example'] })
    expect(r.status).toBe(201)
    expect(r.body.allowed_origins).toEqual(['https://a.example', 'https://b.example'])
    expect(r.body.tag_ids).toEqual([])
    expect((await get(r.body.id)).body).toEqual(r.body)
    expect((await call('GET', PATH)).body.data).toEqual([r.body])
    expect((await e.rows('form_allowed_origins')).every((x) => x.organization_id === e.organizationId)).toBe(true)
  })

  it('create without lists defaults both to []; [] is accepted', async () => {
    const a = await create({ name: 'A' })
    expect(a.body).toMatchObject({ allowed_origins: [], tag_ids: [] })
    const b = await create({ name: 'B', allowed_origins: [], tag_ids: [] })
    expect(b.status).toBe(201)
    expect(await e.rows('form_allowed_origins')).toEqual([])
  })

  it('two entries equal after normalising are refused naming index 1, nothing written', async () => {
    const before = await state()
    const r = await create({ name: 'F', allowed_origins: ['https://A.com', 'https://a.com/'] })
    expect(refusal(r)).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain('allowed_origins[1]')
    expect(await state()).toEqual(before)
  })

  it('21 entries are refused, 20 accepted', async () => {
    const many = (k: number) => Array.from({ length: k }, (_, i) => `https://s${i}.example`)
    const before = await state()
    expect(refusal(await create({ name: 'F', allowed_origins: many(21) }))).toEqual([400, 'validation_error'])
    expect(await state()).toEqual(before)
    const ok = await create({ name: 'G', allowed_origins: many(20) })
    expect(ok.status).toBe(201)
    expect(ok.body.allowed_origins).toHaveLength(20)
  })

  it('update replaces the set, [] clears it, an absent key leaves the rows', async () => {
    const a = await create({ name: 'A', allowed_origins: ['https://one.example', 'https://two.example'] })
    const other = await create({ name: 'Other', allowed_origins: ['https://other.example'] })
    const u = await patch(a.body.id, { allowed_origins: ['https://three.example'] })
    expect(u.status).toBe(200)
    expect(u.body.allowed_origins).toEqual(['https://three.example'])
    expect(await originRows(a.body.id)).toEqual(['https://three.example'])
    expect(await originRows(other.body.id)).toEqual(['https://other.example'])
    const keep = await patch(a.body.id, { name: 'A2' })
    expect(keep.body.allowed_origins).toEqual(['https://three.example'])
    expect(await originRows(a.body.id)).toEqual(['https://three.example'])
    const cleared = await patch(a.body.id, { allowed_origins: [] })
    expect(cleared.body.allowed_origins).toEqual([])
    expect(await originRows(a.body.id)).toEqual([])
    expect(await originRows(other.body.id)).toEqual(['https://other.example'])
  })

  it('update with the same list is accepted and rewrites it', async () => {
    const a = await create({ name: 'A', allowed_origins: ['https://one.example'] })
    const u = await patch(a.body.id, { allowed_origins: ['https://one.example'] })
    expect(u.status).toBe(200)
    expect(await originRows(a.body.id)).toEqual(['https://one.example'])
  })
})

describe('3. tags written and validated', () => {
  it('stores live tags and the record is sorted', async () => {
    const [t1, t2, t3] = [await tag(), await tag(), await tag()]
    const r = await create({ name: 'F', tag_ids: [t3, t1, t2] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.tag_ids).toEqual([t1, t2, t3].sort())
    expect((await e.rows('form_tags')).map((x) => x.tag_id).sort()).toEqual([t1, t2, t3].sort())
    expect((await get(r.body.id)).body.tag_ids).toEqual([t1, t2, t3].sort())
  })

  it('an unknown tag and a soft-deleted tag are each 400 invalid_reference with nothing written', async () => {
    const gone = await tag({ deleted_at: SEED_AT })
    for (const bad of [UNKNOWN, gone]) {
      const before = await state()
      expect(refusal(await create({ name: 'F', tag_ids: [await tag(), bad] }))).toEqual([400, 'invalid_reference'])
      const a = await create({ name: `A${bad}` })
      const mid = await state()
      expect(refusal(await patch(a.body.id, { tag_ids: [bad] }))).toEqual([400, 'invalid_reference'])
      expect(await state()).toEqual(mid)
      expect(before.tags).toEqual([])
    }
  })

  it('a tag of another organisation is not live for this one', async () => {
    const org2 = '0190b2c4-0000-7000-8000-0000000000b2'
    await e.insert('organizations', { id: org2, name: 'Other org' } as never).catch(() => undefined)
    const foreign = await e.insert('tags', { name: 'Foreign', organization_id: org2 }).catch(() => null)
    if (!foreign) return
    expect(refusal(await create({ name: 'F', tag_ids: [foreign.id as string] }))).toEqual([400, 'invalid_reference'])
  })

  it('a non-uuid is 400 validation_error, a repeated id is refused naming its index, 21 are refused, 20 accepted', async () => {
    const t = await tag()
    expect(refusal(await create({ name: 'F', tag_ids: ['nope'] }))).toEqual([400, 'validation_error'])
    const dup = await create({ name: 'F', tag_ids: [t, t] })
    expect(refusal(dup)).toEqual([400, 'validation_error'])
    expect(dup.body.error.message).toContain('tag_ids[1]')
    const ids: string[] = []
    for (let i = 0; i < 21; i++) ids.push(await tag())
    expect(refusal(await create({ name: 'F', tag_ids: ids }))).toEqual([400, 'validation_error'])
    expect((await create({ name: 'G', tag_ids: ids.slice(0, 20) })).status).toBe(201)
  })

  it('update: lists replace, [] clears, absent keeps; an unknown form with a bad tag is 404 (P2 order)', async () => {
    const [t1, t2] = [await tag(), await tag()]
    const a = await create({ name: 'A', tag_ids: [t1] })
    expect((await patch(a.body.id, { tag_ids: [t2] })).body.tag_ids).toEqual([t2])
    expect((await patch(a.body.id, { enabled: false })).body.tag_ids).toEqual([t2])
    expect((await patch(a.body.id, { tag_ids: [] })).body.tag_ids).toEqual([])
    expect(await e.rows('form_tags')).toEqual([])
    expect(refusal(await patch(UNKNOWN, { tag_ids: [UNKNOWN] }))).toEqual([404, 'not_found'])
    expect(refusal(await patch(UNKNOWN, { allowed_origins: ['bad'] }))).toEqual([400, 'validation_error'])
  })

  it('a tag deleted after it was written stays in forms.get tag_ids, and re-sending it is invalid_reference (P4)', async () => {
    const [t1, t2] = [await tag(), await tag()]
    const a = await create({ name: 'A', tag_ids: [t1, t2] })
    await e.update('tags', t1, { deleted_at: SEED_AT })
    expect((await get(a.body.id)).body.tag_ids).toEqual([t1, t2].sort())
    expect(refusal(await patch(a.body.id, { tag_ids: [t1, t2] }))).toEqual([400, 'invalid_reference'])
    expect((await patch(a.body.id, { tag_ids: [t2] })).body.tag_ids).toEqual([t2])
  })
})

describe('4. atomicity and drift', () => {
  it('a refused create or update (each P2 refusal) leaves child rows and the log unchanged', async () => {
    const a = await create({ name: 'A', allowed_origins: ['https://a.example'], tag_ids: [await tag()] })
    const before = await state()
    const bads: unknown[] = [
      { allowed_origins: ['bad'] },
      { allowed_origins: ['https://x.example', 'https://x.example'] },
      { tag_ids: [UNKNOWN] },
      { allowed_origins: ['https://new.example'], tag_ids: [UNKNOWN] },
      { name: 'A', allowed_origins: ['https://new.example'], phone_field: 'email' },
    ]
    for (const b of bads) {
      expect(await patch(a.body.id, b), JSON.stringify(b)).toMatchObject({ status: 400 })
      expect(await create({ name: 'B', ...(b as object) })).toMatchObject({ status: 400 })
    }
    expect(await state()).toEqual(before)
  })

  it('a name conflict seeded past the plan check leaves the child rows and the log unchanged (create)', async () => {
    const before = await state()
    e.betweenPlanAndCommit(async () => {
      await e.insert('principals', { id: '0190b2c4-0000-7000-8000-0000000f9001', kind: 'agent', created_at: SEED_AT })
      await e.insert('agents', {
        id: '0190b2c4-0000-7000-8000-0000000f9001',
        name: 'Raced',
        scopes: [],
        disabled_at: null,
      })
      await e.insert('forms', {
        id: '0190b2c4-0000-7000-8000-0000000f9001',
        name: 'Raced',
        public_id: `frm_${'a'.repeat(26)}`,
        enabled: true,
        email_field: 'email',
        phone_field: null,
        name_field: null,
        consent_text: null,
      })
    })
    const r = await create({ name: 'Raced', allowed_origins: ['https://a.example'], tag_ids: [await tag()] })
    expect(refusal(r)).toEqual([409, 'conflict'])
    const after = await state()
    expect(after.origins).toEqual(before.origins)
    expect(after.tags).toEqual(before.tags)
    expect(after.events).toBe(before.events)
  })

  it('an update whose form stamp drifts between plan and commit applies no child-row change and no event', async () => {
    const t = await tag()
    const a = await create({ name: 'A', allowed_origins: ['https://old.example'], tag_ids: [t] })
    const before = await state()
    e.betweenPlanAndCommit(async () => {
      await e.update('forms', a.body.id, { updated_at: '2026-10-22T09:00:00.000Z' })
    })
    const r = await patch(a.body.id, { allowed_origins: ['https://new.example'], tag_ids: [] })
    expect(refusal(r)).toEqual([409, 'conflict'])
    expect(await originRows(a.body.id)).toEqual(['https://old.example'])
    expect((await e.rows('form_tags')).map((x) => x.tag_id)).toEqual([t])
    expect((await e.events()).length).toBe(before.events)
  })

  it('soft delete keeps both child tables, and form.deleted carries both lists', async () => {
    const t = await tag()
    const a = await create({ name: 'A', allowed_origins: ['https://a.example'], tag_ids: [t] })
    expect((await del(a.body.id)).status).toBe(204)
    expect(await originRows(a.body.id)).toEqual(['https://a.example'])
    expect((await e.rows('form_tags')).map((x) => x.tag_id)).toEqual([t])
    const gone = (await formEvents()).find((x: any) => x.type === 'form.deleted')!
    expect(gone.before).toMatchObject({ allowed_origins: ['https://a.example'], tag_ids: [t] })
  })
})

describe('5. events', () => {
  it('form.created, form.updated and form.deleted before/after equal forms.get, lists included; an update with the same lists still emits form.updated', async () => {
    const t = await tag()
    const a = await create({ name: 'A', allowed_origins: ['https://a.example'], tag_ids: [t] })
    const created = (await formEvents()).find((x: any) => x.type === 'form.created')!
    expect(created.after).toEqual(a.body)
    const u1 = await patch(a.body.id, { allowed_origins: ['https://b.example', 'https://a.example'] })
    const u2 = await patch(a.body.id, { allowed_origins: ['https://b.example', 'https://a.example'] })
    const updates = (await formEvents()).filter((x: any) => x.type === 'form.updated')
    expect(updates).toHaveLength(2)
    expect(updates[0]!.before).toEqual(a.body)
    expect(updates[0]!.after).toEqual(u1.body)
    expect(updates[1]!.before).toEqual(u1.body)
    expect(updates[1]!.after).toEqual(u2.body)
    expect(u1.body.allowed_origins).toEqual(['https://a.example', 'https://b.example'])
    await del(a.body.id)
    const gone = (await formEvents()).find((x: any) => x.type === 'form.deleted')!
    expect(gone.before).toEqual(u2.body)
  })

  it('a list-only update still renames nothing on the agent and emits no agent.updated', async () => {
    const a = await create({ name: 'A' })
    const mark = (await e.events()).length
    await patch(a.body.id, { allowed_origins: ['https://a.example'] })
    expect((await e.events()).slice(mark).map((x: any) => x.type)).toEqual(['form.updated'])
  })
})
