import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { ApiError } from '../errors.js'
import { openEngines, type Engine } from '../test/engines.js'
import { openAuthKit, type AuthKit } from '../test/auth-kit.js'
import { API_KEY_PREFIX, authenticateApiKey, generateApiKey, hashApiKey, apiKeyAuthOperation } from './api-keys.js'
import { AuthFailure } from './adapter.js'
import { lookupUser, provisionUser } from './first-sight.js'

// Authentication on both engines (CORE41 Step 2.2): API keys, the user lookup, first sight, D19 admission and
// `me.get`, run through the real binding with the same assertions on Postgres and D1.
const NOW = new Date('2026-10-22T10:00:00.000Z')
const SEED = '2026-10-22T08:00:00.000Z'
const iso = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString()
const internal = { kind: 'internal', organizationId: null } as const

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('authentication on %s', (name) => {
  let e: Engine
  let kit: AuthKit
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    kit = await openAuthKit(e)
  })
  afterEach(() => vi.restoreAllMocks())

  const state = async () => ({
    principals: await e.rows('principals'),
    users: await e.rows('users'),
    memberships: await e.rows('memberships'),
    organizations: await e.rows('organizations'),
    api_keys: await e.rows('api_keys'),
    events: await e.rows('events'),
  })
  const row = async (table: string, id: string) => (await e.rows(table)).find((r) => r.id === id)!
  const userPrincipals = async () => (await e.rows('principals')).filter((p) => p.kind === 'user')

  /** A key for the seeded agent; `over` overrides columns. */
  async function seedKey(over: Record<string, unknown> = {}) {
    const { key, hash, prefix } = await generateApiKey(() => crypto.getRandomValues(new Uint8Array(32)))
    const created = await e.insert('api_keys', { agent_id: e.agentId, key_hash: hash, prefix, ...over })
    return { key, hash, id: created.id as string }
  }
  const unitsNamed = (n: string) => kit.ran.filter((r) => r.name === n)

  describe('API keys', () => {
    it('a valid key is the agent principal, with the agent scopes', async () => {
      await e.update('agents', e.agentId, { scopes: ['tasks:read', 'tasks:write'] })
      const { key } = await seedKey()
      const principal = await authenticateApiKey(kit.binding, key, kit.env())
      expect(principal).toMatchObject({ actor: { id: e.agentId, kind: 'agent' }, organizationId: e.organizationId })
      expect(principal!.scopes.toStrings()).toEqual(['tasks:read', 'tasks:write'])
    })

    it.each([
      ['an unknown key', async () => ({ key: `${API_KEY_PREFIX}${'z'.repeat(43)}` })],
      ['a revoked key', () => seedKey({ revoked_at: iso(-10) })],
      ['a key expiring exactly now', () => seedKey({ expires_at: iso(0) })],
      ['an expired key', () => seedKey({ expires_at: iso(-1) })],
      ['a key of a disabled agent', async () => {
        await e.update('agents', e.agentId, { disabled_at: iso(-10) })
        return seedKey()
      }],
    ])('%s is refused and nothing is written', async (_n, make) => {
      const { key } = await make()
      const before = await state()
      expect(await authenticateApiKey(kit.binding, key, kit.env())).toBeNull()
      expect(await state()).toEqual(before)
      expect(kit.ran.at(-1)!.stats!.writes).toBe(0)
    })

    it('stamps a never-used key with now: last_used_at only, no updated_at, no event, one statement', async () => {
      const { key, id } = await seedKey()
      await authenticateApiKey(kit.binding, key, kit.env())
      const after = await row('api_keys', id)
      expect(after.last_used_at).toBe(NOW.toISOString())
      expect(after.updated_at).toBe(SEED)
      expect(await e.rows('events')).toEqual([])
      expect(kit.ran.at(-1)).toMatchObject({ name: 'auth.api_key', identity: internal })
      expect(kit.ran.at(-1)!.stats).toMatchObject({ writes: 1, locks: 0 })
    })

    it('a key used 59 seconds ago is not stamped; one used 61 seconds ago is', async () => {
      const recent = await seedKey({ last_used_at: iso(-59) })
      const stale = await seedKey({ last_used_at: iso(-61) })
      await authenticateApiKey(kit.binding, recent.key, kit.env())
      expect(kit.ran.at(-1)!.stats!.writes).toBe(0)
      expect((await row('api_keys', recent.id)).last_used_at).toBe(iso(-59))
      await authenticateApiKey(kit.binding, stale.key, kit.env())
      expect(kit.ran.at(-1)!.stats!.writes).toBe(1)
      expect((await row('api_keys', stale.id)).last_used_at).toBe(NOW.toISOString())
    })

    it('authenticates a request through the app and stamps the key', async () => {
      await e.update('agents', e.agentId, { scopes: ['tasks:read'] })
      const { key, id } = await seedKey()
      const res = await kit.keyCall('/tasks', key)
      expect(res.status).toBe(200)
      expect((await row('api_keys', id)).last_used_at).toBe(NOW.toISOString())
    })

    it('a refused key is 401 and logs neither the key past 8 characters nor its hash', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const revoked = await seedKey({ revoked_at: iso(-10) })
      const res = await kit.keyCall('/tasks', revoked.key)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error).toEqual({ code: 'unauthenticated', message: 'invalid or expired credentials' })
      const logs = JSON.stringify(warn.mock.calls)
      expect(logs).toContain(revoked.key.slice(0, 8))
      expect(logs).not.toContain(revoked.key.slice(0, 9))
      expect(logs).not.toContain(revoked.hash)
      expect(logs).not.toContain(await hashApiKey(revoked.key))
    })

    if (name === 'd1') {
      it('a racing stamp between plan and commit: the unit is a no-op and the first stamp stands (D1)', async () => {
        const { key, id } = await seedKey()
        kit.armOn('auth.api_key', async () => e.update('api_keys', id, { last_used_at: iso(-1) }))
        const principal = await authenticateApiKey(kit.binding, key, kit.env())
        expect(principal).not.toBeNull()
        expect((await row('api_keys', id)).last_used_at).toBe(iso(-1))
      })
    }

    it('the unit is the program a caller can compile: one internal unit with no organisation', async () => {
      const { hash } = await seedKey()
      const res = await e.runAs(internal, apiKeyAuthOperation(hash, NOW))
      expect(res.value).toMatchObject({ actor: { id: e.agentId } })
      expect(res.stats.writes).toBe(1)
    })
  })

  describe('lookup and first sight', () => {
    it('a known subject is a read-only unit that finds the latest membership of the linked organisation', async () => {
      const login = await lookupUser(kit.binding, { provider: 'clerk', subject: e.userSubject, organizationExternalId: e.authOrgId })
      expect(login).toMatchObject({ userId: e.userId, linkedOrganizationId: e.organizationId, latestMembership: { role: 'owner', deletedAt: null } })
      expect(login!.latestMembership!.updatedAt).toBeInstanceOf(Date)
      expect(kit.ran.at(-1)!.stats).toMatchObject({ writes: 0, locks: 0 })
    })

    it('an unknown subject is null; a known one without a claim has no organisation', async () => {
      expect(await lookupUser(kit.binding, { provider: 'clerk', subject: 'nobody', organizationExternalId: null })).toBeNull()
      expect(await lookupUser(kit.binding, { provider: 'clerk', subject: e.userSubject, organizationExternalId: null })).toEqual({
        userId: e.userId,
        linkedOrganizationId: null,
        latestMembership: null,
      })
    })

    it('a new subject gets one principal and one user (normalised email, stamps = now) and no event', async () => {
      kit.profile('user_new', { email: '  Ada@X.Test ' })
      const before = (await userPrincipals()).length
      const login = await provisionUser(kit.binding, kit.clerk.adapter, 'user_new', kit.env())
      expect(login).toEqual({ userId: expect.any(String), linkedOrganizationId: null, latestMembership: null })
      expect(await userPrincipals()).toHaveLength(before + 1)
      expect(await row('principals', login.userId)).toMatchObject({ kind: 'user', created_at: NOW.toISOString() })
      expect(await row('users', login.userId)).toMatchObject({
        email: 'ada@x.test',
        name: 'Ada L',
        email_verified: true,
        auth_provider: 'clerk',
        auth_subject: 'user_new',
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
      expect(await e.rows('events')).toEqual([])
      expect(unitsNamed('auth.first_sight')).toHaveLength(1)
    })

    it('the email of another user, in any case, is 409 account_conflict and nothing is written', async () => {
      await e.seedMember('member', { email: 'taken@x.test' })
      kit.profile('user_c', { email: 'TAKEN@X.test' })
      const before = await state()
      const err = await provisionUser(kit.binding, kit.clerk.adapter, 'user_c', kit.env()).catch((x: unknown) => x)
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 409, code: 'account_conflict' })
      expect(await state()).toEqual(before)
    })

    it('a non-ASCII email is 400 invalid_identity, no unit runs and nothing is written', async () => {
      kit.profile('user_u', { email: 'ñandú@x.test' })
      const before = await state()
      const err = await provisionUser(kit.binding, kit.clerk.adapter, 'user_u', kit.env()).catch((x: unknown) => x)
      expect(err).toMatchObject({ status: 400, code: 'invalid_identity', message: 'non-ASCII email addresses are not supported' })
      expect(kit.ran).toEqual([])
      expect(await state()).toEqual(before)
    })

    it('a profile with no email is 401 (no_email), no unit runs and nothing is written', async () => {
      kit.profile('user_n', { email: null })
      const before = await state()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const err = await provisionUser(kit.binding, kit.clerk.adapter, 'user_n', kit.env()).catch((x: unknown) => x)
      expect(err).toBeInstanceOf(AuthFailure)
      expect(err).toMatchObject({ status: 401, reason: 'no_email' })
      expect(kit.ran).toEqual([])
      expect(await state()).toEqual(before)
    })

    if (name === 'd1') {
      it('the subject inserted between plan and commit: the recheck returns the winner and no orphan principal remains (D1)', async () => {
        kit.profile('user_race', { email: 'race@x.test' })
        const winner = uuidv7()
        const before = (await userPrincipals()).length
        kit.armOn('auth.first_sight', async () => {
          await e.insert('principals', { id: winner, kind: 'user' })
          await e.insert('users', { id: winner, email: 'race@x.test', auth_provider: 'clerk', auth_subject: 'user_race', email_verified: true })
        })
        const login = await provisionUser(kit.binding, kit.clerk.adapter, 'user_race', kit.env())
        expect(login.userId).toBe(winner)
        expect((await e.rows('users')).filter((u) => u.auth_subject === 'user_race')).toHaveLength(1)
        expect(await userPrincipals()).toHaveLength(before + 1)
        expect(kit.ran.map((r) => r.name)).toEqual(['auth.first_sight', 'auth.first_sight_recheck'])
      })

      it('the email taken by another subject between plan and commit: 409 account_conflict and no new principal (D1)', async () => {
        kit.profile('user_mine', { email: 'shared@x.test' })
        const other = uuidv7()
        const before = (await userPrincipals()).length
        kit.armOn('auth.first_sight', async () => {
          await e.insert('principals', { id: other, kind: 'user' })
          await e.insert('users', { id: other, email: 'shared@x.test', auth_provider: 'clerk', auth_subject: 'user_other', email_verified: true })
        })
        const err = await provisionUser(kit.binding, kit.clerk.adapter, 'user_mine', kit.env()).catch((x: unknown) => x)
        expect(err).toMatchObject({ status: 409, code: 'account_conflict' })
        expect(await userPrincipals()).toHaveLength(before + 1)
        expect((await e.rows('users')).filter((u) => u.auth_subject === 'user_mine')).toEqual([])
      })
    }
  })

  describe('D19: one organisation per D1', () => {
    if (name === 'd1') {
      it('a token claiming another organisation is 403 before any fetch or unit (D1)', async () => {
        const res = await kit.call('/tasks', 'user_stranger', { claim: { id: 'org_somewhere_else', rol: 'admin' } })
        expect(res.status).toBe(403)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('organization_forbidden')
        expect(kit.clerk.fetch.calls).toEqual([])
        expect(kit.ran).toEqual([])
        expect((await e.rows('users')).some((u) => u.auth_subject === 'user_stranger')).toBe(false)
      })

      it('sign-in with no claim lists local memberships only; a tenant operation is 403 organization_required (D1)', async () => {
        const me = await kit.call('/me', e.userSubject)
        expect(me.status).toBe(200)
        const body = (await me.json()) as { memberships: Array<{ organization_id: string }>; active_organization: unknown }
        expect(body.memberships.map((m) => m.organization_id)).toEqual([e.organizationId])
        expect(body.active_organization).toBeNull()
        const tasks = await kit.call('/tasks', e.userSubject)
        expect(tasks.status).toBe(403)
        expect(((await tasks.json()) as { error: { code: string } }).error.code).toBe('organization_required')
      })
    } else {
      it('Postgres admits a claim for another provider organisation (it is multi-tenant): D19 is a D1 rule', async () => {
        kit.profile('user_stranger')
        kit.clerk.organizations.set('org_elsewhere', { id: 'org_elsewhere', name: 'Elsewhere' } as never)
        const res = await kit.call('/tasks', 'user_stranger', { claim: { id: 'org_elsewhere', rol: 'admin' } })
        expect(res.status).toBe(200)
      })
    }
  })

  describe('me.get', () => {
    it('answers the user, the memberships ordered by name and the active organisation with its scopes', async () => {
      const res = await kit.call('/me', e.userSubject, { claim: { id: e.authOrgId, rol: 'admin' } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      const user = (await e.rows('users')).find((u) => u.id === e.userId)!
      expect(body.user).toEqual({ id: e.userId, email: user.email, name: null, email_verified: false })
      expect(JSON.stringify(body)).not.toMatch(/auth_(provider|subject)/)
      expect(body.memberships).toEqual([{ organization_id: e.organizationId, organization_name: (await e.rows('organizations'))[0]!.name, role: 'owner' }])
      expect(body.active_organization).toMatchObject({ id: e.organizationId, role: 'owner' })
      expect(body.active_organization.scopes.length).toBeGreaterThan(0)
      expect(kit.ran.filter((r) => r.name === 'me.get').at(-1)).toMatchObject({ identity: { kind: 'account', actorId: e.userId } })
      expect(kit.ran.filter((r) => r.name === 'me.get').at(-1)!.stats).toMatchObject({ writes: 0, locks: 0 })
    })

    if (name === 'postgres') {
      it('lists every organisation the user belongs to (Postgres)', async () => {
        const other = await e.insert('organizations', { name: 'Alpha', auth_provider: 'clerk', auth_org_id: 'org_alpha' })
        await e.insert('memberships', { organization_id: other.id, user_id: e.userId, role: 'member', created_by: e.userId })
        const body = (await (await kit.call('/me', e.userSubject, { claim: { id: e.authOrgId, rol: 'admin' } })).json()) as any
        expect(body.memberships.map((m: any) => m.organization_name)).toEqual(['Alpha', 'Engine org'])
      })
    }

    it('an agent is refused 403 user_required', async () => {
      await e.update('agents', e.agentId, { scopes: ['tasks:read'] })
      const { key } = await seedKey()
      const res = await kit.keyCall('/me', key)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('user_required')
    })
  })
})
