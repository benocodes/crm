import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../registry.js'
import { companies } from '../resources/companies.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { d1Backend } from '../test/d1-backend.js'
import { postgresBackend, type ContractBackend, type ContractSession, type ContractTenant } from '../test/contract.js'
import { identityOperations } from './operations.js'

const registry = (): Registry => {
  const r = new Registry().registerResource(companies).registerResource(contacts).registerResource(identities)
  for (const op of identityOperations()) r.register(op)
  return r
}

describe.each([postgresBackend(), d1Backend()] as ContractBackend[])('identity commands over REST on $name', (backend) => {
  let session: ContractSession
  let a: ContractTenant
  beforeAll(async () => {
    session = await backend.open(registry())
  })
  afterAll(() => session.close())
  beforeEach(async () => {
    ;({ a } = await session.reset())
  })

  const WRITE = ['contacts:write', 'contacts:read']
  const READ = ['contacts:read']
  const post = (path: string, scopes: string[], body: unknown, actor: 'user' | 'agent' = 'agent') => session.call(a, actor, scopes, 'POST', path, body)
  const err = async (res: Response) => ((await res.json()) as any).error
  const contact = async (): Promise<{ id: string }> => (await (await post('/api/v1/contacts', WRITE, {}, 'user')).json()) as { id: string }

  describe('identities.resolve', () => {
    it('resolves', async () => {
      const res = await post('/api/v1/identities/resolve', WRITE, { identities: [{ kind: 'email', value: 'A@B.com', name: 'A' }] })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toHaveLength(1)
      expect(body.data[0]).toMatchObject({ created: true, identity: { value: 'a@b.com' }, contact: { name: 'A' } })
      const events = await session.eventsOf(body.data[0].identity.id)
      expect(events.map((x) => x.type)).toEqual(['identity.created'])
      expect(events[0]!.actor_id).toBe(await session.principalId(a, 'agent', WRITE))
    })
    it('needs write', async () => {
      const res = await post('/api/v1/identities/resolve', READ, { identities: [{ kind: 'email', value: 'a@b.com' }] })
      expect(res.status).toBe(403)
      expect(await err(res)).toEqual({ code: 'insufficient_scope', message: 'requires contacts:write' })
    })
    it('bounds the batch to 1..100 and refuses extra keys', async () => {
      const one = { kind: 'email', value: 'a@b.com' }
      for (const body of [
        { identities: [] },
        { identities: Array.from({ length: 101 }, (_, i) => ({ kind: 'email', value: `a${i}@b.com` })) },
        { identities: [{ ...one, extra: 1 }] },
      ]) {
        const res = await post('/api/v1/identities/resolve', WRITE, body)
        expect(res.status).toBe(400)
        expect((await err(res)).code).toBe('validation_error')
      }
    })
    it('answers an invalid entry with its index', async () => {
      const res = await post('/api/v1/identities/resolve', WRITE, { identities: [{ kind: 'phone', value: 'x' }] })
      expect(res.status).toBe(400)
      const e = await err(res)
      expect(e.code).toBe('invalid_identity')
      expect(e.message.startsWith('identities[0]: ')).toBe(true)
    })
  })

  describe('contacts.merge', () => {
    const two = async () => ({ s: await contact(), r: await contact() })
    it('merges and attributes contact.merged to the caller', async () => {
      const { s, r } = await two()
      const res = await post(`/api/v1/contacts/${s.id}/merge`, WRITE, { source_id: r.id }, 'user')
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).id).toBe(s.id)
      const merged = (await session.eventsOf(r.id)).filter((x) => x.type === 'contact.merged')
      expect(merged).toHaveLength(1)
      expect(merged[0]!.actor_id).toBe(a.userId)
    })
    it('needs write', async () => {
      const { s, r } = await two()
      const res = await post(`/api/v1/contacts/${s.id}/merge`, READ, { source_id: r.id }, 'user')
      expect(res.status).toBe(403)
      expect((await err(res)).code).toBe('insufficient_scope')
    })
    it('validates the body', async () => {
      const { s, r } = await two()
      for (const body of [{ source_id: 'nope' }, { source_id: r.id, extra: 1 }]) {
        const res = await post(`/api/v1/contacts/${s.id}/merge`, WRITE, body, 'user')
        expect(res.status).toBe(400)
        expect((await err(res)).code).toBe('validation_error')
      }
    })
    it('refuses a self-merge, also with an upper-cased id, and writes no event', async () => {
      const { s } = await two()
      const before = await session.countEvents()
      for (const source_id of [s.id, s.id.toUpperCase()]) {
        const res = await post(`/api/v1/contacts/${s.id}/merge`, WRITE, { source_id }, 'user')
        expect(res.status).toBe(400)
        expect((await err(res)).code).toBe('merge_into_self')
      }
      expect(await session.countEvents()).toBe(before)
    })
  })

  describe('document and lookup', () => {
    it('documents both commands under their operation ids', async () => {
      const doc = (await (await session.app.request('/api/v1/openapi.json')).json()) as any
      expect(doc.paths['/api/v1/identities/resolve'].post.operationId).toBe('identities.resolve')
      expect(doc.paths['/api/v1/contacts/{id}/merge'].post.operationId).toBe('contacts.merge')
    })
    it('looks a sender up by address, normalised', async () => {
      const k = await contact()
      expect((await post('/api/v1/identities', WRITE, { kind: 'email', value: 'ori@example.com', contact_id: k.id }, 'user')).status).toBe(201)
      const res = await session.call(a, 'agent', READ, 'GET', '/api/v1/identities?kind=email&value=Ori%40Example.com')
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).data[0].value).toBe('ori@example.com')
    })
  })
})
