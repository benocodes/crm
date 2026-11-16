import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openEngines, type Engine } from '../test/engines.js'
import { openAuthKit, type AuthKit } from '../test/auth-kit.js'
import { generateApiKey } from './api-keys.js'
import {
  createApiKeyAuthenticator,
  type ApiKeyControlPort,
  type ApiKeyLookup,
  type ApiKeyState,
} from './api-key-control.js'

// [[CORE350]] groups 1 to 4 at the authenticator: a CRM database (D1, Miniflare) and an in-memory control port that counts its calls. The real control store is the server-d1 suite's.
const NOW = new Date('2026-10-22T10:00:00.000Z')
const iso = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString()
const OTHER_ORG = '0190b2c4-0000-7000-8000-0000000000ff'

interface FakeKey extends ApiKeyLookup {
  hash: string
}
class FakeControl implements ApiKeyControlPort {
  keys = new Map<string, FakeKey>()
  calls: string[] = []
  stamps: string[] = []
  async findByHash(h: string) {
    this.calls.push('find')
    const k = [...this.keys.values()].find((x) => x.hash === h)
    return k ? { ...k } : null
  }
  async readState(id: string): Promise<ApiKeyState | null> {
    this.calls.push('state')
    const k = this.keys.get(id)
    return k ? { lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, expiresAt: k.expiresAt } : null
  }
  async stampUsed(a: { id: string; now: string }) {
    this.calls.push('stamp')
    this.stamps.push(a.id)
    const k = this.keys.get(a.id)!
    k.lastUsedAt = a.now
    return true
  }
}

