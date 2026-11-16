import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { openEngines, type Engine, type EngineName } from '../test/engines.js'
import { openAuthKit, type AuthKit } from '../test/auth-kit.js'
import { AuthFailure } from './adapter.js'
import { lookupUser, provisionUser } from './first-sight.js'

// Authentication on both engines (CORE41 Step 2.2): the user lookup, first sight, D19 admission and
// `me.get`, run through the real binding with the same assertions on Postgres and D1.
const NOW = new Date('2026-10-22T10:00:00.000Z')

/** The suite body: one instance per engine entry file (`*.d1.test.ts`, `*.postgres.test.ts`). */
export function engineSuite(engineName: EngineName): void {
  let engines: Engine[]
  beforeAll(async () => {
    engines = await openEngines([engineName])
  })
  afterAll(async () => {
    for (const e of engines) await e.close()
  })

  describe.each([engineName])('authentication on %s', (name) => {
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
      events: await e.rows('events'),
    })
    const row = async (table: string, id: string) => (await e.rows(table)).find((r) => r.id === id)!
    const userPrincipals = async () => (await e.rows('principals')).filter((p) => p.kind === 'user')

    const unitsNamed = (n: string) => kit.ran.filter((r) => r.name === n)

    describe('lookup and first sight', () => {
      it('a known subject is a read-only unit that finds the latest membership of the linked organisation', async () => {
        const login = await lookupUser(kit.binding, {
          provider: 'clerk',
          subject: e.userSubject,
          organizationExternalId: e.authOrgId,
        })
        expect(login).toMatchObject({
          userId: e.userId,
          linkedOrganizationId: e.organizationId,
          latestMembership: { role: 'owner', deletedAt: null },
        })
        expect(login!.latestMembership!.updatedAt).toBeInstanceOf(Date)
        expect(kit.ran.at(-1)!.stats).toMatchObject({ writes: 0, locks: 0 })
      })

      it('an unknown subject is null; a known one without a claim has no organisation', async () => {
        expect(
          await lookupUser(kit.binding, { provider: 'clerk', subject: 'nobody', organizationExternalId: null }),
        ).toBeNull()
        expect(
          await lookupUser(kit.binding, { provider: 'clerk', subject: e.userSubject, organizationExternalId: null }),
        ).toEqual({
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
        expect(err).toMatchObject({
          status: 400,
          code: 'invalid_identity',
          message: 'non-ASCII email addresses are not supported',
        })
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
            await e.insert('users', {
              id: winner,
              email: 'race@x.test',
              auth_provider: 'clerk',
              auth_subject: 'user_race',
              email_verified: true,
            })
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
            await e.insert('users', {
              id: other,
              email: 'shared@x.test',
              auth_provider: 'clerk',
              auth_subject: 'user_other',
              email_verified: true,
            })
          })
          const err = await provisionUser(kit.binding, kit.clerk.adapter, 'user_mine', kit.env()).catch(
            (x: unknown) => x,
          )
          expect(err).toMatchObject({ status: 409, code: 'account_conflict' })
          expect(await userPrincipals()).toHaveLength(before + 1)
          expect((await e.rows('users')).filter((u) => u.auth_subject === 'user_mine')).toEqual([])
        })
      }
    })

    describe('D19: one organisation per D1', () => {
      if (name === 'd1') {
        it('a token claiming another organisation is 403 before any fetch or unit (D1)', async () => {
          const res = await kit.call('/api/v1/tasks', 'user_stranger', {
            claim: { id: 'org_somewhere_else', rol: 'admin' },
          })
          expect(res.status).toBe(403)
          expect(((await res.json()) as { error: { code: string } }).error.code).toBe('organization_forbidden')
          expect(kit.clerk.fetch.calls).toEqual([])
          expect(kit.ran).toEqual([])
          expect((await e.rows('users')).some((u) => u.auth_subject === 'user_stranger')).toBe(false)
        })

        it('sign-in with no claim lists local memberships only; a tenant operation is 403 organization_required (D1)', async () => {
          const me = await kit.call('/meta/v1/me', e.userSubject)
          expect(me.status).toBe(200)
          const body = (await me.json()) as {
            memberships: Array<{ organization_id: string }>
            active_organization: unknown
          }
          expect(body.memberships.map((m) => m.organization_id)).toEqual([e.organizationId])
          expect(body.active_organization).toBeNull()
          const tasks = await kit.call('/api/v1/tasks', e.userSubject)
          expect(tasks.status).toBe(403)
          expect(((await tasks.json()) as { error: { code: string } }).error.code).toBe('organization_required')
        })
      } else {
        it('Postgres admits a claim for another provider organisation (it is multi-tenant): D19 is a D1 rule', async () => {
          kit.profile('user_stranger')
          kit.clerk.organizations.set('org_elsewhere', { id: 'org_elsewhere', name: 'Elsewhere' } as never)
          const res = await kit.call('/api/v1/tasks', 'user_stranger', { claim: { id: 'org_elsewhere', rol: 'admin' } })
          expect(res.status).toBe(200)
        })
      }
    })

    describe('me.get', () => {
      it('answers the user, the memberships ordered by name and the active organisation with its scopes', async () => {
        const res = await kit.call('/meta/v1/me', e.userSubject, { claim: { id: e.authOrgId, rol: 'admin' } })
        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        const user = (await e.rows('users')).find((u) => u.id === e.userId)!
        expect(body.user).toEqual({ id: e.userId, email: user.email, name: null, email_verified: false })
        expect(JSON.stringify(body)).not.toMatch(/auth_(provider|subject)/)
        expect(body.memberships).toEqual([
          {
            organization_id: e.organizationId,
            organization_name: (await e.rows('organizations'))[0]!.name,
            role: 'owner',
          },
        ])
        expect(body.active_organization).toMatchObject({ id: e.organizationId, role: 'owner' })
        expect(body.active_organization.scopes.length).toBeGreaterThan(0)
        expect(kit.ran.filter((r) => r.name === 'me.get').at(-1)).toMatchObject({
          identity: { kind: 'account', actorId: e.userId },
        })
        expect(kit.ran.filter((r) => r.name === 'me.get').at(-1)!.stats).toMatchObject({ writes: 0, locks: 0 })
      })

      if (name === 'postgres') {
        it('lists every organisation the user belongs to (Postgres)', async () => {
          const other = await e.insert('organizations', {
            name: 'Alpha',
            auth_provider: 'clerk',
            auth_org_id: 'org_alpha',
          })
          await e.insert('memberships', {
            organization_id: other.id,
            user_id: e.userId,
            role: 'member',
            created_by: e.userId,
          })
          const body = (await (
            await kit.call('/meta/v1/me', e.userSubject, { claim: { id: e.authOrgId, rol: 'admin' } })
          ).json()) as any
          expect(body.memberships.map((m: any) => m.organization_name)).toEqual(['Alpha', 'Engine org'])
        })
      }
    })
  })
}
