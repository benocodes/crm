import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { withContext } from '../context.js'
import { ScopeSet } from '../scopes.js'
import { asAgent, asUser, seedTenant, type Tenant } from '../test/tenant.js'
import { createResource } from '../resources/crud.js'
import { contacts } from '../resources/contacts.js'
import { identities } from '../resources/identities.js'
import { ensureOwnIdentity, resolveIdentities } from './resolve.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let a: Tenant
let b: Tenant

beforeAll(() => {
  db = createTestDb({ max: 4 })
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
const count = async (table: 'contacts' | 'identities') =>
  Number((await owner.selectFrom(table).select((e) => e.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)
const email = (value: string, name?: string) => ({ kind: 'email' as const, value, ...(name ? { name } : {}) })
const resolve = (t: Tenant, entries: Parameters<typeof resolveIdentities>[1]) => asUser(db, t, (ctx) => resolveIdentities(ctx, entries))
async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => undefined, (e) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const userCtx = (t: Tenant) => ({ actor: { id: t.userId, kind: 'user' as const }, organizationId: t.organizationId, scopes: ScopeSet.parse(['contacts:write']) })

describe('resolveIdentities', () => {
  it('new address', async () => {
    const [r] = await resolve(a, [email('New@X.com', 'New Person')])
    expect(r).toMatchObject({ created: true, identity: { value: 'new@x.com' }, contact: { name: 'New Person' } })
    const ev = await events()
    expect(ev.map((e) => e.type)).toEqual(['contact.created', 'identity.created'])
    for (const e of ev) expect(e.actor_id).toBe(a.userId)
  })
  it('no name', async () => {
    const [r] = await resolve(a, [email('n@x.com')])
    expect(r!.contact!.name).toBeNull()
  })
  it('existing is never renamed', async () => {
    const k = await asUser(db, a, (ctx) => createResource(ctx, contacts, { name: 'Ori' }))
    await asUser(db, a, (ctx) => createResource(ctx, identities, { kind: 'email', value: 'o@x.com', contact_id: k.id }))
    const mark = (await events()).length
    const [r] = await resolve(a, [email('O@x.com', 'Someone Else')])
    expect(r).toMatchObject({ created: false, contact: { id: k.id, name: 'Ori' } })
    expect(await events()).toHaveLength(mark)
  })
  it('own', async () => {
    await asUser(db, a, (ctx) => createResource(ctx, identities, { kind: 'email', value: 'me@us.com', own: true }))
    const [r] = await resolve(a, [email('me@us.com')])
    expect(r).toMatchObject({ contact: null, created: false })
    expect(r!.identity.own).toBe(true)
  })
  it('mixed batch keeps order', async () => {
    const k = await asUser(db, a, (ctx) => createResource(ctx, contacts, {}))
    await asUser(db, a, (ctx) => createResource(ctx, identities, { kind: 'email', value: 'a@x.com', contact_id: k.id }))
    await asUser(db, a, (ctx) => createResource(ctx, identities, { kind: 'email', value: 'b@x.com', own: true }))
    const r = await resolve(a, [email('c@x.com'), email('a@x.com'), email('b@x.com')])
    expect(r.map((x) => [x.identity.value, x.created])).toEqual([['c@x.com', true], ['a@x.com', false], ['b@x.com', false]])
  })
  it('repeated in batch', async () => {
    const r = await resolve(a, [email('x@y.com'), email('X@Y.com')])
    expect(r[0]!.identity.id).toBe(r[1]!.identity.id)
    expect(r.map((x) => x.created)).toEqual([true, false])
    expect(await count('contacts')).toBe(1)
    expect(await count('identities')).toBe(1)
  })
  it('invalid entry fails the whole call', async () => {
    const e = await apiError(resolve(a, [email('ok@x.com'), { kind: 'phone', value: 'abc' }]))
    expect([e.status, e.code]).toEqual([400, 'invalid_identity'])
    expect(e.message.startsWith('identities[1]: ')).toBe(true)
    expect(await count('contacts')).toBe(0)
    expect(await events()).toHaveLength(0)
  })
  it('empty', async () => {
    expect(await resolve(a, [])).toEqual([])
  })
  it('per organisation', async () => {
    const [ra] = await resolve(a, [email('x@y.com')])
    const [rb] = await resolve(b, [email('x@y.com')])
    expect(rb!.created).toBe(true)
    expect(rb!.identity.id).not.toBe(ra!.identity.id)
    expect(rb!.contact!.id).not.toBe(ra!.contact!.id)
  })
  it('as agent', async () => {
    await asAgent(db, a, (ctx) => resolveIdentities(ctx, [email('ag@x.com')]))
    for (const e of await events()) expect(e.actor_id).toBe(a.agentId)
  })

  it('concurrent resolve makes one contact', async () => {
    const g = gate()
    const t1 = withContext(db, userCtx(a), async (ctx) => {
      const r = await resolveIdentities(ctx, [email('race@x.com')])
      await g.promise
      return r
    })
    await sleep(100)
    const t2 = withContext(db, userCtx(a), (ctx) => resolveIdentities(ctx, [email('race@x.com')]))
    await sleep(200)
    g.open()
    const [r1, r2] = await Promise.all([t1, t2])
    expect(r1[0]!.created).toBe(true)
    expect(r2[0]!.created).toBe(false)
    expect(r2[0]!.identity.id).toBe(r1[0]!.identity.id)
    expect(await count('contacts')).toBe(1)
    expect((await events()).filter((e) => e.type === 'contact.created')).toHaveLength(1)
  })

  it('concurrent create vs resolve', async () => {
    const g = gate()
    const t1 = withContext(db, userCtx(a), async (ctx) => {
      const k = await createResource(ctx, contacts, {})
      const i = await createResource(ctx, identities, { kind: 'email', value: 'race2@x.com', contact_id: k.id })
      await g.promise
      return i
    })
    await sleep(100)
    const t2 = withContext(db, userCtx(a), (ctx) => resolveIdentities(ctx, [email('race2@x.com')]))
    await sleep(200)
    g.open()
    const [i1, r2] = await Promise.all([t1, t2])
    expect(r2[0]).toMatchObject({ created: false, identity: { id: i1.id } })
    expect(await count('contacts')).toBe(1)
  })

  it('reversed batches do not deadlock', async () => {
    const addrs = Array.from({ length: 10 }, (_, i) => email(`a${i + 1}@x.com`))
    for (let round = 0; round < 10; round++) {
      await truncateAll(owner)
      a = await seedTenant(db, 'A')
      await Promise.all([resolve(a, addrs), resolve(a, [...addrs].reverse())])
    }
  })
})

describe('ensureOwnIdentity', () => {
  const ensure = (t: Tenant, address: Parameters<typeof ensureOwnIdentity>[1]) => asUser(db, t, (ctx) => ensureOwnIdentity(ctx, address))
  it('creates own', async () => {
    const r = await ensure(a, { kind: 'email', value: 'Me@Us.com' })
    expect(r.outcome).toBe('created')
    expect(r.identity).toMatchObject({ own: true, value: 'me@us.com' })
    expect((await events()).map((e) => e.type)).toEqual(['identity.created'])
  })
  it('moves from contact', async () => {
    const [r0] = await resolve(a, [email('me@us.com')])
    const mark = (await events()).length
    const r = await ensure(a, { kind: 'email', value: 'me@us.com' })
    expect(r.outcome).toBe('moved')
    expect(r.identity).toMatchObject({ contact_id: null, own: true })
    const ev = (await events()).slice(mark)
    expect(ev.map((e) => e.type)).toEqual(['identity.updated'])
    expect((ev[0]!.before as any).contact_id).toBe(r0!.contact!.id)
    expect((await owner.selectFrom('contacts').select('deleted_at').where('id', '=', r0!.contact!.id).executeTakeFirstOrThrow()).deleted_at).toBeNull()
  })
  it('unchanged', async () => {
    await ensure(a, { kind: 'email', value: 'me@us.com' })
    const mark = (await events()).length
    expect((await ensure(a, { kind: 'email', value: 'me@us.com' })).outcome).toBe('unchanged')
    expect(await events()).toHaveLength(mark)
  })
  it('invalid', async () => {
    expect((await apiError(ensure(a, { kind: 'email', value: 'nope' }))).code).toBe('invalid_identity')
  })
  it('then resolve sees own', async () => {
    await ensure(a, { kind: 'email', value: 'me@us.com' })
    expect((await resolve(a, [email('me@us.com')]))[0]!.contact).toBeNull()
  })
})
