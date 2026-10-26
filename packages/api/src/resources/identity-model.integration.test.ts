import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { companies } from './companies.js'
import { contacts } from './contacts.js'
import { identities } from './identities.js'
import { createOperation, listOperation, updateOperation } from '../storage/crud.js'
import { openEngines, type Engine } from '../test/engines.js'
import { foreignTenant, identityKit, type IdentityKit } from '../test/identity-kit.js'

// The identity model's resources on both engines (CORE36 C7: Companies, Contacts, Identities). Exact statuses,
// codes and messages; cross-organisation cases run on Postgres only (a D1 database holds one organisation).
let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('identity model resources on %s', (name) => {
  let e: Engine
  let k: IdentityKit
  const postgres = name === 'postgres'
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    k = identityKit(e)
  })

  describe('companies', () => {
    it('create normalises the domain and emits company.created', async () => {
      const c = await k.company({ name: 'Acme', domain: ' Acme.COM ' })
      expect(c).toMatchObject({ name: 'Acme', domain: 'acme.com', organization_id: e.organizationId, created_by: e.userId })
      const ev = await k.events()
      expect(ev.map((x) => x.type)).toEqual(['company.created'])
      expect(ev[0]).toMatchObject({ actor_id: e.userId, before: null, after: c })
    })

    it('a duplicate domain on create is domain_exists with the other company id, no row, no event', async () => {
      const first = await k.company({ name: 'A', domain: 'acme.com' })
      const err = await k.fail((env) => createOperation(companies, env, { name: 'X', domain: 'ACME.com' }))
      expect(k.shape(err)).toEqual([409, 'domain_exists', `a company with domain acme.com already exists (${first.id})`])
      expect(await k.count('companies')).toBe(1)
      expect(await k.events()).toHaveLength(1)
    })

    it('a duplicate domain on update is refused and the row is untouched', async () => {
      await k.company({ name: 'A', domain: 'acme.com' })
      const second = await k.company({ name: 'B', domain: 'b.com' })
      const err = await k.fail((env) => updateOperation(companies, env, second.id, { domain: 'acme.com' }))
      expect(err.code).toBe('domain_exists')
      expect((await k.row('companies', second.id)).domain).toBe('b.com')
    })

    it("a company's own domain on update is fine", async () => {
      const c = await k.company({ name: 'A', domain: 'acme.com' })
      const u = await k.updateCompany(c.id, { domain: 'ACME.COM', name: 'New' })
      expect(u).toMatchObject({ name: 'New', domain: 'acme.com' })
      expect((await k.events()).filter((x) => x.type === 'company.updated')).toHaveLength(1)
    })

    it('the domain is reusable after the company is deleted', async () => {
      const c = await k.company({ name: 'A', domain: 'acme.com' })
      await k.deleteCompany(c.id)
      expect(await k.company({ name: 'A2', domain: 'acme.com' })).toMatchObject({ domain: 'acme.com' })
    })

    it('an invalid domain is a validation_error', async () => {
      const err = await k.fail((env) => createOperation(companies, env, { name: 'X', domain: 'https://acme.com' }))
      expect(k.shape(err)).toEqual([400, 'validation_error', 'domain: invalid domain'])
    })

    it('the domain filter normalises like the column', async () => {
      const c = await k.company({ name: 'A', domain: 'acme.com' })
      await k.company({ name: 'B', domain: 'b.com' })
      expect((await k.list(companies, { domain: 'ACME.com' })).data.map((x) => x.id)).toEqual([c.id])
    })

    it('delete unlinks only live contacts, in id order, with before/after on every event', async () => {
      const co = await k.company({ name: 'C' })
      const k1 = await k.contact({ company_id: co.id })
      const k2 = await k.contact({ company_id: co.id })
      const k3 = await k.contact({ company_id: co.id })
      await k.deleteContact(k3.id)
      const mark = (await k.events()).length
      await k.deleteCompany(co.id)
      const ev = (await k.events()).slice(mark)
      expect(ev.map((x) => x.type)).toEqual(['company.deleted', 'contact.updated', 'contact.updated'])
      expect(ev.slice(1).map((x) => x.resource_id)).toEqual([k1.id, k2.id].sort())
      expect(ev[0]).toMatchObject({ before: expect.objectContaining({ id: co.id }), after: null })
      for (const x of ev.slice(1)) {
        expect(x.before.company_id).toBe(co.id)
        expect(x.after.company_id).toBeNull()
      }
      for (const x of ev) expect(x.actor_id).toBe(e.userId)
      expect((await k.row('contacts', k1.id)).company_id).toBeNull()
      expect((await k.row('contacts', k3.id)).company_id).toBe(co.id) // a deleted contact keeps its company_id
    })

    if (postgres) {
      it('the same domain in another organisation is fine', async () => {
        await k.company({ name: 'A', domain: 'acme.com' })
        const other = await foreignTenant(e)
        await expect(other.run(createOperation(companies, other.env(), { name: 'B', domain: 'acme.com' }))).resolves.toMatchObject({ domain: 'acme.com' })
      })
    }
  })

  describe('contacts', () => {
    it('create empty', async () => {
      expect(await k.contact({})).toMatchObject({ name: null, company_id: null, merged_into_id: null })
    })

    it('a missing company is invalid_reference and writes nothing', async () => {
      const err = await k.fail((env) => createOperation(contacts, env, { company_id: '0190b2c4-0000-7000-8000-00000000dead' }))
      expect(k.shape(err)).toEqual([400, 'invalid_reference', 'a referenced record does not exist'])
      expect(await k.count('contacts')).toBe(0)
      expect(await k.events()).toHaveLength(0)
    })

    it('a deleted company is invalid_reference', async () => {
      const c = await k.company({ name: 'C' })
      await k.deleteCompany(c.id)
      const err = await k.fail((env) => createOperation(contacts, env, { company_id: c.id }))
      expect(err.code).toBe('invalid_reference')
    })

    it('a company_id filter lists only that company', async () => {
      const c = await k.company({ name: 'C' })
      const member = await k.contact({ company_id: c.id })
      await k.contact({})
      expect((await k.list(contacts, { company_id: c.id })).data.map((x) => x.id)).toEqual([member.id])
    })

    it('delete tombstones the live identities, in id order, and frees their addresses', async () => {
      const c = await k.contact({})
      const i1 = await k.identity({ kind: 'email', value: 'x@y.com', contact_id: c.id })
      const i2 = await k.identity({ kind: 'phone', value: '+14155550100', contact_id: c.id })
      const gone = await k.identity({ kind: 'email', value: 'old@y.com', contact_id: c.id })
      const mark = (await k.events()).length
      await k.deleteContact(c.id)
      const ev = (await k.events()).slice(mark)
      expect(ev.map((x) => x.type)).toEqual(['contact.deleted', 'identity.deleted', 'identity.deleted', 'identity.deleted'])
      expect(ev.slice(1).map((x) => x.resource_id)).toEqual([i1.id, i2.id, gone.id].sort())
      for (const x of ev.slice(1)) {
        expect(x.before.id).toBe(x.resource_id)
        expect(x.after).toBeNull()
        expect(x.actor_id).toBe(e.userId)
      }
      expect((await e.rows('identities')).every((r) => r.deleted_at !== null && r.updated_at === r.deleted_at)).toBe(true)
      const other = await k.contact({})
      await expect(k.identity({ kind: 'email', value: 'x@y.com', contact_id: other.id })).resolves.toBeDefined()
    })

    it('merged_into_id is not writable', async () => {
      const other = await k.contact({})
      const err = await k.fail((env) => createOperation(contacts, env, { merged_into_id: other.id }))
      expect(err.code).toBe('validation_error')
    })

    if (postgres) {
      it("another organisation's company is invalid_reference", async () => {
        const other = await foreignTenant(e)
        const theirs = await other.run(createOperation(companies, other.env(), { name: 'Theirs' }))
        const err = await k.fail((env) => createOperation(contacts, env, { company_id: theirs.id }))
        expect(err.code).toBe('invalid_reference')
      })
    }
  })

  describe('identities', () => {
    it('create normalises the value', async () => {
      const c = await k.contact({})
      expect(await k.identity({ kind: 'email', value: ' Ori@Example.com ', contact_id: c.id })).toMatchObject({ value: 'ori@example.com', own: false, contact_id: c.id })
    })

    it('create own', async () => {
      expect(await k.identity({ kind: 'email', value: 'me@us.com', own: true })).toMatchObject({ contact_id: null, own: true })
    })

    it('enforces the owner rule', async () => {
      const c = await k.contact({})
      for (const input of [
        { kind: 'email', value: 'a@b.com', contact_id: c.id, own: true },
        { kind: 'email', value: 'a@b.com' },
      ]) {
        const err = await k.fail((env) => createOperation(identities, env, input))
        expect(k.shape(err)).toEqual([400, 'validation_error', 'exactly one of contact_id or own: true is required'])
      }
    })

    it('an invalid value is invalid_identity', async () => {
      const c = await k.contact({})
      const err = await k.fail((env) => createOperation(identities, env, { kind: 'phone', value: '020 7946 0958', contact_id: c.id }))
      expect([err.status, err.code]).toEqual([400, 'invalid_identity'])
    })

    it('a non-ASCII email is invalid_identity with the D7 message, never a database error', async () => {
      const c = await k.contact({})
      const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'jürgen@example.com', contact_id: c.id }))
      expect(k.shape(err)).toEqual([400, 'invalid_identity', 'non-ASCII email addresses are not supported'])
      expect(await k.count('identities')).toBe(0)
    })

    it('checks the reference before the address (P6)', async () => {
      const c = await k.contact({})
      await k.identity({ kind: 'email', value: 'taken@example.com', contact_id: c.id })
      const err = await k.fail((env) =>
        createOperation(identities, env, { kind: 'email', value: 'taken@example.com', contact_id: '0190b2c4-0000-7000-8000-00000000dead' }),
      )
      expect(err.code).toBe('invalid_reference')
    })

    it('identity_exists names the contact, and writes neither a row nor an event', async () => {
      const x = await k.contact({})
      const y = await k.contact({})
      await k.identity({ kind: 'email', value: 'ori@example.com', contact_id: x.id })
      const mark = (await k.events()).length
      const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'ORI@example.com', contact_id: y.id }))
      expect(k.shape(err)).toEqual([409, 'identity_exists', `the address already belongs to contact ${x.id}`])
      expect(await k.count('identities')).toBe(1)
      expect(await k.events()).toHaveLength(mark)
    })

    it('identity_exists for an own address', async () => {
      const y = await k.contact({})
      await k.identity({ kind: 'email', value: 'me@us.com', own: true })
      const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'me@us.com', contact_id: y.id }))
      expect(k.shape(err)).toEqual([409, 'identity_exists', 'the address is already an own identity'])
    })

    it('moves to another contact, to own, and from own back to a contact', async () => {
      const x = await k.contact({})
      const y = await k.contact({})
      const i = await k.identity({ kind: 'email', value: 'a@b.com', contact_id: x.id })
      const mark = (await k.events()).length
      expect(await k.updateIdentity(i.id, { contact_id: y.id })).toMatchObject({ contact_id: y.id, own: false })
      expect((await k.events()).slice(mark).map((v) => v.type)).toEqual(['identity.updated'])
      expect(await k.updateIdentity(i.id, { own: true })).toMatchObject({ contact_id: null, own: true })
      expect(await k.updateIdentity(i.id, { contact_id: x.id })).toMatchObject({ contact_id: x.id, own: false })
    })

    it('an update names exactly one owner', async () => {
      const x = await k.contact({})
      const i = await k.identity({ kind: 'email', value: 'a@b.com', contact_id: x.id })
      const err = await k.fail((env) => updateOperation(identities, env, i.id, { contact_id: x.id, own: true }))
      expect(k.shape(err)).toEqual([400, 'validation_error', 'exactly one of contact_id or own: true is required'])
    })

    it('an empty patch is a no-op with no event', async () => {
      const x = await k.contact({})
      const i = await k.identity({ kind: 'email', value: 'a@b.com', contact_id: x.id })
      const mark = (await k.events()).length
      expect(await k.updateIdentity(i.id, {})).toMatchObject({ id: i.id, updated_at: i.updated_at })
      expect(await k.events()).toHaveLength(mark)
    })

    it('kind and value are immutable', async () => {
      const x = await k.contact({})
      const i = await k.identity({ kind: 'email', value: 'a@b.com', contact_id: x.id })
      for (const patch of [{ value: 'x@y.com' }, { kind: 'phone' }]) {
        const err = await k.fail((env) => updateOperation(identities, env, i.id, patch))
        expect(err.code).toBe('validation_error')
      }
      expect((await k.row('identities', i.id)).value).toBe('a@b.com')
    })

    it('filters: value normalises and needs kind; own and contact_id', async () => {
      const x = await k.contact({})
      const own = await k.identity({ kind: 'email', value: 'me@us.com', own: true })
      const on = await k.identity({ kind: 'email', value: 'ori@example.com', contact_id: x.id })
      const ids = async (filters: Record<string, string>) => (await k.list(identities, filters)).data.map((v) => v.id)
      expect(await ids({ kind: 'email', value: 'Ori@Example.COM' })).toEqual([on.id])
      expect(await ids({ own: 'true' })).toEqual([own.id])
      expect(await ids({ own: 'false' })).toEqual([on.id])
      expect(await ids({ contact_id: x.id })).toEqual([on.id])
      const noKind = await k.fail((env) => listOperation(identities, env, { filters: { value: 'ori@example.com' } }))
      expect(k.shape(noKind)).toEqual([400, 'validation_error', 'filter value requires kind'])
      const invalid = await k.fail((env) => listOperation(identities, env, { filters: { kind: 'phone', value: 'abc' } }))
      expect([invalid.status, invalid.code]).toEqual([400, 'invalid_identity'])
    })

    it("an agent's writes carry the agent as actor", async () => {
      const c = await k.contact({}, { as: 'agent' })
      const ev = await k.events()
      expect(ev[0]).toMatchObject({ actor_id: e.agentId, resource_id: c.id })
    })

    if (postgres) {
      it("another organisation's contact is invalid_reference", async () => {
        const other = await foreignTenant(e)
        const theirs = await other.run(createOperation(contacts, other.env(), {}))
        const err = await k.fail((env) => createOperation(identities, env, { kind: 'email', value: 'a@b.com', contact_id: theirs.id }))
        expect(err.code).toBe('invalid_reference')
      })
    }
  })
})
