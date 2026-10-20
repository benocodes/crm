import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, seedMembership, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createVaultRegistry } from '../operations.js'
import { withAccountContext } from '../context.js'
import { createApp } from '../rest/app.js'
import { seedApiKey } from '../test/keys.js'
import { clerkUser, mintClerkToken, testClerkAdapter, type ClerkUserJson } from '../test/clerk.js'
import { scopesForRole } from '../auth/roles.js'
import { createOrganization, membershipRecord, organizationRecord } from './organizations.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let profiles: Map<string, ClerkUserJson>
let kit: Awaited<ReturnType<typeof testClerkAdapter>>
let app: ReturnType<typeof createApp>
const declared = createVaultRegistry().declaredScopes()

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
  profiles = new Map()
  kit = await testClerkAdapter({ profiles })
  app = createApp({ db: () => db, authAdapter: kit.adapter })
})

const call = async (path: string, sub: string, init: { method?: string; org?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await mintClerkToken(kit.issuer, { sub })}`,
      ...(init.org ? { 'x-organization-id': init.org } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
const newUser = (sub: string) => profiles.set(sub, clerkUser({ id: sub, email: `${sub}@x.test`, verified: true, first: 'Ada', last: 'L' }))
const userId = async (sub: string) => (await owner.selectFrom('users').select('id').where('auth_subject', '=', sub).executeTakeFirstOrThrow()).id

describe('me.get', () => {
  it('shape', async () => {
    const beta = await seedOrganization(db, { name: 'Beta' })
    const alpha = await seedOrganization(db, { name: 'Alpha' })
    const u = await seedUser(db, { organizationId: beta.id, role: 'owner', authSubject: 'u1', emailVerified: true, email: 'me@x.test' })
    await seedMembership(db, { organizationId: alpha.id, userId: u.id, role: 'member' })
    const res = await call('/me', 'u1', { org: beta.id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toEqual({ id: u.id, email: 'me@x.test', name: null, email_verified: true })
    expect(JSON.stringify(body)).not.toMatch(/auth_(provider|subject)/)
    expect(body.memberships).toEqual([
      { organization_id: alpha.id, organization_name: 'Alpha', role: 'member' },
      { organization_id: beta.id, organization_name: 'Beta', role: 'owner' },
    ])
    expect(body.active_organization).toEqual({ id: beta.id, role: 'owner', scopes: declared })
  })

  it('member scopes', async () => {
    const o = await seedOrganization(db)
    await seedUser(db, { organizationId: o.id, role: 'member', authSubject: 'u2' })
    const body = await (await call('/me', 'u2')).json()
    expect(body.active_organization.scopes).toEqual(scopesForRole('member', declared).toStrings())
  })
})

describe('organizations.create', () => {
  it('creates the organisation with the caller as owner', async () => {
    newUser('u1')
    const res = await call('/organizations', 'u1', { method: 'POST', body: { name: '  Acme  ' } })
    expect(res.status).toBe(201)
    const org = organizationRecord.parse(await res.json())
    expect(org.name).toBe('Acme')
    const uid = await userId('u1')
    const m = await owner.selectFrom('memberships').selectAll().where('organization_id', '=', org.id).execute()
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ role: 'owner', user_id: uid, created_by: uid })
  })

  it('emits organization.created then membership.created', async () => {
    newUser('u1')
    const org = organizationRecord.parse(await (await call('/organizations', 'u1', { method: 'POST', body: { name: 'Acme' } })).json())
    const uid = await userId('u1')
    const events = await owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()
    expect(events.map((e) => e.type)).toEqual(['organization.created', 'membership.created'])
    for (const e of events) {
      expect(e.actor_id).toBe(uid)
      expect(e.organization_id).toBe(org.id)
    }
    expect(events[0]!.after).toEqual(org)
    const m = await owner.selectFrom('memberships').selectAll().where('organization_id', '=', org.id).executeTakeFirstOrThrow()
    expect(events[1]!.resource_id).toBe(m.id)
    expect(membershipRecord.parse(events[1]!.after).id).toBe(m.id)
  })

  it('then usable without a header', async () => {
    newUser('u1')
    await call('/organizations', 'u1', { method: 'POST', body: { name: 'Acme' } })
    expect((await call('/tasks', 'u1')).status).toBe(200)
    const me = await (await call('/me', 'u1')).json()
    expect(me.active_organization.role).toBe('owner')
    expect(me.active_organization.scopes).toEqual(declared)
  })

  it('a second organisation needs the header afterwards', async () => {
    newUser('u1')
    await call('/organizations', 'u1', { method: 'POST', body: { name: 'One' } })
    expect((await call('/organizations', 'u1', { method: 'POST', body: { name: 'Two' } })).status).toBe(201)
    const res = await call('/tasks', 'u1')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_required')
  })

  it.each([
    ['empty', {}],
    ['blank', { name: '   ' }],
    ['extra key', { name: 'x', extra: 1 }],
    ['too long', { name: 'x'.repeat(201) }],
  ])('bad body: %s', async (_n, body) => {
    newUser('u1')
    const res = await call('/organizations', 'u1', { method: 'POST', body })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })

  it('agents are refused', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    const a = await seedAgent(db, { organizationId: o.id, createdBy: u.id, scopes: ['tasks:read'] })
    const k = await seedApiKey(db, { organizationId: o.id, agentId: a.id, createdBy: u.id })
    for (const [path, method] of [['/organizations', 'POST'], ['/me', 'GET']] as const) {
      const res = await app.request(path, { method, headers: { authorization: `Bearer ${k.key}` }, body: method === 'POST' ? JSON.stringify({ name: 'x' }) : undefined })
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('user_required')
    }
  })

  it('is atomic', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    const before = [
      Number((await owner.selectFrom('organizations').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      Number((await owner.selectFrom('memberships').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      Number((await owner.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    ]
    await expect(
      withAccountContext(db, { actor: { id: u.id, kind: 'user' } }, (ctx) =>
        createOrganization(
          { ...ctx, emitFor: (org, e) => (e.type === 'membership.created' ? Promise.reject(new Error('boom')) : ctx.emitFor(org, e)) },
          { name: 'X' },
        ),
      ),
    ).rejects.toThrow('boom')
    const after = [
      Number((await owner.selectFrom('organizations').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      Number((await owner.selectFrom('memberships').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      Number((await owner.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    ]
    expect(after).toEqual(before)
  })

  it('the service function cleans the name itself', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    await expect(
      withAccountContext(db, { actor: { id: u.id, kind: 'user' } }, (ctx) => createOrganization(ctx, { name: '  ' })),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' })
  })
})

describe('documentation', () => {
  it('lists me.get and organizations.create', async () => {
    const doc = await (await app.request('/openapi.json')).json()
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p as Record<string, { operationId?: string }>).map((o) => o.operationId))
    expect(ids).toEqual(expect.arrayContaining(['me.get', 'organizations.create']))
    expect(doc.paths['/me'].get).toBeDefined()
    expect(doc.paths['/organizations'].post).toBeDefined()
  })
})

void withServiceRole
