import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { asAgent, asUser, seedTenant, type Tenant } from '../test/tenant.js'
import { createResource, deleteResource, listResource, updateResource } from './crud.js'
import { companies } from './companies.js'
import { contacts } from './contacts.js'
import { identities } from './identities.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let a: Tenant
let b: Tenant

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
beforeEach(async () => {
  await truncateAll(owner)
  a = await seedTenant(db, 'A')
  b = await seedTenant(db, 'B')
})

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => undefined, (e) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}
// Insert order, not id order: same-millisecond UUIDv7s are not monotonic (db-schema-and-migrations).
const events = (prefixes = ['company.', 'contact.', 'identity.']) =>
  owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute().then((rows) => rows.filter((r) => prefixes.some((p) => r.type.startsWith(p))))
const count = async (table: 'companies' | 'contacts' | 'identities') =>
  Number((await owner.selectFrom(table).select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)
const mkCompany = (t: Tenant, input: Record<string, unknown> = { name: 'C' }) => asUser(db, t, (ctx) => createResource(ctx, companies, input))
const mkContact = (t: Tenant, input: Record<string, unknown> = {}) => asUser(db, t, (ctx) => createResource(ctx, contacts, input))
const mkIdentity = (t: Tenant, input: Record<string, unknown>) => asUser(db, t, (ctx) => createResource(ctx, identities, input))

describe('companies', () => {
  it('create normalises domain', async () => {
    const c = await mkCompany(a, { name: 'Acme', domain: ' Acme.COM ' })
    expect(c.domain).toBe('acme.com')
    const ev = await events()
    expect(ev.map((e) => e.type)).toEqual(['company.created'])
    expect((ev[0]!.after as any).domain).toBe('acme.com')
  })
  it('duplicate domain on create', async () => {
    const first = await mkCompany(a, { name: 'A', domain: 'acme.com' })
    const e = await apiError(mkCompany(a, { name: 'X', domain: 'ACME.com' }))
    expect([e.status, e.code, e.message]).toEqual([409, 'domain_exists', `a company with domain acme.com already exists (${first.id})`])
    expect(await count('companies')).toBe(1)
    expect(await events()).toHaveLength(1)
  })
  it('duplicate domain on update', async () => {
    await mkCompany(a, { name: 'A', domain: 'acme.com' })
    const second = await mkCompany(a, { name: 'B', domain: 'b.com' })
    const e = await apiError(asUser(db, a, (ctx) => updateResource(ctx, companies, second.id, { domain: 'acme.com' })))
    expect(e.code).toBe('domain_exists')
    expect((await owner.selectFrom('companies').select('domain').where('id', '=', second.id).executeTakeFirstOrThrow()).domain).toBe('b.com')
  })
  it('own domain on update is fine', async () => {
    const c = await mkCompany(a, { name: 'A', domain: 'acme.com' })
    const u = await asUser(db, a, (ctx) => updateResource(ctx, companies, c.id, { domain: 'ACME.COM', name: 'New' }))
    expect(u.name).toBe('New')
    expect((await events()).filter((e) => e.type === 'company.updated')).toHaveLength(1)
  })
  it('domain reusable after delete', async () => {
    const c = await mkCompany(a, { name: 'A', domain: 'acme.com' })
    await asUser(db, a, (ctx) => deleteResource(ctx, companies, c.id))
    await expect(mkCompany(a, { name: 'A2', domain: 'acme.com' })).resolves.toMatchObject({ domain: 'acme.com' })
  })
  it('same domain in other org', async () => {
    await mkCompany(a, { name: 'A', domain: 'acme.com' })
    await expect(mkCompany(b, { name: 'B', domain: 'acme.com' })).resolves.toBeDefined()
  })
  it('invalid domain', async () => {
    const e = await apiError(mkCompany(a, { name: 'X', domain: 'https://acme.com' }))
    expect([e.status, e.code]).toEqual([400, 'validation_error'])
  })
  it('domain filter normalises', async () => {
    const c = await mkCompany(a, { name: 'A', domain: 'acme.com' })
    const r = await asUser(db, a, (ctx) => listResource(ctx, companies, { filters: { domain: 'ACME.com' } }))
    expect(r.data.map((x) => x.id)).toEqual([c.id])
  })
  it('delete unlinks contacts (D15)', async () => {
    const co = await mkCompany(a)
    const k1 = await mkContact(a, { company_id: co.id })
    const k2 = await mkContact(a, { company_id: co.id })
    const k3 = await mkContact(a, { company_id: co.id })
    await asUser(db, a, (ctx) => deleteResource(ctx, contacts, k3.id))
    const mark = (await events()).length
    await asUser(db, a, (ctx) => deleteResource(ctx, companies, co.id))
    const ev = (await events()).slice(mark)
    expect(ev.map((e) => e.type)).toEqual(['company.deleted', 'contact.updated', 'contact.updated'])
    expect(ev.slice(1).map((e) => e.resource_id)).toEqual([k1.id, k2.id].sort())
    for (const e of ev.slice(1)) {
      expect((e.before as any).company_id).toBe(co.id)
      expect((e.after as any).company_id).toBeNull()
    }
    for (const e of ev) expect(e.actor_id).toBe(a.userId)
    const rows = await owner.selectFrom('contacts').select(['id', 'company_id']).execute()
    expect(rows.find((r) => r.id === k1.id)!.company_id).toBeNull()
    expect(rows.find((r) => r.id === k3.id)!.company_id).toBe(co.id)
  })
})

describe('contacts', () => {
  it('create empty', async () => {
    expect(await mkContact(a)).toMatchObject({ name: null, company_id: null, merged_into_id: null })
  })
  it('company reference checked', async () => {
    const other = await mkCompany(b)
    const e = await apiError(mkContact(a, { company_id: other.id }))
    expect([e.status, e.code]).toEqual([400, 'invalid_reference'])
    expect(await count('contacts')).toBe(0)
  })
  it('deleted company refused', async () => {
    const c = await mkCompany(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, companies, c.id))
    expect((await apiError(mkContact(a, { company_id: c.id }))).code).toBe('invalid_reference')
  })
  it('company_id filter', async () => {
    const c = await mkCompany(a)
    const k = await mkContact(a, { company_id: c.id })
    await mkContact(a)
    const r = await asUser(db, a, (ctx) => listResource(ctx, contacts, { filters: { company_id: c.id } }))
    expect(r.data.map((x) => x.id)).toEqual([k.id])
  })
  it('delete cascades to identities (D15)', async () => {
    const k = await mkContact(a)
    const i1 = await mkIdentity(a, { kind: 'email', value: 'x@y.com', contact_id: k.id })
    const i2 = await mkIdentity(a, { kind: 'phone', value: '+14155550100', contact_id: k.id })
    const mark = (await events()).length
    await asUser(db, a, (ctx) => deleteResource(ctx, contacts, k.id))
    const ev = (await events()).slice(mark)
    expect(ev.map((e) => e.type)).toEqual(['contact.deleted', 'identity.deleted', 'identity.deleted'])
    expect(ev.slice(1).map((e) => e.resource_id)).toEqual([i1.id, i2.id].sort())
    for (const e of ev.slice(1)) {
      expect((e.before as any).id).toBe(e.resource_id)
      expect(e.after).toBeNull()
    }
    const rows = await owner.selectFrom('identities').select('deleted_at').execute()
    expect(rows.every((r) => r.deleted_at !== null)).toBe(true)
    const k2 = await mkContact(a)
    await expect(mkIdentity(a, { kind: 'email', value: 'x@y.com', contact_id: k2.id })).resolves.toBeDefined()
  })
  it('merged_into_id not writable', async () => {
    const k = await mkContact(a)
    const other = await mkContact(a)
    const e = await apiError(asUser(db, a, (ctx) => updateResource(ctx, contacts, k.id, { merged_into_id: other.id })))
    expect(e.code).toBe('validation_error')
  })
})

