import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { captureMessage } from '../test/capture-kit.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// [[CORE131]] over REST on the D1 app: the privacy split (D5, D6), the six filters (D5, D7), never writable (D1) and the
// OpenAPI document (D12). Interaction rows come only from the capture unit (D14).
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const OWNER = 'owner@vault.test'
const BASE = ['contacts:read', 'contacts:write']
const WITH = [...BASE, 'interactions:read']
const FULL = [...WITH, 'tags:read', 'tags:write', 'associations:read', 'associations:write', 'companies:read', 'companies:write']
const FIELDS = ['last_contacted_at', 'last_interacted_at'] as const

let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVaultRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const res = await s.call(t, 'agent', scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}
const must = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const r = await call(scopes, method, path, body)
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}
const addContact = async (name: string, address: string) => {
  const c = await must(FULL, 'POST', '/api/v1/contacts', { name })
  await must(FULL, 'POST', '/api/v1/identities', { kind: 'email', value: address, contact_id: c.id })
  return c.id as string
}
const messageFrom = (from: string, at: string) =>
  captureMessage(t.organizationId, {
    occurred_at: at,
    author: { user_id: from, user_name: from, full_name: from, is_bot: false },
    participants: [
      { kind: 'email', value: from, role: 'from' },
      { kind: 'email', value: OWNER, role: 'to' },
    ],
  })
const messageTo = (to: string, at: string) =>
  captureMessage(t.organizationId, {
    occurred_at: at,
    sent_by_connection: true,
    author: { user_id: OWNER, user_name: OWNER, full_name: 'Owner', is_bot: false },
    participants: [
      { kind: 'email', value: OWNER, role: 'from' },
      { kind: 'email', value: to, role: 'to' },
    ],
  })

const T_A = '2026-10-10T00:00:00.000Z' // A: inbound only
const T_B = '2026-10-15T12:00:00.000Z' // B: outbound
const T_D = '2026-09-01T00:00:00.000Z' // D: old outbound
/** A inbound-only, B outbound, C never, D old outbound. Returns the ids by name. */
async function seedFour(): Promise<Record<'A' | 'B' | 'C' | 'D', string>> {
  await must(FULL, 'POST', '/api/v1/identities', { kind: 'email', value: OWNER, own: true })
  const ids = { A: await addContact('A', 'a@x.test'), B: await addContact('B', 'b@x.test'), C: await addContact('C', 'c@x.test'), D: await addContact('D', 'd@x.test') }
  await s.capture(t, { connection_id: C1, messages: [messageFrom('a@x.test', T_A), messageTo('b@x.test', T_B), messageTo('d@x.test', T_D)] })
  return ids
}
const names = (ids: Record<string, string>, body: any): string[] => {
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]))
  return body.data.map((c: any) => byId[c.id]).sort()
}