describe('API-key authentication reads the control plane first (CORE350)', () => {
  let e: Engine
  let kit: AuthKit
  let engines: Engine[]
  let control: FakeControl
  let n: number
  beforeAll(async () => {
    engines = await openEngines(['d1'])
    e = engines[0]!
  })
  afterAll(async () => {
    for (const x of engines) await x.close()
  })
  beforeEach(async () => {
    await e.reset()
    kit = await openAuthKit(e)
    control = new FakeControl()
    n = 0
  })
  const auth = (maxEntries?: number, port: ApiKeyControlPort | null = control) =>
    createApiKeyAuthenticator({ port, ...(maxEntries ? { maxEntries } : {}) })
  const crmKey = async (over: Record<string, unknown> = {}) => {
    const { key, hash, prefix } = await generateApiKey((k) => crypto.getRandomValues(new Uint8Array(k)))
    const row = await e.insert('api_keys', { agent_id: e.agentId, key_hash: hash, prefix, ...over })
    return { key, hash, id: row.id as string }
  }
  const ctlKey = async (over: Partial<FakeKey> = {}) => {
    const { key, hash } = await generateApiKey((k) => crypto.getRandomValues(new Uint8Array(k)))
    const id = `0190b2c4-0000-7000-8000-${String(++n + 5000).padStart(12, '0')}`
    control.keys.set(id, {
      id,
      hash,
      agentId: e.agentId,
      organizationId: e.organizationId,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      ...over,
    })
    return { key, id }
  }
  const ok = async (a: ReturnType<typeof auth>, key: string) => {
    const p = await a(kit.binding, key, kit.env())
    return p ? { agent: p.actor.id, org: p.organizationId, scopes: p.scopes.toStrings() } : null
  }

  describe('group 1: stored state x isolate', () => {
    // [name, seed, expected valid]. Each runs cold, then (where the state allows) warm: a first valid request fills the cache, the state is then put in place.
    const cases: Array<[string, () => Promise<{ key: string }>, boolean]> = [
      ['control valid', () => ctlKey(), true],
      ['control revoked', () => ctlKey({ revokedAt: iso(-10) }), false],
      ['control expiring exactly now', () => ctlKey({ expiresAt: iso(0) }), false],
      ['control expired one ms ago', () => ctlKey({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }), false],
      ['control expiring one ms ahead', () => ctlKey({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }), true],
      ['control key, agent row missing', () => ctlKey({ agentId: '0190b2c4-0000-7000-8000-0000000000aa' }), false],
      ['control key, agent of another organisation', () => ctlKey({ organizationId: OTHER_ORG }), false],
      ['CRM only valid', () => crmKey(), true],
      ['CRM only revoked', () => crmKey({ revoked_at: iso(-10) }), false],
    ]
    it.each(cases)('%s: cold and warm answer alike', async (_n, seed, valid) => {
      const { key } = await seed()
      const cold = await ok(auth(), key)
      expect(cold !== null).toBe(valid)
      const a = auth()
      const first = await ok(a, key)
      const second = await ok(a, key)
      expect([first !== null, second !== null]).toEqual([valid, valid])
      expect(second).toEqual(first)
    })

    it('a control key whose agent is disabled: 401 cold, and on a warm isolate once disabled', async () => {
      const { key } = await ctlKey()
      const a = auth()
      expect(await ok(a, key)).not.toBeNull()
      await e.update('agents', e.agentId, { disabled_at: iso(-10) })
      expect(await ok(a, key)).toBeNull()
      expect(await ok(auth(), key)).toBeNull()
    })

    it('both stores: control wins. Live in control and revoked in CRM authenticates; revoked in control and live in CRM is 401', async () => {
      const { key, hash } = await crmKey({ revoked_at: iso(-10) })
      control.keys.set('c1', {
        id: 'c1',
        hash,
        agentId: e.agentId,
        organizationId: e.organizationId,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      })
      expect(await ok(auth(), key)).not.toBeNull()
      const live = await crmKey()
      control.keys.set('c2', {
        id: 'c2',
        hash: live.hash,
        agentId: e.agentId,
        organizationId: e.organizationId,
        lastUsedAt: null,
        revokedAt: iso(-5),
        expiresAt: null,
      })
      const a = auth()
      expect(await ok(a, live.key)).toBeNull()
      expect(await ok(a, live.key)).toBeNull()
    })

    it('neither store: 401, cold and repeated', async () => {
      const a = auth()
      expect(await ok(a, 'vk_nothing-anywhere')).toBeNull()
      expect(await ok(a, 'vk_nothing-anywhere')).toBeNull()
    })

    it('no port: CRM keys exactly as today, control keys unknown', async () => {
      const c = await crmKey()
      const k = await ctlKey()
      const a = auth(undefined, null)
      expect(await ok(a, c.key)).not.toBeNull()
      expect(await ok(a, k.key)).toBeNull()
    })
  })

  describe('group 2: revocation is immediate on a warm isolate', () => {
    it.each([
      ['revoked', (id: string) => void (control.keys.get(id)!.revokedAt = iso(-1))],
      ['expired', (id: string) => void (control.keys.get(id)!.expiresAt = iso(-1))],
      ['key row deleted (the cold path answers: CRM has none)', (id: string) => void control.keys.delete(id)],
    ])('%s after warming: the next request is 401', async (_n, change) => {
      const { key, id } = await ctlKey()
      const a = auth()
      expect(await ok(a, key)).not.toBeNull()
      change(id)
      expect(await ok(a, key)).toBeNull()
    })

    it('agent disabled after warming: 401', async () => {
      const { key } = await ctlKey()
      const a = auth()
      expect(await ok(a, key)).not.toBeNull()
      await e.update('agents', e.agentId, { disabled_at: iso(-1) })
      expect(await ok(a, key)).toBeNull()
    })

    it("the agent's scopes change after warming: the next request sees the new scopes", async () => {
      await e.update('agents', e.agentId, { scopes: ['tasks:read', 'tasks:write'] })
      const { key } = await ctlKey()
      const a = auth()
      expect((await ok(a, key))!.scopes).toEqual(['tasks:read', 'tasks:write'])
      await e.update('agents', e.agentId, { scopes: ['tasks:read'] })
      expect((await ok(a, key))!.scopes).toEqual(['tasks:read'])
    })

    it('a state row deleted under a cached mapping, with a CRM row of the same hash: the cold path answers (CRM)', async () => {
      const { key, hash } = await crmKey()
      control.keys.set('c3', {
        id: 'c3',
        hash,
        agentId: e.agentId,
        organizationId: e.organizationId,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      })
      const a = auth()
      expect(await ok(a, key)).not.toBeNull()
      control.keys.delete('c3')
      expect(await ok(a, key)).not.toBeNull()
    })
  })

  describe('group 3: cache shape', () => {
    it('a warm request does no hash lookup and reads state once, with the agent read alongside', async () => {
      const { key } = await ctlKey()
      const a = auth()
      await ok(a, key)
      control.calls.length = 0
      kit.ran.length = 0
      await ok(a, key)
      expect(control.calls.filter((c) => c === 'find')).toEqual([])
      expect(control.calls.filter((c) => c === 'state')).toHaveLength(1)
      expect(kit.ran.map((r) => r.name)).toEqual(['auth.api_key_agent'])
    })

    it('the state and the agent reads are issued together (neither waits for the other)', async () => {
      const { key } = await ctlKey()
      const a = auth()
      await ok(a, key)
      const order: string[] = []
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      control.readState = async (id: string) => {
        order.push('state-start')
        await gate
        order.push('state-end')
        const k = control.keys.get(id)!
        return { lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, expiresAt: k.expiresAt }
      }
      const real = kit.binding.runtime.execute.bind(kit.binding.runtime)
      const spy = {
        ...kit.binding,
        runtime: {
          ...kit.binding.runtime,
          execute: ((...args: Parameters<typeof real>) => {
            order.push('agent-start')
            release()
            return real(...args)
          }) as typeof real,
        },
      }
      const p = await a(spy as typeof kit.binding, key, kit.env())
      expect(p).not.toBeNull()
      expect(order.slice(0, 2)).toEqual(['state-start', 'agent-start'])
    })

    it('a miss is not cached: a key inserted into control after a 401 is accepted next', async () => {
      const a = auth()
      const { key, hash } = await generateApiKey((k) => crypto.getRandomValues(new Uint8Array(k)))
      expect(await ok(a, key)).toBeNull()
      control.keys.set('late', {
        id: 'late',
        hash,
        agentId: e.agentId,
        organizationId: e.organizationId,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      })
      expect(await ok(a, key)).not.toBeNull()
    })

    it('a CRM-fallback key is not cached: every request looks the hash up again', async () => {
      const { key } = await crmKey()
      const a = auth()
      await ok(a, key)
      control.calls.length = 0
      await ok(a, key)
      expect(control.calls.filter((c) => c === 'find')).toHaveLength(1)
      expect(control.calls.filter((c) => c === 'state')).toEqual([])
    })

    it('the bound evicts: with room for one, the oldest mapping is looked up again', async () => {
      const k1 = await ctlKey()
      const k2 = await ctlKey()
      const a = auth(1)
      await ok(a, k1.key)
      await ok(a, k2.key)
      control.calls.length = 0
      await ok(a, k1.key)
      expect(control.calls).toContain('find')
      control.calls.length = 0
      await ok(a, k1.key)
      expect(control.calls).not.toContain('find')
    })

    it('two authenticators in one process share no entries', async () => {
      const { key } = await ctlKey()
      const a = auth()
      const b = auth()
      await ok(a, key)
      control.calls.length = 0
      await ok(b, key)
      expect(control.calls).toContain('find')
    })
  })

  describe('group 4: the stamp is in the holding store', () => {
    it('a control key is stamped once inside a minute and again after it; the CRM row is never touched', async () => {
      const { key, id } = await ctlKey()
      const a = auth()
      await ok(a, key)
      await ok(a, key)
      expect(control.stamps).toEqual([id])
      // 61 s later: stale again.
      const later = { ...kit.env(), now: new Date(NOW.getTime() + 61_000) }
      await a(kit.binding, key, later)
      expect(control.stamps).toEqual([id, id])
      expect(await e.rows('api_keys')).toEqual([])
    })

    it('a stamp not written for a revoked or expired control key', async () => {
      const { key } = await ctlKey({ revokedAt: iso(-1) })
      await ok(auth(), key)
      expect(control.stamps).toEqual([])
    })

    it('a failed control stamp fails the request', async () => {
      const { key } = await ctlKey()
      control.stampUsed = async () => {
        throw new Error('control down')
      }
      await expect(auth()(kit.binding, key, kit.env())).rejects.toThrow('control down')
    })

    it('a CRM-only key is stamped in CRM as today, and control is not asked to stamp', async () => {
      const { key, id } = await crmKey()
      await ok(auth(), key)
      const row = (await e.rows('api_keys')).find((r) => r.id === id)!
      expect(row.last_used_at).not.toBeNull()
      expect(control.stamps).toEqual([])
    })

    it('a key in both stores stamps control only', async () => {
      const { key, hash, id } = await crmKey()
      control.keys.set('both', {
        id: 'both',
        hash,
        agentId: e.agentId,
        organizationId: e.organizationId,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      })
      await ok(auth(), key)
      expect(control.stamps).toEqual(['both'])
      expect((await e.rows('api_keys')).find((r) => r.id === id)!.last_used_at).toBeNull()
    })
  })
})