describe('identities', () => {
  it('create normalises', async () => {
    const k = await mkContact(a)
    expect(await mkIdentity(a, { kind: 'email', value: ' Ori@Example.com ', contact_id: k.id })).toMatchObject({ value: 'ori@example.com', own: false })
  })
  it('create own', async () => {
    expect(await mkIdentity(a, { kind: 'email', value: 'me@us.com', own: true })).toMatchObject({ contact_id: null, own: true })
  })
  it('owner rule', async () => {
    const k = await mkContact(a)
    for (const input of [
      { kind: 'email', value: 'a@b.com', contact_id: k.id, own: true },
      { kind: 'email', value: 'a@b.com' },
    ]) {
      const e = await apiError(mkIdentity(a, input))
      expect([e.status, e.code, e.message]).toEqual([400, 'validation_error', 'exactly one of contact_id or own: true is required'])
    }
  })
  it('invalid value', async () => {
    const k = await mkContact(a)
    const e = await apiError(mkIdentity(a, { kind: 'phone', value: '020 7946 0958', contact_id: k.id }))
    expect([e.status, e.code]).toEqual([400, 'invalid_identity'])
  })
  it('identity_exists (contact)', async () => {
    const x = await mkContact(a)
    const y = await mkContact(a)
    await mkIdentity(a, { kind: 'email', value: 'ori@example.com', contact_id: x.id })
    const mark = (await events()).length
    const e = await apiError(mkIdentity(a, { kind: 'email', value: 'ORI@example.com', contact_id: y.id }))
    expect([e.status, e.code, e.message]).toEqual([409, 'identity_exists', `the address already belongs to contact ${x.id}`])
    expect(await count('identities')).toBe(1)
    expect(await events()).toHaveLength(mark)
  })
  it('identity_exists (own)', async () => {
    const y = await mkContact(a)
    await mkIdentity(a, { kind: 'email', value: 'me@us.com', own: true })
    const e = await apiError(mkIdentity(a, { kind: 'email', value: 'me@us.com', contact_id: y.id }))
    expect([e.status, e.code, e.message]).toEqual([409, 'identity_exists', 'the address is already an own identity'])
  })
  it('cross-tenant contact refused', async () => {
    const k = await mkContact(b)
    const e = await apiError(mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: k.id }))
    expect([e.status, e.code]).toEqual([400, 'invalid_reference'])
  })
  it('move to another contact', async () => {
    const x = await mkContact(a)
    const y = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: x.id })
    const mark = (await events()).length
    const u = await asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, { contact_id: y.id }))
    expect(u).toMatchObject({ contact_id: y.id, own: false })
    expect((await events()).slice(mark).map((e) => e.type)).toEqual(['identity.updated'])
  })
  it('move to own', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: x.id })
    expect(await asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, { own: true }))).toMatchObject({ contact_id: null, own: true })
  })
  it('move from own to contact', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', own: true })
    expect(await asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, { contact_id: x.id }))).toMatchObject({ contact_id: x.id, own: false })
  })
  it('update owner rule', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: x.id })
    const e = await apiError(asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, { contact_id: x.id, own: true })))
    expect([e.status, e.code]).toEqual([400, 'validation_error'])
  })
  it('empty patch is a no-op', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: x.id })
    const mark = (await events()).length
    await asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, {}))
    expect(await events()).toHaveLength(mark)
  })
  it('immutable kind/value', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'a@b.com', contact_id: x.id })
    const e = await apiError(asUser(db, a, (ctx) => updateResource(ctx, identities, i.id, { value: 'x@y.com' })))
    expect(e.code).toBe('validation_error')
    expect((await owner.selectFrom('identities').select('value').where('id', '=', i.id).executeTakeFirstOrThrow()).value).toBe('a@b.com')
  })
  it('value filter normalises', async () => {
    const x = await mkContact(a)
    const i = await mkIdentity(a, { kind: 'email', value: 'ori@example.com', contact_id: x.id })
    const r = await asUser(db, a, (ctx) => listResource(ctx, identities, { filters: { kind: 'email', value: 'Ori@Example.COM' } }))
    expect(r.data.map((v) => v.id)).toEqual([i.id])
  })
  it('value filter needs kind', async () => {
    const e = await apiError(asUser(db, a, (ctx) => listResource(ctx, identities, { filters: { value: 'ori@example.com' } })))
    expect([e.status, e.code, e.message]).toEqual([400, 'validation_error', 'filter value requires kind'])
  })
  it('value filter invalid', async () => {
    const e = await apiError(asUser(db, a, (ctx) => listResource(ctx, identities, { filters: { kind: 'phone', value: 'abc' } })))
    expect([e.status, e.code]).toEqual([400, 'invalid_identity'])
  })
  it('own and contact_id filters', async () => {
    const x = await mkContact(a)
    const own = await mkIdentity(a, { kind: 'email', value: 'me@us.com', own: true })
    const on = await mkIdentity(a, { kind: 'email', value: 'x@us.com', contact_id: x.id })
    const ids = async (filters: Record<string, string>) => (await asUser(db, a, (ctx) => listResource(ctx, identities, { filters }))).data.map((v) => v.id)
    expect(await ids({ own: 'true' })).toEqual([own.id])
    expect(await ids({ own: 'false' })).toEqual([on.id])
    expect(await ids({ contact_id: x.id })).toEqual([on.id])
  })
  it('agents create with the agent as actor', async () => {
    const k = await asAgent(db, a, (ctx) => createResource(ctx, contacts, {}))
    const ev = await events()
    expect(ev[0]!.actor_id).toBe(a.agentId)
    expect(k.id).toBe(ev[0]!.resource_id)
    void randomUUID
  })
})
