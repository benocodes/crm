import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { apiKeyStore, openControlDb, type D1Like } from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment } from '@vibase/storage-d1/test/seed'
import { hashApiKey } from './auth/api-keys.js'
import { createApiKeyAuthenticator } from './auth/api-key-control.js'
import { bootstrap } from './bootstrap.js'
import { openAuthKit, type AuthKit } from './test/auth-kit.js'
import { openEngines, type Engine, type EngineName } from './test/engines.js'

// Bootstrap on both engines (CORE41 Step 2.4, C7): one internal unit, no events, the key printed once.
const NOW = new Date('2026-10-22T10:00:00.000Z')
const TABLES = ['organizations', 'principals', 'users', 'memberships', 'agents', 'events'] as const

/** The suite body: one instance per engine entry file (`*.d1.test.ts`, `*.postgres.test.ts`). */
export function engineSuite(engineName: EngineName): void {
  let engines: Engine[]
  // [[CORE356]], [[CORE329]] P3: on every engine the key is minted on the control plane, a local D1 control database here (a Postgres bootstrap would reach the same store through its own composition when un-parked, [[CORE259]] D17).
  let local: LocalD1
  let control: D1Like
  let store: ReturnType<typeof apiKeyStore>
  beforeAll(async () => {
    engines = await openEngines([engineName])
    local = await openLocalD1(['control'], { control: ['control'] })
    control = local.bindings.control!
    store = apiKeyStore(openControlDb(control))
  })
  afterAll(async () => {
    for (const e of engines) await e.close()
    await local.dispose()
  })

  describe.each([engineName])('bootstrap on %s', (name) => {
    let e: Engine
    let kit: AuthKit
    beforeAll(() => {
      e = engines.find((x) => x.name === name)!
    })
    beforeEach(async () => {
      await e.reset()
      await clearD1(control)
      kit = await openAuthKit(e)
      // D1 bootstraps a deployment that has its marker and no organisation row yet (CORE41 P14).
      if (name === 'd1') {
        await clearD1(e.d1!)
        await seedDeployment(e.d1!, { organizationId: e.organizationId, externalId: e.authOrgId, organization: false })
      }
    })
    afterEach(() => vi.restoreAllMocks())

    const ctl = async (table: string) =>
      ((await control.prepare(`select * from ${table}`).all()).results ?? []) as Array<Record<string, any>>
    const state = async () => ({
      ...(Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await e.rows(t)] as const))) as Record<
        (typeof TABLES)[number],
        Array<Record<string, any>>
      >),
      ctl_api_keys: await ctl('api_keys'),
      ctl_audit: await ctl('control_audit'),
    })
    let n = 0
    const env = (keyStore: { create: typeof store.create } | null | undefined = store) => ({
      now: NOW,
      newId: () => uuidv7(NOW),
      randomBytes: (k: number) => new Uint8Array(k).fill(++n),
      ...(keyStore ? { keyStore } : {}),
    })
    const OPTS = {
      organizationName: 'Acme',
      email: 'Owner@Acme.test',
      userName: 'Owner',
      agentName: 'bot',
      scopes: ['tasks:read'],
    }

    it('creates the organisation, the user, the owner membership, the agent and the key, with no event; every stamp is now', async () => {
      const r = await bootstrap(e.binding, OPTS, env())
      const s = await state()
      expect(s.events).toEqual([])
      const org = s.organizations.find((o) => o.id === r.organizationId)!
      expect(org).toMatchObject({ name: 'Acme', created_at: NOW.toISOString(), updated_at: NOW.toISOString() })
      expect(s.users.find((u) => u.id === r.userId)).toMatchObject({
        email: 'owner@acme.test',
        name: 'Owner',
        auth_provider: null,
        auth_subject: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
      expect(s.memberships.filter((m) => m.user_id === r.userId)).toMatchObject([
        {
          organization_id: r.organizationId,
          role: 'owner',
          created_by: r.userId,
          created_at: NOW.toISOString(),
          deleted_at: null,
        },
      ])
      expect(s.agents.find((a) => a.id === r.agentId)).toMatchObject({
        organization_id: r.organizationId,
        name: 'bot',
        scopes: ['tasks:read'],
        created_by: r.userId,
        created_at: NOW.toISOString(),
      })
      // The key and its audit row are on the control plane; the CRM has no api_keys table.
      const key = s.ctl_api_keys.find((k) => k.id === r.apiKeyId)!
      expect(s.ctl_audit).toMatchObject([
        { action: 'api_key.created', actor_id: r.userId, target_type: 'api_key', target_id: r.apiKeyId },
      ])
      expect(s.ctl_audit).toHaveLength(1)
      expect(key).toMatchObject({
        agent_id: r.agentId,
        organization_id: r.organizationId,
        prefix: r.key.slice(0, 11),
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
        created_by: r.userId,
        created_at: NOW.toISOString(),
      })
      expect(key.key_hash).toBe(await hashApiKey(r.key))
      expect(JSON.stringify(s)).not.toContain(r.key)
      expect(JSON.stringify(s.ctl_audit)).not.toContain(key.key_hash as string)
      expect(
        s.principals
          .filter((p) => [r.userId, r.agentId].includes(p.id as string))
          .map((p) => p.kind)
          .sort(),
      ).toEqual(['agent', 'user'])
    })

    it('the id of the organisation and its link: Postgres mints one and leaves it unlinked, D1 uses the deployment link', async () => {
      const r = await bootstrap(e.binding, OPTS, env())
      const org = (await e.rows('organizations')).find((o) => o.id === r.organizationId)!
      if (name === 'd1') {
        expect(r.organizationId).toBe(e.organizationId)
        expect(org).toMatchObject({ auth_provider: e.authProvider, auth_org_id: e.authOrgId })
      } else {
        expect(org).toMatchObject({ auth_provider: null, auth_org_id: null })
      }
    })

    it('the bootstrapped key authenticates as the agent', async () => {
      const r = await bootstrap(e.binding, OPTS, env())
      const principal = await createApiKeyAuthenticator({ port: store })(kit.binding, r.key, kit.env())
      expect(principal).toMatchObject({ actor: { id: r.agentId, kind: 'agent' }, organizationId: r.organizationId })
      expect(principal!.scopes.toStrings()).toEqual(['tasks:read'])
    })

    it('a bootstrapped linked user signs in without a profile fetch', async () => {
      await bootstrap(e.binding, { ...OPTS, authSubject: 'user_boot' }, env())
      const res = await kit.call('/meta/v1/me', 'user_boot')
      expect(res.status).toBe(200)
      expect(kit.clerk.fetch.calls).toEqual([])
      expect((await res.json()).user.email).toBe('owner@acme.test')
    })

    it('the plaintext key is returned once and never logged', async () => {
      const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      )
      const r = await bootstrap(e.binding, OPTS, env())
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(r.key)
    })

    describe('refusals write nothing (a snapshot after each)', () => {
      it('an unknown scope', async () => {
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, scopes: ['nope:read'] }, env())).rejects.toThrow(
          'unknown scope: nope:read',
        )
        expect(await state()).toEqual(before)
      })
      it('the metadata scope that nothing declares yet ([[API518]]: valid grammar, undeclared, refused as any undeclared scope)', async () => {
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, scopes: ['messages:read_metadata'] }, env())).rejects.toThrow(
          'unknown scope: messages:read_metadata',
        )
        expect(await state()).toEqual(before)
      })
      it('a scope an agent may not hold', async () => {
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, scopes: ['agents:write'] }, env())).rejects.toThrow()
        expect(await state()).toEqual(before)
      })
      it('a non-ASCII email', async () => {
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, email: 'ñ@acme.test' }, env())).rejects.toThrow(
          'non-ASCII email addresses are not supported',
        )
        expect(await state()).toEqual(before)
      })
      it('a login that belongs to another user, and a user linked to another login', async () => {
        await e.insert('principals', { id: uuidv7(), kind: 'user' }).then(async (p) => {
          await e.insert('users', {
            id: p.id,
            email: 'holder@acme.test',
            auth_provider: 'clerk',
            auth_subject: 'user_taken',
          })
        })
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, authSubject: 'user_taken' }, env())).rejects.toThrow(
          'login clerk:user_taken belongs to another user',
        )
        expect(await state()).toEqual(before)
        await expect(
          bootstrap(e.binding, { ...OPTS, email: 'holder@acme.test', authSubject: 'user_other' }, env()),
        ).rejects.toThrow('user holder@acme.test is linked to another login')
        expect(await state()).toEqual(before)
      })
    })

    it('an existing unlinked user is reused and linked, with updated_at = now', async () => {
      const p = uuidv7()
      await e.insert('principals', { id: p, kind: 'user' })
      await e.insert('users', { id: p, email: 'owner@acme.test' })
      const r = await bootstrap(e.binding, { ...OPTS, authSubject: 'user_boot' }, env())
      expect(r.userId).toBe(p)
      expect((await e.rows('users')).find((u) => u.id === p)).toMatchObject({
        auth_provider: 'clerk',
        auth_subject: 'user_boot',
        updated_at: NOW.toISOString(),
        created_at: '2026-10-22T08:00:00.000Z',
      })
    })

    it('no control key store is refused before either store is written (every engine, CORE356 P3, CORE329 P3)', async () => {
      const before = await state()
      await expect(bootstrap(e.binding, OPTS, env(null))).rejects.toThrow(/control/i)
      expect(await state()).toEqual(before)
    })

    if (name === 'd1') {
      it.each([
        ['throws', async () => Promise.reject(new Error('control is down'))],
        ['answers duplicate', async () => 'duplicate' as const],
      ])(
        'a control insert that %s after the CRM commit fails with the recovery message (D1, CORE356 P2 b)',
        async (_n, create) => {
          await expect(bootstrap(e.binding, OPTS, env({ create }))).rejects.toThrow(
            new RegExp(`${e.organizationId}.*no key.*api_keys\\.create`, 's'),
          )
          const s = await state()
          // The CRM unit committed (the organisation and the agent exist), the control plane holds nothing.
          expect(s.organizations).toHaveLength(1)
          expect(s.agents).toHaveLength(1)
          expect(s.ctl_api_keys).toEqual([])
          expect(s.ctl_audit).toEqual([])
          // A re-run is refused as today and writes nothing to control.
          await expect(bootstrap(e.binding, { ...OPTS, email: 'second@acme.test' }, env())).rejects.toThrow(
            `organization ${e.organizationId} is already initialised`,
          )
          expect((await state()).ctl_api_keys).toEqual([])
        },
      )
      it('an organisation row that already exists is refused and nothing is written (D1)', async () => {
        await bootstrap(e.binding, OPTS, env())
        const before = await state()
        await expect(bootstrap(e.binding, { ...OPTS, email: 'second@acme.test' }, env())).rejects.toThrow(
          `organization ${e.organizationId} is already initialised`,
        )
        expect(await state()).toEqual(before)
      })
    } else {
      it('each run creates one more organisation (Postgres)', async () => {
        const a = await bootstrap(e.binding, OPTS, env())
        const b = await bootstrap(e.binding, { ...OPTS, organizationName: 'Beta', agentName: 'bot2' }, env())
        expect(a.organizationId).not.toBe(b.organizationId)
        expect(a.userId).toBe(b.userId)
      })
    }
  })
}
