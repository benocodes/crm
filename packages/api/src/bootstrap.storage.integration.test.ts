import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { clearD1 } from '@vault/storage-d1/test'
import { seedDeployment } from '@vault/storage-d1/test/seed'
import { authenticateApiKey, hashApiKey } from './auth/api-keys.js'
import { bootstrap } from './bootstrap.js'
import { openAuthKit, type AuthKit } from './test/auth-kit.js'
import { openEngines, type Engine } from './test/engines.js'

// Bootstrap on both engines (CORE41 Step 2.4, C7): one internal unit, no events, the key printed once.
const NOW = new Date('2026-10-22T10:00:00.000Z')
const TABLES = ['organizations', 'principals', 'users', 'memberships', 'agents', 'api_keys', 'events'] as const

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('bootstrap on %s', (name) => {
  let e: Engine
  let kit: AuthKit
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    kit = await openAuthKit(e)
    // D1 bootstraps a deployment that has its marker and no organisation row yet (CORE41 P14).
    if (name === 'd1') {
      await clearD1(e.d1!)
      await seedDeployment(e.d1!, { organizationId: e.organizationId, externalId: e.authOrgId, organization: false })
    }
  })
  afterEach(() => vi.restoreAllMocks())

  const state = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await e.rows(t)] as const)))
  let n = 0
  const env = () => ({ now: NOW, newId: () => uuidv7(NOW), randomBytes: (k: number) => new Uint8Array(k).fill(++n) })
  const OPTS = { organizationName: 'Acme', email: 'Owner@Acme.test', userName: 'Owner', agentName: 'bot', scopes: ['tasks:read'] }

  it('creates the organisation, the user, the owner membership, the agent and the key, with no event; every stamp is now', async () => {
    const r = await bootstrap(e.binding, OPTS, env())
    const s = await state()
    expect(s.events).toEqual([])
    const org = s.organizations.find((o) => o.id === r.organizationId)!
    expect(org).toMatchObject({ name: 'Acme', created_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(s.users.find((u) => u.id === r.userId)).toMatchObject({ email: 'owner@acme.test', name: 'Owner', auth_provider: null, auth_subject: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(s.memberships.filter((m) => m.user_id === r.userId)).toMatchObject([{ organization_id: r.organizationId, role: 'owner', created_by: r.userId, created_at: NOW.toISOString(), deleted_at: null }])
    expect(s.agents.find((a) => a.id === r.agentId)).toMatchObject({ organization_id: r.organizationId, name: 'bot', scopes: ['tasks:read'], created_by: r.userId, created_at: NOW.toISOString() })
    const key = s.api_keys.find((k) => k.id === r.apiKeyId)!
    expect(key).toMatchObject({ agent_id: r.agentId, organization_id: r.organizationId, prefix: r.key.slice(0, 11), expires_at: null, last_used_at: null, revoked_at: null, created_by: r.userId, created_at: NOW.toISOString() })
    expect(key.key_hash).toBe(await hashApiKey(r.key))
    expect(JSON.stringify(s)).not.toContain(r.key)
    expect(s.principals.filter((p) => [r.userId, r.agentId].includes(p.id as string)).map((p) => p.kind).sort()).toEqual(['agent', 'user'])
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
    const principal = await authenticateApiKey(kit.binding, r.key, kit.env())
    expect(principal).toMatchObject({ actor: { id: r.agentId, kind: 'agent' }, organizationId: r.organizationId })
    expect(principal!.scopes.toStrings()).toEqual(['tasks:read'])
  })

  it('a bootstrapped linked user signs in without a profile fetch', async () => {
    await bootstrap(e.binding, { ...OPTS, authSubject: 'user_boot' }, env())
    const res = await kit.call('/me', 'user_boot')
    expect(res.status).toBe(200)
    expect(kit.clerk.fetch.calls).toEqual([])
    expect((await res.json()).user.email).toBe('owner@acme.test')
  })

  it('the plaintext key is returned once and never logged', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const r = await bootstrap(e.binding, OPTS, env())
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(r.key)
  })

  describe('refusals write nothing (a snapshot after each)', () => {
    it('an unknown scope', async () => {
      const before = await state()
      await expect(bootstrap(e.binding, { ...OPTS, scopes: ['nope:read'] }, env())).rejects.toThrow('unknown scope: nope:read')
      expect(await state()).toEqual(before)
    })
    it('a scope an agent may not hold', async () => {
      const before = await state()
      await expect(bootstrap(e.binding, { ...OPTS, scopes: ['agents:write'] }, env())).rejects.toThrow()
      expect(await state()).toEqual(before)
    })
    it('a non-ASCII email', async () => {
      const before = await state()
      await expect(bootstrap(e.binding, { ...OPTS, email: 'ñ@acme.test' }, env())).rejects.toThrow('non-ASCII email addresses are not supported')
      expect(await state()).toEqual(before)
    })
    it('a login that belongs to another user, and a user linked to another login', async () => {
      await e.insert('principals', { id: uuidv7(), kind: 'user' }).then(async (p) => {
        await e.insert('users', { id: p.id, email: 'holder@acme.test', auth_provider: 'clerk', auth_subject: 'user_taken' })
      })
      const before = await state()
      await expect(bootstrap(e.binding, { ...OPTS, authSubject: 'user_taken' }, env())).rejects.toThrow('login clerk:user_taken belongs to another user')
      expect(await state()).toEqual(before)
      await expect(bootstrap(e.binding, { ...OPTS, email: 'holder@acme.test', authSubject: 'user_other' }, env())).rejects.toThrow('user holder@acme.test is linked to another login')
      expect(await state()).toEqual(before)
    })
  })

  it('an existing unlinked user is reused and linked, with updated_at = now', async () => {
    const p = uuidv7()
    await e.insert('principals', { id: p, kind: 'user' })
    await e.insert('users', { id: p, email: 'owner@acme.test' })
    const r = await bootstrap(e.binding, { ...OPTS, authSubject: 'user_boot' }, env())
    expect(r.userId).toBe(p)
    expect((await e.rows('users')).find((u) => u.id === p)).toMatchObject({ auth_provider: 'clerk', auth_subject: 'user_boot', updated_at: NOW.toISOString(), created_at: '2026-10-22T08:00:00.000Z' })
  })

  if (name === 'd1') {
    it('an organisation row that already exists is refused and nothing is written (D1)', async () => {
      await bootstrap(e.binding, OPTS, env())
      const before = await state()
      await expect(bootstrap(e.binding, { ...OPTS, email: 'second@acme.test' }, env())).rejects.toThrow(`organization ${e.organizationId} is already initialised`)
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
