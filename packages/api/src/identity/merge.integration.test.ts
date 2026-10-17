import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { asUser, seedTenant, type Tenant } from '../test/tenant.js'
import { createResource, deleteResource, getResource } from '../resources/crud.js'
import { companies } from '../resources/companies.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { mergeContacts, repointReferences } from './merge.js'

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

// Insert order, not id order: same-millisecond UUIDv7s are not monotonic (db-schema-and-migrations).
const events = () => owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()
async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => undefined, (e) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}
const mkContact = (t: Tenant, input: Record<string, unknown> = {}) => asUser(db, t, (ctx) => createResource(ctx, contacts, input))
const mkIdentity = (t: Tenant, contact_id: string, value: string) =>
  asUser(db, t, (ctx) => createResource(ctx, identities, { kind: 'email', value, contact_id }))
const merge = (t: Tenant, s: string, r: string) => asUser(db, t, (ctx) => mergeContacts(ctx, s, r))
const identitiesOf = (contactId: string) => owner.selectFrom('identities').selectAll().where('contact_id', '=', contactId).orderBy('id').execute()

describe('mergeContacts', () => {
  it('identities move', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    await mkIdentity(a, s.id, 's@x.com')
    const r1 = await mkIdentity(a, r.id, 'r1@x.com')
    const r2 = await mkIdentity(a, r.id, 'r2@x.com')
    const r3 = await mkIdentity(a, r.id, 'r3@x.com')
    await asUser(db, a, (ctx) => deleteResource(ctx, identities, r3.id))
    await merge(a, s.id, r.id)
    const onS = (await identitiesOf(s.id)).filter((i) => i.deleted_at === null).map((i) => i.id)
    expect(onS).toHaveLength(3)
    expect(onS).toEqual(expect.arrayContaining([r1.id, r2.id]))
    expect((await identitiesOf(r.id)).map((i) => i.id)).toEqual([r3.id])
  })
  it('fill, never overwrite', async () => {
    const c1 = await asUser(db, a, (ctx) => createResource(ctx, companies, { name: 'C1' }))
    const c2 = await asUser(db, a, (ctx) => createResource(ctx, companies, { name: 'C2' }))
    const s = await mkContact(a, { company_id: c1.id })
    const r = await mkContact(a, { name: 'Rita', company_id: c2.id })
    const mark = (await events()).length
    const out = await merge(a, s.id, r.id)
    expect(out).toMatchObject({ name: 'Rita', company_id: c1.id })
    const upd = (await events()).slice(mark).filter((e) => e.type === 'contact.updated')
    expect(upd).toHaveLength(1)
    expect(upd[0]!.resource_id).toBe(s.id)
    expect((upd[0]!.before as any).name).toBeNull()
    expect((upd[0]!.after as any).name).toBe('Rita')
  })
  it('nothing to fill', async () => {
    const s = await mkContact(a, { name: 'S' })
    const r = await mkContact(a, { name: 'R' })
    const mark = (await events()).length
    await merge(a, s.id, r.id)
    expect((await events()).slice(mark).filter((e) => e.type === 'contact.updated')).toHaveLength(0)
  })
  it('tombstone', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    await merge(a, s.id, r.id)
    const row = await owner.selectFrom('contacts').select(['deleted_at', 'merged_into_id']).where('id', '=', r.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    expect(row.merged_into_id).toBe(s.id)
    expect((await apiError(asUser(db, a, (ctx) => getResource(ctx, contacts, r.id)))).code).toBe('not_found')
  })
  it('contact.merged event', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    const mark = (await events()).length
    await merge(a, s.id, r.id)
    const ev = (await events()).slice(mark)
    const merged = ev.filter((e) => e.type === 'contact.merged')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ resource_id: r.id, resource_type: 'contact', actor_id: a.userId })
    expect(merged[0]!.before).toEqual(r)
    expect(merged[0]!.after).toMatchObject({ id: r.id, merged_into_id: s.id })
    expect(ev.filter((e) => e.type === 'contact.deleted')).toHaveLength(0)
  })
  it('event order', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a, { name: 'Rita' })
    await mkIdentity(a, r.id, 'r@x.com')
    const mark = (await events()).length
    await merge(a, s.id, r.id)
    expect((await events()).slice(mark).map((e) => e.type)).toEqual(['identity.updated', 'contact.updated', 'contact.merged'])
  })
  it('returns survivor', async () => {
    const s = await mkContact(a, { name: 'S' })
    const r = await mkContact(a)
    const out = await merge(a, s.id, r.id)
    expect(out).toEqual(await asUser(db, a, (ctx) => getResource(ctx, contacts, s.id)))
  })
  it('self-merge', async () => {
    const s = await mkContact(a)
    const mark = (await events()).length
    const e = await apiError(merge(a, s.id, s.id))
    expect([e.status, e.code]).toEqual([400, 'merge_into_self'])
    expect(await events()).toHaveLength(mark)
  })
  it('merged source', async () => {
    const s = await mkContact(a)
    const x = await mkContact(a)
    const r = await mkContact(a)
    await merge(a, x.id, r.id)
    expect((await apiError(merge(a, s.id, r.id))).code).toBe('not_found')
  })
  it('deleted survivor', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    await asUser(db, a, (ctx) => deleteResource(ctx, contacts, s.id))
    expect((await apiError(merge(a, s.id, r.id))).code).toBe('not_found')
  })
  it('cross-tenant source', async () => {
    const s = await mkContact(a)
    const r = await mkContact(b)
    expect((await apiError(merge(a, s.id, r.id))).code).toBe('not_found')
    expect((await owner.selectFrom('contacts').select('deleted_at').where('id', '=', r.id).executeTakeFirstOrThrow()).deleted_at).toBeNull()
  })
  it('rollback leaves nothing', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    const i = await mkIdentity(a, r.id, 'r@x.com')
    const mark = (await events()).length
    await expect(
      asUser(db, a, async (ctx) => {
        await mergeContacts(ctx, s.id, r.id)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await owner.selectFrom('contacts').select('deleted_at').where('id', '=', r.id).executeTakeFirstOrThrow()).deleted_at).toBeNull()
    expect((await identitiesOf(r.id)).map((x) => x.id)).toEqual([i.id])
    expect(await events()).toHaveLength(mark)
  })
  it('tombstones are not rewritten (D10)', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    const t = await mkContact(a)
    await merge(a, s.id, r.id)
    await merge(a, t.id, s.id)
    const rows = await owner.selectFrom('contacts').select(['id', 'merged_into_id']).execute()
    expect(rows.find((x) => x.id === r.id)!.merged_into_id).toBe(s.id)
    expect(rows.find((x) => x.id === s.id)!.merged_into_id).toBe(t.id)
  })
  it('generic re-point honours liveOnly: false', async () => {
    const s = await mkContact(a)
    const r = await mkContact(a)
    const i1 = await mkIdentity(a, r.id, 'r1@x.com')
    const i2 = await mkIdentity(a, r.id, 'r2@x.com')
    await asUser(db, a, (ctx) => deleteResource(ctx, identities, i2.id))
    const mark = (await events()).length
    await asUser(db, a, (ctx) => repointReferences(ctx, [{ def: identities, column: 'contact_id', liveOnly: false }], r.id, s.id))
    expect((await identitiesOf(s.id)).map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort())
    const ev = (await events()).slice(mark)
    expect(ev.map((e) => e.type)).toEqual(['identity.updated', 'identity.updated'])
    for (const e of ev) {
      expect((e.before as any).contact_id).toBe(r.id)
      expect((e.after as any).contact_id).toBe(s.id)
    }
  })
})
