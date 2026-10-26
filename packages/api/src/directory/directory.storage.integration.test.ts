import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { uuidv7, type StorageBinding } from '@vault/storage'
import { postgresBinding } from '@vault/storage-postgres'
import { d1Binding } from '@vault/storage-d1'
import { clearD1 } from '@vault/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vault/storage-d1/test/seed'
import { ApiError, mapStorageError } from '../errors.js'
import { openEngines, type Engine, type RawRow } from '../test/engines.js'
import { openAuthKit, type AuthKit } from '../test/auth-kit.js'
import { clerkMembership, clerkOrganization } from '../test/clerk.js'
import { reconcileOrganization, refreshUser, repairMembership } from './sync.js'

// The directory on both engines (CORE41 Step 2.3): repair, reconcile, refresh, the system principal, the webhook and the
// sign-in copy-newer rule, with the same assertions on Postgres and D1. Every event is attributed to the system principal.
const NOW = new Date('2026-10-22T10:00:00.000Z')
const SEED = '2026-10-22T08:00:00.000Z'
const iso = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString()

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('the directory on %s', (name) => {
  let e: Engine
  let kit: AuthKit
  let orgName: string
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    kit = await openAuthKit(e)
    orgName = (await e.rows('organizations'))[0]!.name as string
  })
  afterEach(() => vi.restoreAllMocks())

  const ALL = ['organizations', 'principals', 'users', 'memberships', 'events'] as const
  const state = async () => Object.fromEntries(await Promise.all(ALL.map(async (t) => [t, await e.rows(t)] as const)))
  const system = async () => (await e.rows('principals')).find((p) => p.kind === 'system')
  const events = async () => e.rows('events')
  const types = async () => (await events()).map((x) => x.type as string)
  const live = async (org = e.organizationId) => (await e.rows('memberships')).filter((m) => m.organization_id === org && m.deleted_at === null)
  const membershipOf = async (userId: string) => (await e.rows('memberships')).find((m) => m.user_id === userId)!
  const lastUnit = (n: string) => kit.ran.filter((r) => r.name === n).at(-1)
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  /** The fake Clerk's copy of an organisation: `members` are [subject, 'admin' | 'member']. */
  function clerkOrg(ext: string, orgTitle: string, members: Array<[string, 'admin' | 'member']>) {
    kit.clerk.organizations.set(ext, clerkOrganization({ id: ext, name: orgTitle }))
    kit.clerk.members.set(ext, members.map(([userId, role]) => clerkMembership({ organizationId: ext, userId, role: `org:${role}` })))
  }
  const standard = (extra: Array<[string, 'admin' | 'member']> = []) =>
    clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'member'], ...extra])

  /** Every event of the test was written by the system principal, at the injected instant. */
  async function expectSystemAuthored() {
    const sys = await system()
    expect(sys, 'a system principal exists when events were written').toBeDefined()
    for (const ev of await events()) {
      expect(ev.actor_id).toBe(sys!.id)
      expect(ev.created_at).toBe(NOW.toISOString())
    }
  }

  /** A state with a new organisation to create: Postgres names an unseen provider id; D1 clears the organisation and keeps the deployment marker. */
  async function freshOrganization(): Promise<string> {
    if (name === 'postgres') return 'org_fresh'
    await clearD1(e.d1!)
    await seedDeployment(e.d1!, { organizationId: e.organizationId, externalId: e.authOrgId, organization: false })
    await seedPrincipal(e.d1!, { id: e.userId, kind: 'user', authSubject: e.userSubject })
    return e.authOrgId
  }

  describe('repair (a sign-in with an organisation claim)', () => {
    it('creates a new organisation and the membership: both events by the system principal, created lazily, all at now', async () => {
      const ext = await freshOrganization()
      clerkOrg(ext, 'Fresh org', [])
      const id = await repairMembership(kit.binding, kit.clerk.adapter, { userId: e.userId, externalId: ext, role: 'owner', known: { organizationId: null } }, kit.env())
      if (name === 'd1') expect(id).toBe(e.organizationId)
      const org = (await e.rows('organizations')).find((o) => o.id === id)!
      expect(org).toMatchObject({ name: 'Fresh org', auth_provider: 'clerk', auth_org_id: ext, created_at: NOW.toISOString(), updated_at: NOW.toISOString() })
      const sys = (await system())!
      expect(sys.created_at).toBe(NOW.toISOString())
      const m = await membershipOf(e.userId)
      expect(m).toMatchObject({ organization_id: id, role: 'owner', created_by: sys.id, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), deleted_at: null })
      const evs = await events()
      expect(evs.map((x) => x.type)).toEqual(['organization.created', 'membership.created'])
      expect(evs[0]).toMatchObject({ resource_type: 'organization', resource_id: id, organization_id: id, before: null, after: { id, name: 'Fresh org', created_at: NOW.toISOString(), updated_at: NOW.toISOString() } })
      expect(evs[1]).toMatchObject({ resource_type: 'membership', resource_id: m.id, before: null })
      expect(evs[1]!.after).toMatchObject({ id: m.id, role: 'owner', user_id: e.userId, created_by: sys.id })
      await expectSystemAuthored()
      expect(kit.ran.map((r) => r.identity)).toEqual([{ kind: 'internal', organizationId: null }])
    })

    it('re-roles a live membership with one update: membership.updated carries the planned record as before', async () => {
      const before = await membershipOf(e.user2Id)
      await repairMembership(kit.binding, kit.clerk.adapter, { userId: e.user2Id, externalId: e.authOrgId, role: 'owner', known: { organizationId: e.organizationId } }, kit.env())
      expect(await membershipOf(e.user2Id)).toMatchObject({ role: 'owner', created_at: SEED, updated_at: NOW.toISOString(), deleted_at: null })
      const evs = await events()
      expect(evs.map((x) => x.type)).toEqual(['membership.updated'])
      expect(evs[0]!.before).toEqual({ id: before.id, organization_id: e.organizationId, user_id: e.user2Id, role: 'member', created_by: before.created_by, created_at: SEED, updated_at: SEED })
      expect(evs[0]!.after).toMatchObject({ id: before.id, role: 'owner', updated_at: NOW.toISOString() })
      await expectSystemAuthored()
      expect(kit.ran.at(-1)!.identity).toEqual({ kind: 'internal', organizationId: e.organizationId })
      expect(kit.ran.at(-1)!.stats!.locks).toBe(name === 'postgres' ? 1 : 0)
    })

    it('a membership that already matches runs no statement and creates no system principal', async () => {
      const before = await state()
      await repairMembership(kit.binding, kit.clerk.adapter, { userId: e.userId, externalId: e.authOrgId, role: 'owner', known: { organizationId: e.organizationId } }, kit.env())
      expect(await state()).toEqual(before)
      expect(kit.ran.at(-1)!.stats!.writes).toBe(0)
      expect(await system()).toBeUndefined()
    })

    it('creates a missing membership of a known organisation', async () => {
      const lone = uuidv7()
      await e.insert('principals', { id: lone, kind: 'user' })
      await e.insert('users', { id: lone, email: 'lone@x.test', auth_provider: 'clerk', auth_subject: 'user_lone' })
      await repairMembership(kit.binding, kit.clerk.adapter, { userId: lone, externalId: e.authOrgId, role: 'member', known: { organizationId: e.organizationId } }, kit.env())
      expect(await membershipOf(lone)).toMatchObject({ role: 'member', deleted_at: null, created_at: NOW.toISOString() })
      expect(await types()).toEqual(['membership.created'])
      await expectSystemAuthored()
    })

    it('an organisation the provider no longer has is 403 organization_forbidden, decided before any unit', async () => {
      const before = await state()
      const err = await repairMembership(kit.binding, kit.clerk.adapter, { userId: e.userId, externalId: 'org_gone', role: 'owner', known: { organizationId: null } }, kit.env()).catch((x: unknown) => x)
      expect(err).toMatchObject({ status: 403, code: 'organization_forbidden' })
      expect(kit.ran).toEqual([])
      expect(await state()).toEqual(before)
    })

    if (name === 'd1') {
      it('the membership inserted between plan and commit: the unit drifts, is retried once and applies nothing twice (D1)', async () => {
        const lone = uuidv7()
        await e.insert('principals', { id: lone, kind: 'user' })
        await e.insert('users', { id: lone, email: 'lone@x.test', auth_provider: 'clerk', auth_subject: 'user_lone' })
        kit.armOn('directory.repair', async () => {
          await e.insert('memberships', { organization_id: e.organizationId, user_id: lone, role: 'member', created_by: lone })
        })
        await repairMembership(kit.binding, kit.clerk.adapter, { userId: lone, externalId: e.authOrgId, role: 'member', known: { organizationId: e.organizationId } }, kit.env())
        expect(kit.ran.map((r) => r.name)).toEqual(['directory.repair', 'directory.repair'])
        expect((await live()).filter((m) => m.user_id === lone)).toHaveLength(1)
      })

      it('the organisation created between plan and commit: one organisation and the membership applied (D1)', async () => {
        const ext = await freshOrganization()
        clerkOrg(ext, 'Fresh org', [])
        kit.armOn('directory.repair', async () => {
          await e.insert('organizations', { id: e.organizationId, name: 'Racer', auth_provider: 'clerk', auth_org_id: ext })
        })
        const id = await repairMembership(kit.binding, kit.clerk.adapter, { userId: e.userId, externalId: ext, role: 'owner', known: { organizationId: null } }, kit.env())
        expect(id).toBe(e.organizationId)
        expect(await e.rows('organizations')).toHaveLength(1)
        expect(await live()).toHaveLength(1)
      })
    }

    it('copy-newer rule: a membership soft-deleted after the token was issued wins, and nothing is written', async () => {
      const m = await membershipOf(e.user2Id)
      await e.update('memberships', m.id as string, { deleted_at: iso(6), updated_at: iso(6) })
      const before = await state()
      const res = await kit.call('/tasks', e.user2Subject, { claim: { id: e.authOrgId, rol: 'member' } })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('organization_forbidden')
      expect(await state()).toEqual(before)
    })

    it('with no stored copy the claim creates the membership (the documented CORE3 D20 gap, rule 15)', async () => {
      const lone = uuidv7()
      await e.insert('principals', { id: lone, kind: 'user' })
      await e.insert('users', { id: lone, email: 'lone@x.test', auth_provider: 'clerk', auth_subject: 'user_lone' })
      standard()
      const res = await kit.call('/tasks', 'user_lone', { claim: { id: e.authOrgId, rol: 'admin' } })
      expect(res.status).toBe(200)
      expect(await membershipOf(lone)).toMatchObject({ role: 'owner', deleted_at: null })
      expect(await types()).toEqual(['membership.created'])
      await expectSystemAuthored()
    })
  })

  describe('reconcile', () => {
    it('creates, re-roles and deletes in one snapshot: the summary, three event types and the final set', async () => {
      const gone = await e.seedMember('member', { subject: 'user_gone', email: 'gone@x.test' })
      kit.profile('user_new', { email: 'new@x.test' })
      clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'admin'], ['user_new', 'member']])
      const goneBefore = await membershipOf(gone.userId)
      const u2Before = await membershipOf(e.user2Id)

      const summary = await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect(summary).toEqual({ organizationId: e.organizationId, created: 1, updated: 1, deleted: 1 })

      const newUser = (await e.rows('users')).find((u) => u.auth_subject === 'user_new')!
      const sys = (await system())!
      const roles = Object.fromEntries((await live()).map((m) => [m.user_id as string, m.role]))
      expect(roles).toEqual({ [e.userId]: 'owner', [e.user2Id]: 'owner', [newUser.id as string]: 'member' })
      expect(await membershipOf(gone.userId)).toMatchObject({ deleted_at: NOW.toISOString(), updated_at: NOW.toISOString() })
      expect(await membershipOf(e.user2Id)).toMatchObject({ role: 'owner', updated_at: NOW.toISOString(), created_at: SEED })
      expect(await membershipOf(newUser.id as string)).toMatchObject({ created_by: sys.id, created_at: NOW.toISOString(), updated_at: NOW.toISOString() })

      const evs = await events()
      expect(evs.map((x) => x.type)).toEqual(['membership.created', 'membership.updated', 'membership.deleted'])
      const rec = (m: RawRow) => ({ id: m.id, organization_id: m.organization_id, user_id: m.user_id, role: m.role, created_by: m.created_by, created_at: m.created_at, updated_at: m.updated_at })
      expect(evs[0]).toMatchObject({ before: null, resource_id: (await membershipOf(newUser.id as string)).id })
      expect(evs[1]!.before).toEqual(rec(u2Before))
      expect(evs[1]!.after).toMatchObject({ role: 'owner', updated_at: NOW.toISOString() })
      expect(evs[2]!.before).toEqual(rec(goneBefore))
      expect(evs[2]!.after).toBeNull()
      await expectSystemAuthored()
    })

    it('an identical second run writes nothing and emits nothing', async () => {
      standard()
      kit.profile('user_new')
      clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'member'], ['user_new', 'member']])
      await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      const before = await state()
      const evCount = (await events()).length
      const summary = await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect(summary).toEqual({ organizationId: e.organizationId, created: 0, updated: 0, deleted: 0 })
      expect(await state()).toEqual(before)
      expect((await events()).length).toBe(evCount)
      expect(lastUnit('directory.reconcile')!.stats!.writes).toBe(0)
    })

    it('a snapshot of 1 and of 10 new members cost the same number of statements', async () => {
      const cost = async (members: number) => {
        await e.reset()
        kit = await openAuthKit(e)
        const subs = Array.from({ length: members }, (_, i) => `user_n${i}`)
        for (const s of subs) kit.profile(s)
        clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'member'], ...subs.map((s): [string, 'member'] => [s, 'member'])])
        await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
        expect((await live()).length).toBe(2 + members)
        return lastUnit('directory.reconcile')!.stats!.statements
      }
      const one = await cost(1)
      const ten = await cost(10)
      expect(ten).toBe(one)
    })

    it('a snapshot over the cap is refused 400 set_limit_exceeded before anything is fetched or written; the same programs pass at a larger cap', async () => {
      const bindingFor = (cap: number): StorageBinding =>
        name === 'postgres'
          ? postgresBinding(e.app!, { maxSetSize: cap })
          : d1Binding(e.d1!, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId, maxSetSize: cap })
      const subs = ['user_a', 'user_b', 'user_c', 'user_d']
      for (const s of subs) kit.profile(s)
      clerkOrg(e.authOrgId, orgName, subs.map((s): [string, 'member'] => [s, 'member']))

      const small = await openAuthKit(e, { binding: bindingFor(3) })
      small.clerk.organizations.set(e.authOrgId, kit.clerk.organizations.get(e.authOrgId)!)
      small.clerk.members.set(e.authOrgId, kit.clerk.members.get(e.authOrgId)!)
      for (const s of subs) small.profile(s)
      const warn = quiet()
      const before = await state()
      const err = await reconcileOrganization(small.binding, small.clerk.adapter, e.authOrgId, small.env()).catch((x: unknown) => mapStorageError(x))
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 400, code: 'set_limit_exceeded' })
      expect(await state()).toEqual(before)
      expect(small.clerk.fetch.calls.filter((c) => c.url.includes('/v1/users/'))).toEqual([])
      const logged = warn.mock.calls.find((c) => c[0] === '[directory] snapshot over the set limit')
      expect(logged?.[1]).toEqual({ members: 4, limit: 3 })

      const large = await openAuthKit(e, { binding: bindingFor(500) })
      large.clerk.organizations.set(e.authOrgId, kit.clerk.organizations.get(e.authOrgId)!)
      large.clerk.members.set(e.authOrgId, kit.clerk.members.get(e.authOrgId)!)
      for (const s of subs) large.profile(s)
      const summary = await reconcileOrganization(large.binding, large.clerk.adapter, e.authOrgId, large.env())
      expect(summary.created).toBe(4)
      expect((await live()).length).toBe(4)
    })

    it('a fetch failure writes nothing', async () => {
      standard()
      kit.profile('user_new')
      clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], ['user_new', 'member']])
      kit.clerk.fetch.fail.members = 500
      const before = await state()
      await expect(reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())).rejects.toThrow()
      expect(await state()).toEqual(before)
      expect(kit.ran).toEqual([])
    })

    it('a member with a non-ASCII or a taken email is skipped with a warning and the others are applied', async () => {
      await e.seedMember('member', { subject: 'user_holder', email: 'held@x.test' })
      kit.profile('user_u', { email: 'ñ@x.test' })
      kit.profile('user_t', { email: 'HELD@x.test' })
      kit.profile('user_ok', { email: 'ok@x.test' })
      const warn = quiet()
      clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'member'], ['user_u', 'member'], ['user_t', 'member'], ['user_ok', 'member']])
      const summary = await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect(summary).toMatchObject({ created: 1, deleted: 1 }) // user_holder is not in the snapshot: removed
      const reasons = warn.mock.calls.filter((c) => c[0] === '[directory] member skipped').map((c) => (c[1] as { reason: string }).reason)
      expect(reasons.sort()).toEqual(['account_conflict', 'invalid_identity'])
      const subjects = (await e.rows('users')).filter((u) => (live().then(() => true), ['user_u', 'user_t'].includes(u.auth_subject as string)))
      expect(subjects).toEqual([])
    })

    it('an organisation Clerk deleted loses its live memberships, not its row', async () => {
      kit.clerk.organizations.delete(e.authOrgId)
      const orgBefore = (await e.rows('organizations'))[0]
      const summary = await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect(summary).toEqual({ organizationId: e.organizationId, created: 0, updated: 0, deleted: 2 })
      expect(await live()).toEqual([])
      expect((await e.rows('organizations'))[0]).toEqual(orgBefore)
      expect(await types()).toEqual(['membership.deleted', 'membership.deleted'])
      await expectSystemAuthored()
    })

    it('an organisation neither side knows writes nothing', async () => {
      const before = await state()
      const summary = await reconcileOrganization(kit.binding, kit.clerk.adapter, 'org_nobody', kit.env())
      expect(summary).toEqual({ organizationId: null, created: 0, updated: 0, deleted: 0 })
      expect(await state()).toEqual(before)
    })

    it('a renamed organisation emits organization.updated with the planned record as before', async () => {
      clerkOrg(e.authOrgId, 'Renamed', [[e.userSubject, 'admin'], [e.user2Subject, 'member']])
      const before = (await e.rows('organizations'))[0]!
      await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect((await e.rows('organizations'))[0]).toMatchObject({ name: 'Renamed', created_at: before.created_at, updated_at: NOW.toISOString() })
      const evs = await events()
      expect(evs.map((x) => x.type)).toEqual(['organization.updated'])
      expect(evs[0]!.before).toEqual({ id: e.organizationId, name: orgName, created_at: SEED, updated_at: SEED })
      expect(evs[0]!.after).toEqual({ id: e.organizationId, name: 'Renamed', created_at: SEED, updated_at: NOW.toISOString() })
      await expectSystemAuthored()
    })

    it('a change that emits no event never creates the system principal', async () => {
      standard()
      await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env())
      expect(await system()).toBeUndefined()
    })

    if (name === 'd1') {
      // Each case changes the live set between the plan and the commit; the unit must abort whole and change nothing.
      const drift = (label: string, hook: () => Promise<void>) =>
        it(`drift: ${label} between plan and commit is 409 conflict and nothing changes (D1)`, async () => {
          kit.profile('user_new')
          clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], ['user_new', 'member']]) // plan: create user_new, delete user2
          const hookBefore = { done: false }
          kit.armOn('directory.reconcile', async () => {
            hookBefore.done = true
            await hook()
          })
          let snapshot: Awaited<ReturnType<typeof state>> | undefined
          const arm = kit.binding.runtime.execute
          // snapshot after the hook ran: the drifted unit must leave exactly that state
          kit.binding.runtime.execute = async (identity, prepared) => {
            try {
              return await arm(identity, prepared)
            } finally {
              if (prepared.name === 'directory.reconcile') snapshot = await state()
            }
          }
          const before = await state()
          const err = await reconcileOrganization(kit.binding, kit.clerk.adapter, e.authOrgId, kit.env()).catch((x: unknown) => mapStorageError(x))
          expect(hookBefore.done).toBe(true)
          expect(err).toBeInstanceOf(ApiError)
          expect(err).toMatchObject({ status: 409, code: 'conflict' })
          // the hook's own writes are the only difference from the state before the call
          const after = await state()
          expect(after.events).toEqual(before.events)
          expect(after.memberships.map((m) => m.id).sort()).toEqual(snapshot!.memberships.map((m) => m.id).sort())
          expect(after.memberships.filter((m) => m.deleted_at !== null).length).toBe(snapshot!.memberships.filter((m) => m.deleted_at !== null).length)
        })

      drift('a live membership added', async () => {
        const extra = await e.seedMember('member', { subject: 'user_extra', email: 'extra@x.test' })
        void extra
      })
      drift('a planned delete removed by someone else', async () => {
        const m = await membershipOf(e.user2Id)
        await e.update('memberships', m.id as string, { deleted_at: iso(-5), updated_at: iso(-5) })
      })
      drift('a swap that keeps the count (an unplanned row replaces a kept one)', async () => {
        const m = await membershipOf(e.userId)
        await e.update('memberships', m.id as string, { deleted_at: iso(-5), updated_at: iso(-5) })
        await e.seedMember('member', { subject: 'user_swap', email: 'swap@x.test' })
      })
    }
  })

  describe('refresh', () => {
    const stored = async () => (await e.rows('users')).find((u) => u.id === e.userId)!

    it('a changed profile updates the user and stamps updated_at, with no event', async () => {
      const before = await stored()
      kit.profile(e.userSubject, { email: 'New.Email@X.test', first: 'New', last: 'Name', verified: true })
      expect(await refreshUser(kit.binding, kit.clerk.adapter, e.userSubject, kit.env())).toBe('updated')
      expect(await stored()).toMatchObject({ email: 'new.email@x.test', name: 'New Name', email_verified: true, created_at: before.created_at, updated_at: NOW.toISOString() })
      expect(await events()).toEqual([])
      expect(lastUnit('directory.refresh')!.stats!.writes).toBeGreaterThanOrEqual(1)
    })

    it('an unchanged profile writes nothing', async () => {
      const u = await stored()
      kit.profile(e.userSubject, { email: u.email as string, first: null, last: null, verified: false })
      const before = await state()
      expect(await refreshUser(kit.binding, kit.clerk.adapter, e.userSubject, kit.env())).toBe('unchanged')
      expect(await state()).toEqual(before)
    })

    it('an unknown subject is unknown, with no profile fetch and nothing written', async () => {
      const before = await state()
      expect(await refreshUser(kit.binding, kit.clerk.adapter, 'user_nobody', kit.env())).toBe('unknown')
      expect(kit.clerk.fetch.calls).toEqual([])
      expect(await state()).toEqual(before)
    })

    it('an email belonging to another account is a conflict and nothing is written', async () => {
      const other = (await e.rows('users')).find((u) => u.id === e.user2Id)!
      kit.profile(e.userSubject, { email: (other.email as string).toUpperCase() })
      quiet()
      const before = await state()
      expect(await refreshUser(kit.binding, kit.clerk.adapter, e.userSubject, kit.env())).toBe('conflict')
      expect(await state()).toEqual(before)
    })

    it('a non-ASCII email is unsupported, logged, and nothing is written', async () => {
      kit.profile(e.userSubject, { email: 'ñandú@x.test' })
      const warn = quiet()
      const before = await state()
      expect(await refreshUser(kit.binding, kit.clerk.adapter, e.userSubject, kit.env())).toBe('unsupported')
      expect(warn).toHaveBeenCalled()
      expect(await state()).toEqual(before)
    })

    it('a profile with no email is unchanged', async () => {
      kit.profile(e.userSubject, { email: null })
      quiet()
      const before = await state()
      expect(await refreshUser(kit.binding, kit.clerk.adapter, e.userSubject, kit.env())).toBe('unchanged')
      expect(await state()).toEqual(before)
    })
  })

  describe('the webhook through the app', () => {
    const delivery = (type: string, data: unknown) => ({ type, object: 'event', data, timestamp: NOW.getTime() })

    it('a bad signature is 401 and nothing is fetched or written', async () => {
      quiet()
      const before = await state()
      const res = await kit.webhook(delivery('organization.updated', { id: e.authOrgId }), { headers: { 'svix-signature': 'v1,AAAA' } })
      expect(res.status).toBe(401)
      expect(kit.clerk.fetch.calls).toEqual([])
      expect(await state()).toEqual(before)
    })

    it('a delivery reconciles the organisation: 200 { received: true }', async () => {
      kit.profile('user_new')
      clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], [e.user2Subject, 'member'], ['user_new', 'member']])
      const res = await kit.webhook(delivery('organization.updated', { id: e.authOrgId }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ received: true })
      expect(await types()).toEqual(['membership.created'])
      await expectSystemAuthored()
    })

    it('user.updated refreshes the profile; the user read shows it', async () => {
      kit.profile(e.userSubject, { email: 'fresh@x.test', first: 'Fresh', last: 'Face' })
      const res = await kit.webhook(delivery('user.updated', { id: e.userSubject }))
      expect(res.status).toBe(200)
      const u = (await e.rows('users')).find((x) => x.id === e.userId)!
      expect(u).toMatchObject({ email: 'fresh@x.test', name: 'Fresh Face', updated_at: NOW.toISOString() })
    })

    it('an ignored event type is 200 and does nothing', async () => {
      const res = await kit.webhook(delivery('session.created', { id: 'sess_1' }))
      expect(res.status).toBe(200)
      expect(kit.clerk.fetch.calls).toEqual([])
    })

    it('a fetch failure is 500, so the provider retries', async () => {
      quiet()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      standard()
      kit.clerk.fetch.fail.organization = 500
      const res = await kit.webhook(delivery('organization.updated', { id: e.authOrgId }))
      expect(res.status).toBe(500)
    })

    if (name === 'd1') {
      it('a delivery for another organisation is acknowledged 200 and ignored: no fetch, no unit (D1)', async () => {
        clerkOrg('org_elsewhere', 'Elsewhere', [])
        const before = await state()
        const res = await kit.webhook(delivery('organization.created', { id: 'org_elsewhere' }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ received: true })
        expect(kit.clerk.fetch.calls).toEqual([])
        expect(kit.ran).toEqual([])
        expect(await state()).toEqual(before)
      })

      it('drift is 409 conflict (D1)', async () => {
        quiet()
        kit.profile('user_new')
        clerkOrg(e.authOrgId, orgName, [[e.userSubject, 'admin'], ['user_new', 'member']])
        kit.armOn('directory.reconcile', async () => {
          await e.seedMember('member', { subject: 'user_extra', email: 'extra@x.test' })
        })
        const res = await kit.webhook(delivery('organization.updated', { id: e.authOrgId }))
        expect(res.status).toBe(409)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict')
      })
    } else {
      it('a delivery for another organisation creates it (Postgres is multi-tenant)', async () => {
        clerkOrg('org_elsewhere', 'Elsewhere', [])
        const res = await kit.webhook(delivery('organization.created', { id: 'org_elsewhere' }))
        expect(res.status).toBe(200)
        expect((await e.rows('organizations')).map((o) => o.name).sort()).toEqual(['Elsewhere', orgName].sort())
        expect(await types()).toEqual(['organization.created'])
      })
    }

    it('a snapshot over the cap is 400 set_limit_exceeded', async () => {
      const bindingSmall: StorageBinding =
        name === 'postgres'
          ? postgresBinding(e.app!, { maxSetSize: 1 })
          : d1Binding(e.d1!, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId, maxSetSize: 1 })
      const small = await openAuthKit(e, { binding: bindingSmall })
      quiet()
      small.clerk.organizations.set(e.authOrgId, clerkOrganization({ id: e.authOrgId, name: orgName }))
      small.clerk.members.set(e.authOrgId, [clerkMembership({ organizationId: e.authOrgId, userId: e.userSubject, role: 'org:admin' }), clerkMembership({ organizationId: e.authOrgId, userId: e.user2Subject, role: 'org:member' })])
      const res = await small.webhook(delivery('organization.updated', { id: e.authOrgId }))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('set_limit_exceeded')
    })
  })
})

// keep the raw SQL import used for typing the owner pool in editors
void sql