describe('visibility by interactions:read (D5, D6)', () => {
  it('with the scope both keys are present, null on a quiet contact and a value after capture', async () => {
    const ids = await seedFour()
    const c = await must(WITH, 'GET', `/api/v1/contacts/${ids.C}`)
    expect(c).toMatchObject({ last_contacted_at: null, last_interacted_at: null })
    const a = await must(WITH, 'GET', `/api/v1/contacts/${ids.A}`)
    expect(a).toMatchObject({ last_contacted_at: null, last_interacted_at: T_A })
    const b = await must(WITH, 'GET', `/api/v1/contacts/${ids.B}`)
    expect(b).toMatchObject({ last_contacted_at: T_B, last_interacted_at: T_B })
  })

  // Every operation of D6 that returns a contact, both fields, with and without the scope (B has T_B for both; merge takes C then D).
  type Run = (scopes: string[], ids: Record<string, string>, source: string) => Promise<any>
  const operations: Array<{ name: string; extra: string[]; expectValue: boolean; run: Run }> = [
    { name: 'contacts.list', extra: [], expectValue: true, run: async (sc, ids) => (await must(sc, 'GET', '/api/v1/contacts')).data.find((c: any) => c.id === ids.B) },
    { name: 'contacts.get', extra: [], expectValue: true, run: (sc, ids) => must(sc, 'GET', `/api/v1/contacts/${ids.B}`) },
    { name: 'contacts.get include=associations', extra: ['associations:read'], expectValue: true, run: (sc, ids) => must(sc, 'GET', `/api/v1/contacts/${ids.B}?include=associations`) },
    { name: 'contacts.create', extra: [], expectValue: false, run: (sc) => must(sc, 'POST', '/api/v1/contacts', { name: 'New' }) },
    { name: 'contacts.update', extra: [], expectValue: true, run: (sc, ids) => must(sc, 'PATCH', `/api/v1/contacts/${ids.B}`, { name: 'B2' }) },
    { name: 'contacts.merge', extra: [], expectValue: true, run: (sc, ids, source) => must(sc, 'POST', `/api/v1/contacts/${ids.B}/merge`, { source_id: source }) },
  ]
  for (const op of operations) {
    for (const field of FIELDS) {
      it(`${op.name}: ${field} is present with interactions:read and absent (not null) without it`, async () => {
        const ids = await seedFour()
        const withIt = await op.run([...WITH, ...op.extra], ids, ids.C!)
        expect(field in withIt, 'present with the scope').toBe(true)
        expect(withIt[field]).toBe(op.expectValue ? T_B : null)
        const without = await op.run([...BASE, ...op.extra], ids, ids.D!)
        expect(field in without, 'absent without the scope').toBe(false)
      })
    }
  }

  it('the contact nested in identities.resolve and the association neighbours never carry them, whatever the scopes', async () => {
    const ids = await seedFour()
    const resolved = await must(FULL, 'POST', '/api/v1/identities/resolve', { identities: [{ kind: 'email', value: 'b@x.test' }] })
    expect(resolved.data[0].contact.id).toBe(ids.B)
    for (const f of FIELDS) expect(f in resolved.data[0].contact).toBe(false)
    const co = await must(FULL, 'POST', '/api/v1/companies', { name: 'Acme' })
    await must(FULL, 'POST', '/api/v1/associations', { a_type: 'companies', a_id: co.id, b_type: 'contacts', b_id: ids.B })
    const edges = await must(FULL, 'GET', `/api/v1/associations?type=companies&id=${co.id}`)
    expect(edges.data).toHaveLength(1)
    for (const f of FIELDS) expect(f in edges.data[0]).toBe(false)
  })

  it('events never carry them (D2): a contact with a value updates, and no event payload has a derived key', async () => {
    const ids = await seedFour()
    await must(FULL, 'PATCH', `/api/v1/contacts/${ids.B}`, { name: 'Renamed' })
    const events = await s.eventsOf(ids.B)
    expect(events.length).toBeGreaterThan(0)
    for (const ev of events) for (const side of [ev.before, ev.after]) for (const f of FIELDS) expect(side && f in side).toBeFalsy()
  })
})

describe('filters are refused without interactions:read (D5)', () => {
  const FILTERS = ['contacted_since=2026-10-01T00:00:00Z', 'not_contacted_since=2026-10-01T00:00:00Z', 'never_contacted=true', 'interacted_since=2026-10-01T00:00:00Z', 'not_interacted_since=2026-10-01T00:00:00Z', 'never_interacted=true']
  for (const f of FILTERS) {
    it(`${f.split('=')[0]} answers 403 insufficient_scope naming interactions:read and runs no query`, async () => {
      await seedFour()
      const before = await s.countEvents()
      const res = await call(BASE, 'GET', `/api/v1/contacts?${f}`)
      expect([res.status, res.body.error.code]).toEqual([403, 'insufficient_scope'])
      expect(res.body.error.message).toContain('interactions:read')
      expect(await s.countEvents()).toBe(before)
      expect((await call(WITH, 'GET', `/api/v1/contacts?${f}`)).status).toBe(200)
    })
  }
})

