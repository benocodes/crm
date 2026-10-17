import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, truncateAll } from '@vault/db/test'
import { createApp } from '../rest/app.js'
import { seedApiKey } from '../test/keys.js'
import { seedTenant, asUser, type Tenant } from '../test/tenant.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { createResource } from '../resources/crud.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let a: Tenant
let writeKey: string
let readKey: string

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
const app = () => createApp({ db: () => db, userAuthenticator: fakeUserAuthenticator() })

beforeEach(async () => {
  await truncateAll(owner)
  a = await seedTenant(db, 'A')
  const w = await seedAgent(db, { organizationId: a.organizationId, createdBy: a.userId, scopes: ['contacts:write', 'contacts:read'] })
  const r = await seedAgent(db, { organizationId: a.organizationId, createdBy: a.userId, scopes: ['contacts:read'] })
  writeKey = (await seedApiKey(db, { organizationId: a.organizationId, agentId: w.id, createdBy: a.userId })).key
  readKey = (await seedApiKey(db, { organizationId: a.organizationId, agentId: r.id, createdBy: a.userId })).key
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-organization-id': a.organizationId })
const userToken = (scopes: string[]) => mintTestUserToken({ userId: a.userId, organizationId: a.organizationId, scopes })
const post = (path: string, token: string, body: unknown) => app().request(path, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) })
const err = async (res: Response) => ((await res.json()) as any).error

describe('identities.resolve over REST', () => {
  it('resolves', async () => {
    const res = await post('/identities/resolve', writeKey, { identities: [{ kind: 'email', value: 'A@B.com', name: 'A' }] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ created: true, identity: { value: 'a@b.com' }, contact: { name: 'A' } })
  })
  it('needs write', async () => {
    const res = await post('/identities/resolve', readKey, { identities: [{ kind: 'email', value: 'a@b.com' }] })
    expect(res.status).toBe(403)
    expect(await err(res)).toEqual({ code: 'insufficient_scope', message: 'requires contacts:write' })
  })
  it('bounds', async () => {
    const one = { kind: 'email', value: 'a@b.com' }
    for (const body of [
      { identities: [] },
      { identities: Array.from({ length: 101 }, (_, i) => ({ kind: 'email', value: `a${i}@b.com` })) },
      { identities: [{ ...one, extra: 1 }] },
    ]) {
      const res = await post('/identities/resolve', writeKey, body)
      expect(res.status).toBe(400)
      expect((await err(res)).code).toBe('validation_error')
    }
  })
  it('invalid', async () => {
    const res = await post('/identities/resolve', writeKey, { identities: [{ kind: 'phone', value: 'x' }] })
    expect(res.status).toBe(400)
    const e = await err(res)
    expect(e.code).toBe('invalid_identity')
    expect(e.message.startsWith('identities[0]: ')).toBe(true)
  })
})

describe('contacts.merge over REST', () => {
  const two = async () => ({
    s: await asUser(db, a, (ctx) => createResource(ctx, contacts, {})),
    r: await asUser(db, a, (ctx) => createResource(ctx, contacts, {})),
  })
  it('merges', async () => {
    const { s, r } = await two()
    const res = await post(`/contacts/${s.id}/merge`, userToken(['contacts:write']), { source_id: r.id })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).id).toBe(s.id)
    const ev = await owner.selectFrom('events').selectAll().where('type', '=', 'contact.merged').execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]!.actor_id).toBe(a.userId)
  })
  it('needs write', async () => {
    const { s, r } = await two()
    const res = await post(`/contacts/${s.id}/merge`, userToken(['contacts:read']), { source_id: r.id })
    expect(res.status).toBe(403)
    expect((await err(res)).code).toBe('insufficient_scope')
  })
  it('validation', async () => {
    const { s, r } = await two()
    for (const body of [{ source_id: 'nope' }, { source_id: r.id, extra: 1 }]) {
      const res = await post(`/contacts/${s.id}/merge`, userToken(['contacts:write']), body)
      expect(res.status).toBe(400)
      expect((await err(res)).code).toBe('validation_error')
    }
  })
  it('self', async () => {
    const { s } = await two()
    const res = await post(`/contacts/${s.id}/merge`, userToken(['contacts:write']), { source_id: s.id })
    expect(res.status).toBe(400)
    expect((await err(res)).code).toBe('merge_into_self')
  })
})

describe('document and lookup', () => {
  it('openapi', async () => {
    const doc = (await (await app().request('/openapi.json')).json()) as any
    expect(doc.paths['/identities/resolve'].post.operationId).toBe('identities.resolve')
    expect(doc.paths['/contacts/{id}/merge'].post.operationId).toBe('contacts.merge')
  })
  it('sender lookup', async () => {
    const k = await asUser(db, a, (ctx) => createResource(ctx, contacts, {}))
    await asUser(db, a, (ctx) => createResource(ctx, identities, { kind: 'email', value: 'ori@example.com', contact_id: k.id }))
    const res = await app().request('/identities?kind=email&value=Ori%40Example.com', { headers: bearer(readKey) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data[0].value).toBe('ori@example.com')
  })
})
