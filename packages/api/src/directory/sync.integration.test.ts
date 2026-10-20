import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { ApiError } from '../errors.js'
import { clerkMembership, clerkOrganization, clerkUser, testClerkAdapter } from '../test/clerk.js'
import { reconcileOrganization, refreshUser, repairMembership } from './sync.js'

let db: Kysely<Database>
let owner: Kysely<Database>
let kit: Awaited<ReturnType<typeof testClerkAdapter>>

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
  kit = await testClerkAdapter()
})

const events = () => owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()
const types = async () => (await events()).map((e) => e.type)
const systemId = async () => (await owner.selectFrom('principals').select('id').where('kind', '=', 'system').executeTakeFirstOrThrow()).id
const profile = (sub: string, email = `${sub}@x.test`) => kit.profiles.set(sub, clerkUser({ id: sub, email, verified: true, first: 'Ada', last: 'L' }))
const clerkOrg = (id: string, name: string, members: [string, string][]) => {
  kit.organizations.set(id, clerkOrganization({ id, name }))
  kit.members.set(id, members.map(([userId, role]) => clerkMembership({ organizationId: id, userId, role })))
}
/** A user known to the vault (first sight done), in an unrelated organisation so it has a row. */
async function knownUser(sub: string, email = `${sub}@x.test`) {
  const other = await seedOrganization(db)
  return seedUser(db, { organizationId: other.id, role: 'member', authSubject: sub, email, emailVerified: true })
}
const linked = (ext: string) => owner.selectFrom('organizations').selectAll().where('auth_org_id', '=', ext).executeTakeFirst()
const live = (organizationId: string) =>
  owner.selectFrom('memberships').selectAll().where('organization_id', '=', organizationId).where('deleted_at', 'is', null).execute()
const count = async (table: 'events' | 'organizations' | 'memberships') =>
  Number((await owner.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)

describe('repairMembership', () => {
  it('a new organisation, from the fetch', async () => {
    const u = await knownUser('user_a')
    clerkOrg('org_a', 'Acme', [])
    const id = await repairMembership(db, kit.adapter, { userId: u.id, externalId: 'org_a', role: 'owner', known: { organizationId: null } })
    const org = await linked('org_a')
    expect(org).toMatchObject({ id, name: 'Acme', auth_provider: 'clerk' })
    const m = await live(id)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ user_id: u.id, role: 'owner', created_by: await systemId() })
    const ev = (await events()).filter((e) => e.organization_id === id)
    expect(ev.map((e) => e.type)).toEqual(['organization.created', 'membership.created'])
    for (const e of ev) expect(e.actor_id).toBe(await systemId())
  })

  it('a known organisation, a new member: no fetch', async () => {
    const o = await seedOrganization(db, { authOrgId: 'org_a' })
    const u = await knownUser('user_a')
    await repairMembership(db, kit.adapter, { userId: u.id, externalId: 'org_a', role: 'member', known: { organizationId: o.id } })
    expect(await types()).toEqual(['membership.created'])
    expect(kit.fetch.calls).toHaveLength(0)
  })

  it('a role change', async () => {
    const o = await seedOrganization(db, { authOrgId: 'org_a' })
    const u = await seedUser(db, { organizationId: o.id, role: 'member', authSubject: 'user_a' })
    await repairMembership(db, kit.adapter, { userId: u.id, externalId: 'org_a', role: 'owner', known: { organizationId: o.id } })
    const [ev] = await events()
    expect(ev).toMatchObject({ type: 'membership.updated', actor_id: await systemId() })
    expect((ev!.before as { role: string }).role).toBe('member')
    expect((ev!.after as { role: string }).role).toBe('owner')
  })

  it('an organisation Clerk no longer has', async () => {
    const u = await knownUser('user_a')
    const before = await count('organizations')
    const err = await repairMembership(db, kit.adapter, { userId: u.id, externalId: 'org_a', role: 'owner', known: { organizationId: null } }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: 'organization_forbidden' })
    expect(await count('organizations')).toBe(before)
    expect(await count('events')).toBe(0)
  })

  it('concurrent repairs for an unlinked organisation create it once', async () => {
    const a = await knownUser('user_a')
    const b = await knownUser('user_b')
    clerkOrg('org_a', 'Acme', [])
    const args = (userId: string) => ({ userId, externalId: 'org_a', role: 'member' as const, known: { organizationId: null } })
    const ids = await Promise.all([repairMembership(db, kit.adapter, args(a.id)), repairMembership(db, kit.adapter, args(b.id))])
    expect(ids[0]).toBe(ids[1])
    expect(await live(ids[0])).toHaveLength(2)
    expect((await types()).filter((t) => t === 'organization.created')).toHaveLength(1)
    expect((await owner.selectFrom('organizations').selectAll().where('auth_org_id', '=', 'org_a').execute())).toHaveLength(1)
  })
})