describe('the six filters (D7)', () => {
  const list = async (query: string) => call(WITH, 'GET', `/api/v1/contacts?${query}`)

  it('contacted_since includes a contact at exactly t; not_contacted_since excludes it and includes never-contacted', async () => {
    const ids = await seedFour()
    expect(names(ids, (await list(`contacted_since=${T_B}`)).body)).toEqual(['B'])
    expect(names(ids, (await list(`not_contacted_since=${T_B}`)).body)).toEqual(['A', 'C', 'D'])
    expect(names(ids, (await list(`contacted_since=${T_D}`)).body)).toEqual(['B', 'D'])
    expect(names(ids, (await list(`not_contacted_since=${T_D}`)).body)).toEqual(['A', 'C'])
  })

  it('never_contacted=true and =false partition the contacts', async () => {
    const ids = await seedFour()
    const yes = names(ids, (await list('never_contacted=true')).body)
    const no = names(ids, (await list('never_contacted=false')).body)
    expect(yes).toEqual(['A', 'C'])
    expect(no).toEqual(['B', 'D'])
    expect([...yes, ...no].sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('the interacted twins: an inbound-only contact is interacted but never contacted', async () => {
    const ids = await seedFour()
    expect(names(ids, (await list(`interacted_since=${T_A}`)).body)).toEqual(['A', 'B'])
    expect(names(ids, (await list(`not_interacted_since=${T_A}`)).body)).toEqual(['C', 'D'])
    expect(names(ids, (await list('never_interacted=true')).body)).toEqual(['C'])
    expect(names(ids, (await list('never_interacted=false')).body)).toEqual(['A', 'B', 'D'])
    // the families differ on A
    expect(names(ids, (await list('never_contacted=true')).body)).toContain('A')
    expect(names(ids, (await list('never_interacted=true')).body)).not.toContain('A')
  })

  it('a filter ANDs with tag_id', async () => {
    const ids = await seedFour()
    const tag = await must(FULL, 'POST', '/api/v1/tags', { name: 'Prospects' })
    for (const id of [ids.B, ids.C]) await must(FULL, 'POST', '/api/v1/associations', { a_type: 'contacts', a_id: id, b_type: 'tags', b_id: tag.id })
    const res = await call(FULL, 'GET', `/api/v1/contacts?tag_id=${tag.id}&never_contacted=true`)
    expect(res.status).toBe(200)
    expect(names(ids, res.body)).toEqual(['C'])
  })

  it('an offset normalises to the same UTC instant as its Z form', async () => {
    const ids = await seedFour()
    const offset = encodeURIComponent('2026-10-15T14:00:00+02:00')
    expect(names(ids, (await list(`contacted_since=${offset}`)).body)).toEqual(['B'])
    expect(names(ids, (await list(`not_contacted_since=${offset}`)).body)).toEqual(['A', 'C', 'D'])
    expect(names(ids, (await list(`contacted_since=${encodeURIComponent('2026-10-15T14:00:01+02:00')}`)).body)).toEqual([])
  })

  it('a date alone, a relative value and a non-true/false boolean are 400 validation_error', async () => {
    await seedFour()
    for (const q of ['contacted_since=2026-10-15', 'not_contacted_since=30d', 'interacted_since=yesterday', 'never_contacted=1', 'never_contacted=yes', 'never_interacted=TRUE', 'never_interacted=']) {
      const res = await list(q)
      expect([res.status, res.body.error.code], q).toEqual([400, 'validation_error'])
    }
  })

  it('sort and order do not exist yet: they are refused as unknown filters', async () => {
    await seedFour()
    const res = await list('sort=last_contacted_at')
    expect([res.status, res.body.error.code]).toEqual([400, 'validation_error'])
    expect(res.body.error.message).toContain('sort')
  })
})

describe('never writable (D1)', () => {
  it('contacts.create and contacts.update with either derived field answer 400 validation_error', async () => {
    const c = await must(FULL, 'POST', '/api/v1/contacts', { name: 'W' })
    for (const f of FIELDS) {
      const created = await call(FULL, 'POST', '/api/v1/contacts', { name: 'X', [f]: '2026-10-01T00:00:00.000Z' })
      expect([created.status, created.body.error.code], `create ${f}`).toEqual([400, 'validation_error'])
      const updated = await call(FULL, 'PATCH', `/api/v1/contacts/${c.id}`, { [f]: null })
      expect([updated.status, updated.body.error.code], `update ${f}`).toEqual([400, 'validation_error'])
    }
  })
})

describe('the OpenAPI document (D12)', () => {
  it('carries the six filters with descriptions on contacts.list and the two optional fields on the contact schema', async () => {
    const res = await s.app.request('/api/v1/openapi.json')
    const doc = (await res.json()) as any
    const get = doc.paths['/api/v1/contacts'].get
    const params = Object.fromEntries(get.parameters.map((p: any) => [p.name, p]))
    for (const f of ['contacted_since', 'not_contacted_since', 'never_contacted', 'interacted_since', 'not_interacted_since', 'never_interacted']) {
      expect(params[f], f).toBeDefined()
      expect(String(params[f].description ?? params[f].schema?.description ?? ''), `${f} description`).not.toBe('')
      expect(params[f].required).not.toBe(true)
    }
    expect(params.sort).toBeUndefined()
    const schema = get.responses['200'].content['application/json'].schema
    const item = schema.properties.data.items
    const props = (item.$ref ? doc.components.schemas[item.$ref.split('/').pop()] : item).properties
    for (const f of FIELDS) expect(props[f], f).toBeDefined()
    const required = (item.$ref ? doc.components.schemas[item.$ref.split('/').pop()] : item).required ?? []
    for (const f of FIELDS) expect(required).not.toContain(f)
  })
})
