import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pgStorage } from '../test/storage.js'
import { z } from 'zod'
import { sql, type Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedMembership, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createVaultRegistry } from '../operations.js'
import { Registry } from '../registry.js'
import { legacyTasks as tasks } from '../test/legacy-tasks.js'
import { createApp } from '../rest/app.js'
import { parseScope } from '../scopes.js'
import { clerkMembership, clerkOrganization, clerkUser, mintClerkToken, orgClaim, signClerkWebhook, clerkWebhook, testClerkAdapter, type ClerkUserJson } from '../test/clerk.js'
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
  app = createApp({ db: () => db, authAdapter: adapterKit.adapter, storage: pgStorage(db) })
})

type Claim = { id: string; rol?: string }
type CallInit = { method?: string; claim?: Claim; header?: string; body?: unknown; app?: typeof app; age?: number }
const token = async (sub: string, opts: Parameters<typeof mintClerkToken>[1] = {}) =>
  mintClerkToken(adapterKit.issuer, { sub, ...opts })
/** `age`: seconds since the token was minted (exp stays in the future). */
const call = async (path: string, sub: string, init: CallInit = {}) => {
  const now = Math.floor(Date.now() / 1000)
  const opts: Parameters<typeof mintClerkToken>[1] = {
    ...(init.claim ? { extra: orgClaim(init.claim.id, init.claim.rol ?? 'admin') } : {}),
    ...(init.age ? { now: new Date((now - init.age) * 1000), exp: now + 60 } : {}),
  }
  return (init.app ?? app).request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await token(sub, opts)}`,
      ...(init.header !== undefined ? { 'x-organization-id': init.header } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}
let extSeq = 0
/** An organisation linked to a Clerk organisation id, which the fake Clerk also knows. */
async function linkedOrg(members: [string, string][] = []) {
  const ext = `org_t${++extSeq}`
  const org = await seedOrganization(db, { authOrgId: ext, name: `Org ${ext}` })
  adapterKit.organizations.set(ext, clerkOrganization({ id: ext, name: `Org ${ext}` }))
  adapterKit.members.set(ext, members.map(([userId, role]) => clerkMembership({ organizationId: ext, userId, role })))
  return { id: org.id, ext }
}
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
const eventTypes = async () => (await owner.selectFrom('events').select('type').orderBy(sql`ctid`).execute()).map((e) => e.type)
const systemId = async () => (await owner.selectFrom('principals').select('id').where('kind', '=', 'system').executeTakeFirstOrThrow()).id

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
    const watchedApp = createApp({ db: () => watched, authAdapter: adapterKit.adapter, storage: pgStorage(watched) })
    const org = await linkedOrg()
    const claim = { id: org.ext, rol: 'admin' }
    const u = await seedUser(db, { organizationId: org.id, role: 'owner', authSubject: 'user_known' })
    profile('user_known') // would be fetched only on first sight
    const before = [await count('users'), await count('principals'), await count('memberships')]
    expect((await call('/me', 'user_known', { app: watchedApp, claim })).status).toBe(200)
    seen.length = 0
    const res = await call('/tasks', 'user_known', { app: watchedApp, claim })
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
    const raceApp = createApp({ db: () => db, authAdapter: kit.adapter, storage: pgStorage(db) })
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
    const org = await linkedOrg()
    await seedUser(db, { organizationId: org.id, role: 'owner', authSubject: 'user_boot' })
    const res = await call('/tasks', 'user_boot', { claim: { id: org.ext } })
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

describe('organisation claim', () => {
  it('no claim: an organisation is required, /me still works', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/tasks', 'u1')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_required')
    const me = await call('/me', 'u1')
    expect(me.status).toBe(200)
    expect((await me.json()).active_organization).toBeNull()
  })

  it('the claim repairs the copy', async () => {
    const org = await linkedOrg()
    profile('u1')
    const res = await call('/tasks', 'u1', { claim: { id: org.ext } })
    expect(res.status).toBe(200)
    const u = await owner.selectFrom('users').select('id').where('auth_subject', '=', 'u1').executeTakeFirstOrThrow()
    const m = await owner.selectFrom('memberships').selectAll().where('organization_id', '=', org.id).execute()
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ user_id: u.id, role: 'owner', created_by: await systemId() })
    expect(await eventTypes()).toEqual(['membership.created'])
    expect((await owner.selectFrom('events').selectAll().executeTakeFirstOrThrow()).actor_id).toBe(await systemId())
  })

  it('an unlinked organisation is fetched and created', async () => {
    adapterKit.organizations.set('org_new', clerkOrganization({ id: 'org_new', name: 'Fresh' }))
    profile('u1')
    expect((await call('/tasks', 'u1', { claim: { id: 'org_new' } })).status).toBe(200)
    expect((await owner.selectFrom('organizations').select('name').where('auth_org_id', '=', 'org_new').executeTakeFirstOrThrow()).name).toBe('Fresh')
    expect(await eventTypes()).toEqual(['organization.created', 'membership.created'])
  })

  it('steady state: no write, no Clerk call', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    const before = [await count('events'), await count('memberships')]
    expect((await call('/tasks', 'u1', { claim: { id: A.ext } })).status).toBe(200)
    expect([await count('events'), await count('memberships')]).toEqual(before)
    expect(adapterKit.fetch.calls).toHaveLength(0)
  })

  it("the claim's role wins", async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id, role: 'owner' }])
    const res = await call('/agents', 'u1', { method: 'POST', claim: { id: A.ext, rol: 'member' }, body: { name: 'bot', scopes: [] } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('insufficient_scope')
    const m = await owner.selectFrom('memberships').select('role').where('organization_id', '=', A.id).executeTakeFirstOrThrow()
    expect(m.role).toBe('member')
    expect(await eventTypes()).toEqual(['membership.updated'])
  })

  it('an unmapped role is forbidden', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await call('/tasks', 'u1', { claim: { id: A.ext, rol: 'billing' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_forbidden')
    expect(warn).toHaveBeenCalledWith('[auth] unmapped organisation role')
  })

  it('an organisation Clerk no longer has is forbidden', async () => {
    profile('u1')
    const res = await call('/tasks', 'u1', { claim: { id: 'org_gone' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_forbidden')
    expect(await count('organizations')).toBe(0)
  })

  it('a matching header', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    expect((await call('/tasks', 'u1', { claim: { id: A.ext }, header: A.id.toUpperCase() })).status).toBe(200)
  })

  it('another header', async () => {
    const A = await linkedOrg()
    const B = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/tasks', 'u1', { claim: { id: A.ext }, header: B.id })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('organization_forbidden')
  })

  it('an account operation ignores a bad header', async () => {
    const A = await linkedOrg()
    const B = await linkedOrg()
    await linkedUser('u1', [{ id: A.id }])
    const res = await call('/me', 'u1', { claim: { id: A.ext }, header: B.id })
    expect(res.status).toBe(200)
    expect((await res.json()).active_organization).toBeNull()
  })

  describe('a token older than the copy', () => {
    const removeViaWebhook = async (A: { id: string; ext: string }) => {
      // Clerk dropped the member; the delivery reconciles the copy.
      adapterKit.members.set(A.ext, [])
      const signed = signClerkWebhook(clerkWebhook('organizationMembership.deleted', { organization: { id: A.ext } }))
      const res = await app.request('/webhooks/clerk', { method: 'POST', headers: signed.headers, body: signed.body })
      expect(res.status).toBe(200)
    }

    it('after a removal the member stays out', async () => {
      const A = await linkedOrg([['u1', 'org:admin']])
      await linkedUser('u1', [{ id: A.id }])
      await removeViaWebhook(A)
      const before = await eventTypes()
      const res = await call('/tasks', 'u1', { claim: { id: A.ext }, age: 60 })
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('organization_forbidden')
      expect((await owner.selectFrom('memberships').select('deleted_at').executeTakeFirstOrThrow()).deleted_at).not.toBeNull()
      expect(await eventTypes()).toEqual(before)
    })

    it('after a role change the copy wins', async () => {
      const A = await linkedOrg([['u1', 'org:member']])
      await linkedUser('u1', [{ id: A.id, role: 'owner' }])
      adapterKit.members.set(A.ext, [clerkMembership({ organizationId: A.ext, userId: 'u1', role: 'org:member' })])
      const signed = signClerkWebhook(clerkWebhook('organizationMembership.updated', { organization: { id: A.ext } }))
      await app.request('/webhooks/clerk', { method: 'POST', headers: signed.headers, body: signed.body })
      const before = await eventTypes()
      const res = await call('/agents', 'u1', { method: 'POST', claim: { id: A.ext, rol: 'admin' }, age: 60, body: { name: 'bot', scopes: [] } })
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('insufficient_scope')
      expect(await eventTypes()).toEqual(before)
    })

    it('a fresh token after a re-add restores access', async () => {
      const A = await linkedOrg([['u1', 'org:admin']])
      await linkedUser('u1', [{ id: A.id }])
      await removeViaWebhook(A)
      const res = await call('/tasks', 'u1', { claim: { id: A.ext } })
      expect(res.status).toBe(200)
      const live = await owner.selectFrom('memberships').select('id').where('deleted_at', 'is', null).execute()
      expect(live).toHaveLength(1)
      expect((await eventTypes()).at(-1)).toBe('membership.created')
    })

    it('a token without the organisation stays out', async () => {
      const A = await linkedOrg([['u1', 'org:admin']])
      await linkedUser('u1', [{ id: A.id }])
      await removeViaWebhook(A)
      const res = await call('/tasks', 'u1')
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('organization_required')
    })
  })
})

describe('scopes and attribution', () => {
  it('owner scopes are every declared scope', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id, role: 'owner' }])
    expect((await (await call('/me', 'u1', { claim: { id: A.ext } })).json()).active_organization.scopes).toEqual(declared)
  })

  it('member scopes come from the role table', async () => {
    const A = await linkedOrg()
    await linkedUser('u1', [{ id: A.id, role: 'member' }])
    expect((await (await call('/me', 'u1', { claim: { id: A.ext, rol: 'member' } })).json()).active_organization.scopes).toEqual(scopesForRole('member', declared).toStrings())
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
    const probeApp = createApp({ db: () => db, registry, authAdapter: adapterKit.adapter, storage: pgStorage(db) })
    const A = await linkedOrg()
    await linkedUser('owner1', [{ id: A.id, role: 'owner' }])
    await linkedUser('member1', [{ id: A.id, role: 'member' }])
    const m = await call('/probe', 'member1', { method: 'POST', app: probeApp, claim: { id: A.ext, rol: 'member' } })
    expect(m.status).toBe(403)
    expect((await m.json()).error.code).toBe('insufficient_scope')
    expect((await call('/probe', 'owner1', { method: 'POST', app: probeApp, claim: { id: A.ext } })).status).toBe(200)
  })

  it('user writes are attributed to the user', async () => {
    const A = await linkedOrg()
    const u = await linkedUser('u1', [{ id: A.id, role: 'owner' }])
    const res = await call('/tasks', 'u1', { method: 'POST', claim: { id: A.ext }, body: { title: 'x' } })
    expect(res.status).toBe(201)
    const ev = await owner.selectFrom('events').selectAll().where('type', '=', 'task.created').executeTakeFirstOrThrow()
    expect(ev.actor_id).toBe(u.id)
    expect(ev.organization_id).toBe(A.id)
  })
})