describe('reconcileOrganization', () => {
  it('copies a whole organisation', async () => {
    const a = await knownUser('user_a')
    profile('user_b')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:admin'], ['user_b', 'org:member']])
    const s = await reconcileOrganization(db, kit.adapter, 'org_a')
    expect(s).toMatchObject({ created: 2, updated: 0, deleted: 0 })
    const org = (await linked('org_a'))!
    expect(s.organizationId).toBe(org.id)
    const b = await owner.selectFrom('users').selectAll().where('auth_subject', '=', 'user_b').executeTakeFirstOrThrow()
    expect(b).toMatchObject({ email: 'user_b@x.test', auth_provider: 'clerk' })
    const roles = Object.fromEntries((await live(org.id)).map((m) => [m.user_id, m.role]))
    expect(roles).toEqual({ [a.id]: 'owner', [b.id]: 'member' })
  })

  it('applies a role change and a removal', async () => {
    const a = await knownUser('user_a')
    profile('user_b')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:admin'], ['user_b', 'org:member']])
    await reconcileOrganization(db, kit.adapter, 'org_a')
    const before = await count('events')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:member']])
    const s = await reconcileOrganization(db, kit.adapter, 'org_a')
    expect(s).toMatchObject({ created: 0, updated: 1, deleted: 1 })
    const fresh = (await events()).slice(before)
    expect(fresh.map((e) => e.type).sort()).toEqual(['membership.deleted', 'membership.updated'])
    expect(fresh.find((e) => e.type === 'membership.deleted')!.after).toBeNull()
    const org = (await linked('org_a'))!
    const rows = await live(org.id)
    expect(rows.map((m) => [m.user_id, m.role])).toEqual([[a.id, 'member']])
  })

  it('renames', async () => {
    await knownUser('user_a')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:admin']])
    await reconcileOrganization(db, kit.adapter, 'org_a')
    clerkOrg('org_a', 'Acme Ltd', [['user_a', 'org:admin']])
    await reconcileOrganization(db, kit.adapter, 'org_a')
    const ev = (await events()).find((e) => e.type === 'organization.updated')!
    expect((ev.before as { name: string }).name).toBe('Acme')
    expect((ev.after as { name: string }).name).toBe('Acme Ltd')
  })

  it('is idempotent', async () => {
    await knownUser('user_a')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:admin']])
    await reconcileOrganization(db, kit.adapter, 'org_a')
    const before = await count('events')
    const s = await reconcileOrganization(db, kit.adapter, 'org_a')
    expect(s).toMatchObject({ created: 0, updated: 0, deleted: 0 })
    expect(await count('events')).toBe(before)
  })

  it('skips a member whose email belongs to another vault user', async () => {
    await knownUser('user_taken', 'taken@x.test')
    profile('user_c', 'taken@x.test')
    profile('user_d')
    clerkOrg('org_a', 'Acme', [['user_c', 'org:member'], ['user_d', 'org:member']])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await reconcileOrganization(db, kit.adapter, 'org_a')
    expect(s.created).toBe(1)
    const org = (await linked('org_a'))!
    const subs = await owner
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('users.auth_subject')
      .where('memberships.organization_id', '=', org.id)
      .execute()
    expect(subs.map((r) => r.auth_subject)).toEqual(['user_d'])
    expect(warn).toHaveBeenCalledWith('[directory] member skipped', { reason: 'account_conflict' })
  })

  it('an organisation Clerk deleted loses its memberships, not its row', async () => {
    const o = await seedOrganization(db, { authOrgId: 'org_a' })
    const u1 = await seedUser(db, { organizationId: o.id, role: 'owner', authSubject: 'user_1' })
    const u2 = await seedUser(db, { organizationId: o.id, role: 'member', authSubject: 'user_2' })
    const s = await reconcileOrganization(db, kit.adapter, 'org_a')
    expect(s).toEqual({ organizationId: o.id, created: 0, updated: 0, deleted: 2 })
    expect(await live(o.id)).toEqual([])
    expect((await types()).filter((t) => t === 'membership.deleted')).toHaveLength(2)
    expect(await linked('org_a')).toBeDefined()
    expect(u1.id && u2.id).toBeTruthy()
  })

  it('unknown and gone: nothing written', async () => {
    const s = await reconcileOrganization(db, kit.adapter, 'org_zzz')
    expect(s).toEqual({ organizationId: null, created: 0, updated: 0, deleted: 0 })
    expect(await count('events')).toBe(0)
    expect(await count('organizations')).toBe(0)
  })

  it('a directory failure changes nothing', async () => {
    await knownUser('user_a')
    clerkOrg('org_a', 'Acme', [['user_a', 'org:admin']])
    kit.fetch.fail.members = 500
    await expect(reconcileOrganization(db, kit.adapter, 'org_a')).rejects.toThrow('clerk membership list failed: 500')
    expect(await linked('org_a')).toBeUndefined()
    expect(await count('events')).toBe(0)
  })
})

describe('refreshUser', () => {
  it('updates the profile, without an event', async () => {
    const u = await knownUser('user_a', 'old@x.test')
    kit.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'new@x.test', verified: true, first: 'Grace', last: 'H' }))
    expect(await refreshUser(db, kit.adapter, 'user_a')).toBe('updated')
    const row = await owner.selectFrom('users').selectAll().where('id', '=', u.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ email: 'new@x.test', name: 'Grace H' })
    expect(await count('events')).toBe(0)
  })

  it('unknown, unchanged, conflict', async () => {
    expect(await refreshUser(db, kit.adapter, 'user_nobody')).toBe('unknown')
    expect(kit.fetch.calls).toHaveLength(0)

    await knownUser('user_a', 'a@x.test')
    kit.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true, first: 'Ada', last: 'L' }))
    await owner.updateTable('users').set({ name: 'Ada L' }).where('auth_subject', '=', 'user_a').execute()
    expect(await refreshUser(db, kit.adapter, 'user_a')).toBe('unchanged')

    await knownUser('user_v', 'v@x.test')
    kit.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'v@x.test', verified: true, first: 'Ada', last: 'L' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await refreshUser(db, kit.adapter, 'user_a')).toBe('conflict')
    expect(warn).toHaveBeenCalled()
    const row = await owner.selectFrom('users').select('email').where('auth_subject', '=', 'user_a').executeTakeFirstOrThrow()
    expect(row.email).toBe('a@x.test')
  })
})
