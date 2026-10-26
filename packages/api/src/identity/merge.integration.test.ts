import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { createOperation, deleteOperation, getOperation } from '../storage/crud.js'
import { openEngines, type Engine } from '../test/engines.js'
import { foreignTenant, identityKit, type IdentityKit } from '../test/identity-kit.js'
import { mergeOperation } from './merge.js'

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('contacts.merge on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })
  const merge = (survivor: string, source: string, opts?: Parameters<typeof mergeOperation>[3]) => k.run((env) => mergeOperation(env, survivor, source, opts))
  const identitiesOf = async (contactId: string) => (await e.rows('identities')).filter((i) => i.contact_id === contactId)
  const mkIdentity = (contact_id: string, value: string) => k.identity({ kind: 'email', value, contact_id })

  it('moves the live identities of the source; a deleted identity stays', async () => {
    const s = await k.contact({})
    const r = await k.contact({})
    await mkIdentity(s.id, 's@x.com')
    const r1 = await mkIdentity(r.id, 'r1@x.com')
    const r2 = await mkIdentity(r.id, 'r2@x.com')
    const r3 = await mkIdentity(r.id, 'r3@x.com')
    await k.run((env) => deleteOperation(identities, env, r3.id))
    await merge(s.id, r.id)
    const onS = (await identitiesOf(s.id)).filter((i) => i.deleted_at === null).map((i) => i.id)
    expect(onS).toHaveLength(3)
    expect(onS).toEqual(expect.arrayContaining([r1.id, r2.id]))
    expect((await identitiesOf(r.id)).map((i) => i.id)).toEqual([r3.id])
  })

  it('fills the survivor empty fields and never overwrites, with one contact.updated (before/after)', async () => {
    const c1 = await k.company({ name: 'C1' })
    const c2 = await k.company({ name: 'C2' })
    const s = await k.contact({ company_id: c1.id })
    const r = await k.contact({ name: 'Rita', company_id: c2.id })
    const mark = (await k.events()).length
    const out = await merge(s.id, r.id)
    expect(out).toMatchObject({ name: 'Rita', company_id: c1.id })
    const upd = (await k.events()).slice(mark).filter((x) => x.type === 'contact.updated')
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({ resource_id: s.id, actor_id: e.userId })
    expect(upd[0]!.before.name).toBeNull()
    expect(upd[0]!.after).toMatchObject({ name: 'Rita', company_id: c1.id })
  })

  it('writes no contact.updated when there is nothing to fill', async () => {
    const s = await k.contact({ name: 'S' })
    const r = await k.contact({ name: 'R' })
    const mark = (await k.events()).length
    await merge(s.id, r.id)
    expect((await k.events()).slice(mark).filter((x) => x.type === 'contact.updated')).toHaveLength(0)
  })

  it('tombstones the source and hides it from get', async () => {
    const s = await k.contact({})
    const r = await k.contact({})
    await merge(s.id, r.id)
    const row = await k.row('contacts', r.id)
    expect(row.deleted_at).not.toBeNull()
    expect(row.merged_into_id).toBe(s.id)
    expect(row.updated_at).toBe(row.deleted_at)
    expect((await k.fail((env) => getOperation(contacts, env, r.id))).code).toBe('not_found')
  })

  it('emits contact.merged with the source record before and the tombstone after, and no contact.deleted', async () => {
    const s = await k.contact({})
    const r = await k.contact({})
    const mark = (await k.events()).length
    await merge(s.id, r.id)
    const ev = (await k.events()).slice(mark)
    const merged = ev.filter((x) => x.type === 'contact.merged')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ resource_id: r.id, resource_type: 'contact', actor_id: e.userId })
    expect(merged[0]!.before).toEqual(r)
    expect(merged[0]!.after).toMatchObject({ id: r.id, merged_into_id: s.id })
    expect(ev.filter((x) => x.type === 'contact.deleted')).toHaveLength(0)
  })

  it('writes identity.updated, then contact.updated, then contact.merged', async () => {
    const s = await k.contact({})
    const r = await k.contact({ name: 'Rita' })
    await mkIdentity(r.id, 'r@x.com')
    const mark = (await k.events()).length
    await merge(s.id, r.id)
    expect((await k.events()).slice(mark).map((x) => x.type)).toEqual(['identity.updated', 'contact.updated', 'contact.merged'])
  })

  it('returns the survivor equal to a fresh get', async () => {
    const s = await k.contact({ name: 'S' })
    const r = await k.contact({})
    expect(await merge(s.id, r.id)).toEqual(await k.get(contacts, s.id))
  })

  it('refuses a self-merge (upper-cased id too) and writes nothing', async () => {
    const s = await k.contact({})
    const mark = (await k.events()).length
    const err = await k.fail((env) => mergeOperation(env, s.id, s.id.toUpperCase()))
    expect([err.status, err.code]).toEqual([400, 'merge_into_self'])
    expect(await k.events()).toHaveLength(mark)
  })

  it('refuses an already merged source, a deleted survivor and a missing contact as not_found', async () => {
    const s = await k.contact({})
    const x = await k.contact({})
    const r = await k.contact({})
    await merge(x.id, r.id)
    expect((await k.fail((env) => mergeOperation(env, s.id, r.id))).code).toBe('not_found')
    const gone = await k.contact({})
    await k.deleteContact(gone.id)
    expect((await k.fail((env) => mergeOperation(env, gone.id, s.id))).code).toBe('not_found')
    expect((await k.fail((env) => mergeOperation(env, s.id, '0190b2c4-0000-7000-8000-00000000dead'))).code).toBe('not_found')
  })

  it('never rewrites a tombstone pointer', async () => {
    const s = await k.contact({})
    const r = await k.contact({})
    const t = await k.contact({})
    await merge(s.id, r.id)
    await merge(t.id, s.id)
    const rows = await e.rows('contacts')
    expect(rows.find((x) => x.id === r.id)!.merged_into_id).toBe(s.id)
    expect(rows.find((x) => x.id === s.id)!.merged_into_id).toBe(t.id)
  })

  it('a catalog entry with liveOnly: false moves deleted rows too', async () => {
    const s = await k.contact({})
    const r = await k.contact({})
    const i1 = await mkIdentity(r.id, 'r1@x.com')
    const i2 = await mkIdentity(r.id, 'r2@x.com')
    await k.run((env) => deleteOperation(identities, env, i2.id))
    const mark = (await k.events()).length
    await merge(s.id, r.id, { catalog: [{ def: identities, table: 'identities', column: 'contact_id', liveOnly: false }] })
    expect((await identitiesOf(s.id)).map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort())
    const ev = (await k.events()).slice(mark).filter((x) => x.type === 'identity.updated')
    expect(ev).toHaveLength(2)
    for (const x of ev) {
      expect(x.before.contact_id).toBe(r.id)
      expect(x.after.contact_id).toBe(s.id)
    }
  })

  if (name === 'postgres') {
    it("refuses another organisation's contact as not_found and leaves it untouched", async () => {
      const s = await k.contact({})
      const other = await foreignTenant(e)
      const theirs = await other.run(createOperation(contacts, other.env(), {}))
      expect((await k.fail((env) => mergeOperation(env, s.id, theirs.id))).code).toBe('not_found')
      expect((await k.row('contacts', theirs.id)).deleted_at).toBeNull()
    })
  }
})
