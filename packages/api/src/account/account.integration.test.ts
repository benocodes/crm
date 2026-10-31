import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pgStorage } from '../test/storage.js'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, seedMembership, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { seedApiKey } from '../test/keys.js'
import { mintClerkToken, orgClaim, testClerkAdapter, type ClerkUserJson } from '../test/clerk.js'
import { scopesForRole } from '../auth/roles.js'

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
  app = createApp({ authAdapter: kit.adapter, storage: pgStorage(db) })
})

/** `claim`: the Clerk organisation id (and role) the token names. */
const call = async (path: string, sub: string, init: { method?: string; claim?: { id: string; rol?: string }; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await mintClerkToken(kit.issuer, { sub, ...(init.claim ? { extra: orgClaim(init.claim.id, init.claim.rol ?? 'admin') } : {}) })}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

describe('me.get', () => {
  it('shape', async () => {
    const beta = await seedOrganization(db, { name: 'Beta', authOrgId: 'org_beta' })
    const alpha = await seedOrganization(db, { name: 'Alpha', authOrgId: 'org_alpha' })
    const u = await seedUser(db, { organizationId: beta.id, role: 'owner', authSubject: 'u1', emailVerified: true, email: 'me@x.test' })
    await seedMembership(db, { organizationId: alpha.id, userId: u.id, role: 'member' })
    const res = await call('/meta/v1/me', 'u1', { claim: { id: 'org_beta' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toEqual({ id: u.id, email: 'me@x.test', name: null, email_verified: true })
    expect(JSON.stringify(body)).not.toMatch(/auth_(provider|subject)/)
    expect('invitations' in body).toBe(false)
    expect(body.memberships).toEqual([
      { organization_id: alpha.id, organization_name: 'Alpha', role: 'member' },
      { organization_id: beta.id, organization_name: 'Beta', role: 'owner' },
    ])
    expect(body.active_organization).toEqual({ id: beta.id, role: 'owner', scopes: declared })
  })

  it('member scopes', async () => {
    const o = await seedOrganization(db, { authOrgId: 'org_m' })
    await seedUser(db, { organizationId: o.id, role: 'member', authSubject: 'u2' })
    const body = await (await call('/meta/v1/me', 'u2', { claim: { id: 'org_m', rol: 'member' } })).json()
    expect(body.active_organization.scopes).toEqual(scopesForRole('member', declared).toStrings())
  })
})

describe('documentation', () => {
  it('lists me.get only', async () => {
    const doc = await (await app.request('/meta/v1/openapi.json')).json()
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p as Record<string, { operationId?: string }>).map((o) => o.operationId))
    expect(ids).toContain('me.get')
    expect(ids).not.toContain('organizations.create')
    expect(ids).not.toContain('invitations.accept')
    expect(doc.paths['/meta/v1/me'].get).toBeDefined()
    expect(doc.paths['/organizations']).toBeUndefined()
  })

  it('agents are refused', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    const a = await seedAgent(db, { organizationId: o.id, createdBy: u.id, scopes: ['tasks:read'] })
    const k = await seedApiKey(db, { organizationId: o.id, agentId: a.id, createdBy: u.id })
    const res = await app.request('/meta/v1/me', { headers: { authorization: `Bearer ${k.key}` } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('user_required')
  })
})

