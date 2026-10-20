import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedMembership, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createVaultRegistry } from '../operations.js'
import { Registry } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { createApp } from '../rest/app.js'
import { parseScope } from '../scopes.js'
import { clerkUser, mintClerkToken, testClerkAdapter, type ClerkUserJson } from '../test/clerk.js'
import { scopesForRole } from './roles.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let profiles: Map<string, ClerkUserJson>
let adapterKit: Awaited<ReturnType<typeof testClerkAdapter>>
let app: ReturnType<typeof createApp>

const declared = createVaultRegistry().declaredScopes()

beforeAll(() => {
  db = createTestDb({ max: 4 })
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
beforeEach(async () => {
  vi.restoreAllMocks()
  await truncateAll(owner)
  profiles = new Map()
  adapterKit = await testClerkAdapter({ profiles })
  app = createApp({ db: () => db, authAdapter: adapterKit.adapter })
})

const token = async (sub: string, opts: Parameters<typeof mintClerkToken>[1] = {}) =>
  mintClerkToken(adapterKit.issuer, { sub, ...opts })
const call = async (path: string, sub: string, init: { method?: string; org?: string; body?: unknown; app?: typeof app } = {}) =>
  (init.app ?? app).request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await token(sub)}`,
      ...(init.org !== undefined ? { 'x-organization-id': init.org } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
const profile = (sub: string, email = `${sub}@x.test`, extra: Partial<Parameters<typeof clerkUser>[0]> = {}) =>
  profiles.set(sub, clerkUser({ id: sub, email, verified: true, ...extra }))
const count = async (table: 'users' | 'principals' | 'events' | 'organizations' | 'memberships') =>
  Number((await owner.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)

async function linkedUser(sub: string, orgs: { id: string; role?: 'owner' | 'member' }[]) {
  const [first, ...rest] = orgs
  const u = await seedUser(db, { organizationId: first!.id, role: first!.role ?? 'owner', authSubject: sub, emailVerified: true })
  for (const o of rest) await seedMembership(db, { organizationId: o.id, userId: u.id, role: o.role ?? 'member' })
  return u
}

describe('first sight', () => {
  it('creates principal and user once', async () => {
    profile('user_new', 'new@x.test', { first: 'Ada', last: 'L' })
    const res = await call('/me', 'user_new')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.memberships).toEqual([])
    expect(body.active_organization).toBeNull()
    expect(await count('principals')).toBe(1)
    expect(await count('users')).toBe(1)
    const u = await owner.selectFrom('users').selectAll().executeTakeFirstOrThrow()
    expect(u).toMatchObject({ auth_provider: 'clerk', auth_subject: 'user_new', email: 'new@x.test', name: 'Ada L', email_verified: true })
    const p = await owner.selectFrom('principals').selectAll().executeTakeFirstOrThrow()
    expect(p.kind).toBe('user')
    expect(p.id).toBe(u.id)
    expect(adapterKit.fetch.calls).toHaveLength(1)
  })

  it('emits no events', async () => {
    profile('user_new')
    await call('/me', 'user_new')
    expect(await count('events')).toBe(0)
  })

  it('steady state: no write, no fetch', async () => {
    const seen: string[] = []
    const watched = db.withPlugin({
      transformQuery(a) {
        const n = a.node as { kind: string; sqlFragments?: string[] }
        seen.push(n.kind === 'RawNode' ? `RawNode ${n.sqlFragments?.join(' ')}` : n.kind)
        return a.node
      },
      async transformResult(a) {
        return a.result
      },
    })
    const watchedApp = createApp({ db: () => watched, authAdapter: adapterKit.adapter })
    const org = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: org.id, role: 'owner', authSubject: 'user_known' })
    profile('user_known') // would be fetched only on first sight
    const before = [await count('users'), await count('principals'), await count('memberships')]
    expect((await call('/me', 'user_known', { app: watchedApp })).status).toBe(200)
    seen.length = 0
    const res = await call('/tasks', 'user_known', { app: watchedApp })
    expect(res.status).toBe(200)
    expect(u.id).toBeTruthy()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((s) => s.startsWith('InsertQueryNode') || s.startsWith('UpdateQueryNode'))).toEqual([])
    expect(seen.filter((s) => /advisory/i.test(s))).toEqual([])
    expect(adapterKit.fetch.calls).toHaveLength(0)
    expect([await count('users'), await count('principals'), await count('memberships')]).toEqual(before)
  })

  it('concurrent first requests create one user', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let pending = 0
    const kit = await testClerkAdapter({
      profiles,
      gate,
      onRequest: () => {
        if (++pending === 2) release()
      },
    })
    const raceApp = createApp({ db: () => db, authAdapter: kit.adapter })
    profile('user_race')
    const t = await mintClerkToken(kit.issuer, { sub: 'user_race' })
    const req = () => raceApp.request('/me', { headers: { authorization: `Bearer ${t}` } })
    const [a, b] = await Promise.all([req(), req()])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await a.json()).user.id).toBe((await b.json()).user.id)
    expect(pending).toBe(2)
    expect(await count('users')).toBe(1)
    expect(await count('principals')).toBe(1)
  })

  it('an email owned by another user (no login) is a conflict', async () => {
    const org = await seedOrganization(db)
    await seedUser(db, { organizationId: org.id, email: 'taken@x.test' })
    profile('user_x', 'TAKEN@x.test')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = [await count('principals'), await count('users')]
    const res = await call('/me', 'user_x')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('account_conflict')
    expect([await count('principals'), await count('users')]).toEqual(before)
    expect(warn.mock.calls.filter((c) => c[0] === '[auth] account_conflict')).toHaveLength(1)
  })

  it('an email owned by another login is a conflict', async () => {
    const org = await seedOrganization(db)
    await seedUser(db, { organizationId: org.id, email: 'a@x.test', authSubject: 'user_a' })
    profile('user_b', 'a@x.test')
    const res = await call('/me', 'user_b')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('account_conflict')
  })

  it('a profile without an email is 401', async () => {
    profiles.set('user_ne', clerkUser({ id: 'user_ne', email: null }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await call('/me', 'user_ne')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'account has no email address' } })
    expect(await count('users')).toBe(0)
    expect(await count('principals')).toBe(0)
  })

  it('a failed profile fetch is 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/me', 'user_unknown')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('internal')
    expect(await count('users')).toBe(0)
    expect(await count('principals')).toBe(0)
  })

  it('a bootstrapped user signs in without a fetch', async () => {
    const org = await seedOrganization(db)
    await seedUser(db, { organizationId: org.id, role: 'owner', authSubject: 'user_boot' })
    const res = await call('/tasks', 'user_boot')
    expect(res.status).toBe(200)
    expect(adapterKit.fetch.calls).toHaveLength(0)
  })

  it('verification failures are 401 and logged with a reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Math.floor(Date.now() / 1000)
    for (const [opts, reason] of [
      [{ exp: now - 100 }, 'expired'],
      [{ azp: 'https://evil.example' }, 'azp'],
    ] as const) {
      warn.mockClear()
      const res = await app.request('/me', { headers: { authorization: `Bearer ${await token('user_1', opts)}` } })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'invalid or expired credentials' } })
      expect(warn).toHaveBeenCalledTimes(1)
      expect((warn.mock.calls[0]![3] as { reason: string }).reason).toBe(reason)
    }
  })
})

describe('organisation resolution', () => {
  it('one membership, no header', async () => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    expect((await call('/tasks', 'u1')).status).toBe(200)
  })

  it('several memberships, no header', async () => {
    const A = await seedOrganization(db)
    const B = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }, { id: B.id }])
    const res = await call('/tasks', 'u1')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_required')
  })

  it('several memberships, header picks one', async () => {
    const A = await seedOrganization(db)
    const B = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }, { id: B.id, role: 'owner' }])
    expect((await call('/tasks', 'u1', { org: B.id, method: 'POST', body: { title: 'in B' } })).status).toBe(201)
    const inB = await (await call('/tasks', 'u1', { org: B.id })).json()
    expect(inB.data.map((t: { title: string }) => t.title)).toEqual(['in B'])
    const inA = await (await call('/tasks', 'u1', { org: A.id })).json()
    expect(inA.data).toEqual([])
  })

  it('a header for a non-member organisation', async () => {
    const A = await seedOrganization(db)
    const C = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/tasks', 'u1', { org: C.id })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_forbidden')
  })

  it.each([['random uuid', '0190a000-0000-7000-8000-0000000000ff'], ['not a uuid', 'nope']])('header %s is forbidden', async (_n, h) => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/tasks', 'u1', { org: h })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_forbidden')
  })

  it('an upper-case header resolves', async () => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    expect((await call('/tasks', 'u1', { org: A.id.toUpperCase() })).status).toBe(200)
  })

  it('an account operation ignores a bad header', async () => {
    const A = await seedOrganization(db)
    const C = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/me', 'u1', { org: C.id })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.active_organization).toBeNull()
    expect(body.memberships.map((m: { organization_id: string }) => m.organization_id)).toEqual([A.id])
  })

  it('a removed membership no longer grants access', async () => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id }])
    expect((await call('/tasks', 'u1')).status).toBe(200)
    await withServiceRole(db, (trx) => trx.updateTable('memberships').set({ deleted_at: new Date() }).where('organization_id', '=', A.id).execute())
    const res = await call('/tasks', 'u1')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_required')
    expect((await (await call('/me', 'u1')).json()).memberships).toEqual([])
  })
})

describe('scopes and attribution', () => {
  it('owner scopes are every declared scope', async () => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id, role: 'owner' }])
    expect((await (await call('/me', 'u1')).json()).active_organization.scopes).toEqual(declared)
  })

  it('member scopes come from the role table', async () => {
    const A = await seedOrganization(db)
    await linkedUser('u1', [{ id: A.id, role: 'member' }])
    expect((await (await call('/me', 'u1')).json()).active_organization.scopes).toEqual(scopesForRole('member', declared).toStrings())
  })

  it('a scope outside the role table is owner-only', async () => {
    const registry = new Registry().registerResource(tasks).register({
      kind: 'tenant',
      name: 'probe.write',
      summary: 'Probe',
      method: 'post',
      path: '/probe',
      scope: parseScope('probe:write'),
      response: { status: 200, schema: z.object({ ok: z.boolean() }) },
      handler: async () => ({ ok: true }),
    })
    const probeApp = createApp({ db: () => db, registry, authAdapter: adapterKit.adapter })
    const A = await seedOrganization(db)
    await linkedUser('owner1', [{ id: A.id, role: 'owner' }])
    await linkedUser('member1', [{ id: A.id, role: 'member' }])
    const m = await call('/probe', 'member1', { method: 'POST', app: probeApp })
    expect(m.status).toBe(403)
    expect((await m.json()).error.code).toBe('insufficient_scope')
    expect((await call('/probe', 'owner1', { method: 'POST', app: probeApp })).status).toBe(200)
  })

  it('user writes are attributed to the user', async () => {
    const A = await seedOrganization(db)
    const u = await linkedUser('u1', [{ id: A.id, role: 'owner' }])
    const res = await call('/tasks', 'u1', { method: 'POST', body: { title: 'x' } })
    expect(res.status).toBe(201)
    const ev = await owner.selectFrom('events').selectAll().where('type', '=', 'task.created').executeTakeFirstOrThrow()
    expect(ev.actor_id).toBe(u.id)
    expect(ev.organization_id).toBe(A.id)
  })
})
