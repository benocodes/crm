import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { StatementFailed, type ExecutionResult, type PreparedOperation, type StatementLabel } from '@vault/storage'
import { withFault } from '@vault/storage/test'
import { seedAgent, seedOrganization, seedUser } from '@vault/db/test'
import { hashApiKey } from '../auth/api-keys.js'
import { ApiError, mapStorageError } from '../errors.js'
import { createVaultRegistry } from '../operations.js'
import type { PreparedTenantOperation } from '../registry.js'
import { seedApiKey } from '../test/keys.js'
import { seedPrincipal } from '@vault/storage-d1/test/seed'
import { openEngines, type Engine } from '../test/engines.js'
import { BASE } from '../test/identity-kit.js'

// Administration on both engines (CORE40 Step 2.4): agents, memberships, api keys and users through the real
// registry operations (async prepare included), against Postgres and D1 with the same assertions.
const registry = createVaultRegistry()
const at = (n: number) => new Date(BASE + n * 60_000)
const iso = (n: number) => at(n).toISOString()
const TABLES = ['principals', 'agents', 'api_keys', 'events'] as const
const snapshot = async (e: Engine) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await e.rows(t)] as const)))
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'

type Call = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }
type Opts = { now?: Date; as?: 'agent' | 'user' }

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('administration storage behaviour on %s', (name) => {
  let e: Engine
  let tick = 0
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
    tick = 100
  })

  /** One registry operation exactly as the REST adapter runs it: async prepare, then execute, storage errors mapped. */
  const prepareOp = async (op: string, call: Call, opts: Opts = {}): Promise<PreparedOperation<unknown>> => {
    const operation = registry.get(op) as PreparedTenantOperation
    return operation.prepare(e.env({ now: opts.now ?? at(++tick), ...(opts.as ? { as: opts.as } : {}) }), { params: {}, query: {}, body: undefined, ...call })
  }
  const run = async (op: string, call: Call = {}, opts: Opts = {}): Promise<ExecutionResult<any>> => {
    try {
      return await e.run(await prepareOp(op, call, opts), opts.as)
    } catch (err) {
      throw mapStorageError(err)
    }
  }
  const call = async (op: string, c: Call = {}, opts: Opts = {}): Promise<any> => (await run(op, c, opts)).value
  const fail = async (op: string, c: Call = {}, opts: Opts = {}): Promise<readonly [number, string, string]> => {
    const err = await run(op, c, opts).then(() => undefined, (x: unknown) => x)
    expect(err, `expected ${op} to fail`).toBeInstanceOf(ApiError)
    const a = err as ApiError
    return [a.status, a.code, a.message]
  }
  const events = async (prefix?: string) => (await e.rows('events')).filter((x) => (prefix ? String(x.type).startsWith(prefix) : true))
  const newAgent = (body: Record<string, unknown> = {}, opts?: Opts) => call('agents.create', { body: { name: 'bot', scopes: ['tasks:read'], ...body } }, opts)
  const newKey = (agentId: string, opts?: Opts, extra: Record<string, unknown> = {}) => call('api_keys.create', { body: { agent_id: agentId, ...extra } }, opts)
  const row = async (table: 'agents' | 'api_keys' | 'memberships' | 'principals', id: string) => {
    const r = (await e.rows(table)).find((x) => x.id === id)
    expect(r, `${table} row ${id}`).toBeDefined()
    return r!
  }

  describe('agents', () => {
    it('create stores the principal and the agent row with one id, normalised scopes, one event, stamps = now', async () => {
      const principalsBefore = (await e.rows('principals')).length
      const a = await newAgent({ name: '  Bot  ', scopes: ['tasks:write', 'tasks:read', 'tasks:write'] }, { now: at(1) })
      expect(a).toEqual({
        id: a.id,
        organization_id: e.organizationId,
        name: 'Bot',
        scopes: ['tasks:read', 'tasks:write'],
        disabled_at: null,
        created_by: e.userId,
        created_at: iso(1),
        updated_at: iso(1),
      })
      expect(await row('principals', a.id)).toMatchObject({ kind: 'agent', created_at: iso(1) })
      expect((await e.rows('principals')).length).toBe(principalsBefore + 1)
      expect(await row('agents', a.id)).toMatchObject({ name: 'Bot', scopes: ['tasks:read', 'tasks:write'], disabled_at: null, created_by: e.userId, created_at: iso(1), updated_at: iso(1) })
      const ev = await events('agent.')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ type: 'agent.created', resource_type: 'agent', resource_id: a.id, actor_id: e.userId, organization_id: e.organizationId, created_at: iso(1), before: null, after: a })
    })

    it('create with no scopes stores an empty list', async () => {
      const a = await call('agents.create', { body: { name: 'empty' } })
      expect(a.scopes).toEqual([])
      expect((await row('agents', a.id)).scopes).toEqual([])
    })

    it.each([
      ['an unknown scope', { name: 'x', scopes: ['tasks:read', 'zz:read'] }, [400, 'unknown_scope', 'unknown scope: zz:read']],
      ['a human-only scope', { name: 'x', scopes: ['members:read'] }, [400, 'scope_not_grantable', 'scope not grantable to an agent: members:read']],
    ] as const)('create refuses %s and writes nothing', async (_n, body, expected) => {
      const before = await snapshot(e)
      expect(await fail('agents.create', { body })).toEqual(expected)
      expect(await snapshot(e)).toEqual(before)
    })

    it('create refuses a blank name and writes nothing', async () => {
      const before = await snapshot(e)
      const [status, code] = await fail('agents.create', { body: { name: '   ' } })
      expect([status, code]).toEqual([400, 'validation_error'])
      expect(await snapshot(e)).toEqual(before)
    })

    it('update renames, changes scopes at once, stamps updated_at and emits one event each', async () => {
      const a = await newAgent({}, { now: at(1) })
      const renamed = await call('agents.update', { params: { id: a.id }, body: { name: 'renamed' } }, { now: at(2) })
      expect(renamed).toMatchObject({ name: 'renamed', created_at: iso(1), updated_at: iso(2), scopes: ['tasks:read'] })
      const scoped = await call('agents.update', { params: { id: a.id }, body: { scopes: ['tasks:write', 'tasks:read'] } }, { now: at(3) })
      expect(scoped).toMatchObject({ scopes: ['tasks:read', 'tasks:write'], updated_at: iso(3) })
      expect(await row('agents', a.id)).toMatchObject({ name: 'renamed', scopes: ['tasks:read', 'tasks:write'], updated_at: iso(3) })
      const ev = (await events('agent.updated')).map((x) => [x.created_at, x.before.name, x.after.name])
      expect(ev).toEqual([
        [iso(2), 'bot', 'renamed'],
        [iso(3), 'renamed', 'renamed'],
      ])
      expect((await events('agent.updated'))[1]!.after).toEqual(scoped)
    })

    it('update refuses a bad scope with nothing written', async () => {
      const a = await newAgent()
      const before = await snapshot(e)
      expect(await fail('agents.update', { params: { id: a.id }, body: { scopes: ['agents:write'] } })).toEqual([400, 'scope_not_grantable', 'scope not grantable to an agent: agents:write'])
      expect(await snapshot(e)).toEqual(before)
    })

    it('disable stamps disabled_at once, a second disable keeps the first, enable clears it', async () => {
      const a = await newAgent({}, { now: at(1) })
      const off = await call('agents.update', { params: { id: a.id }, body: { disabled: true } }, { now: at(2) })
      expect(off).toMatchObject({ disabled_at: iso(2), updated_at: iso(2) })
      const again = await call('agents.update', { params: { id: a.id }, body: { disabled: true } }, { now: at(3) })
      expect(again).toMatchObject({ disabled_at: iso(2), updated_at: iso(3) })
      const on = await call('agents.update', { params: { id: a.id }, body: { disabled: false } }, { now: at(4) })
      expect(on).toMatchObject({ disabled_at: null, updated_at: iso(4) })
      const stored = await row('agents', a.id)
      expect(stored).toMatchObject({ disabled_at: null, updated_at: iso(4) })
      expect(Object.keys(stored)).not.toContain('disabled')
      expect((await events('agent.updated')).map((x) => x.after.disabled_at)).toEqual([iso(2), iso(2), null])
    })

    it('an empty patch is a no-op with no event; a same-value patch is a real update with one', async () => {
      const a = await newAgent({}, { now: at(1) })
      const noop = await run('agents.update', { params: { id: a.id }, body: {} }, { now: at(2) })
      expect(noop.value).toMatchObject({ id: a.id, updated_at: iso(1) })
      expect(noop.events).toEqual([])
      expect(await events('agent.updated')).toHaveLength(0)
      const same = await call('agents.update', { params: { id: a.id }, body: { name: 'bot' } }, { now: at(3) })
      expect(same).toMatchObject({ name: 'bot', updated_at: iso(3) })
      expect(await events('agent.updated')).toHaveLength(1)
    })

    it('an unknown or foreign-shaped id is a 404', async () => {
      expect(await fail('agents.update', { params: { id: UNKNOWN }, body: { name: 'x' } })).toEqual([404, 'not_found', 'agent not found'])
      expect(await fail('agents.get', { params: { id: 'nope' } })).toEqual([404, 'not_found', 'agent not found'])
    })

    it('has no delete operation', () => {
      expect(registry.get('agents.delete')).toBeUndefined()
      expect(registry.get('api_keys.delete')).toBeUndefined()
    })

    it('list and get read the organisation\'s agents', async () => {
      const a = await newAgent()
      const list = await call('agents.list', { query: {} })
      expect(list.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([a.id, e.agentId]))
      expect(list.data.find((x: any) => x.id === a.id)).toEqual(a)
      expect(await call('agents.get', { params: { id: a.id } })).toEqual(a)
    })
  })

  describe('api keys', () => {
    it('issue returns the record and the plaintext once; the hash is stored; one event without either secret', async () => {
      const a = await newAgent()
      const k = await newKey(a.id, { now: at(5) }, { expires_at: '2027-01-01T00:00:00.000Z' })
      expect(k.key).toMatch(/^vk_/)
      expect(k.prefix).toBe(k.key.slice(0, 11))
      const { key, ...record } = k
      expect(record).toEqual({
        id: k.id,
        organization_id: e.organizationId,
        agent_id: a.id,
        prefix: key.slice(0, 11),
        last_used_at: null,
        revoked_at: null,
        expires_at: '2027-01-01T00:00:00.000Z',
        created_by: e.userId,
        created_at: iso(5),
        updated_at: iso(5),
      })
      expect(await row('api_keys', k.id)).toMatchObject({ key_hash: await hashApiKey(key), created_at: iso(5), updated_at: iso(5) })
      const ev = await events('api_key.')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ type: 'api_key.created', resource_id: k.id, actor_id: e.userId, created_at: iso(5), before: null, after: record })
      expect(JSON.stringify(ev)).not.toContain(key)
      expect(JSON.stringify(ev)).not.toContain('key_hash')
    })

    it('two keys differ, and each key authenticates to its own stored hash', async () => {
      const a = await newAgent()
      const k1 = await newKey(a.id)
      const k2 = await newKey(a.id)
      expect(k1.key).not.toBe(k2.key)
      const hashes = (await e.rows('api_keys')).map((r) => r.key_hash)
      expect(hashes).toEqual(expect.arrayContaining([await hashApiKey(k1.key), await hashApiKey(k2.key)]))
    })

    it('refuses an unknown agent, a past expiry and an expiry equal to now, writing nothing', async () => {
      const before = await snapshot(e)
      expect(await fail('api_keys.create', { body: { agent_id: UNKNOWN } })).toEqual([400, 'invalid_reference', 'a referenced record does not exist'])
      expect(await snapshot(e)).toEqual(before)
      const now = at(9)
      const a = await newAgent()
      const mid = await snapshot(e)
      expect(await fail('api_keys.create', { body: { agent_id: a.id, expires_at: iso(8) } }, { now })).toEqual([400, 'validation_error', 'expires_at must be in the future'])
      expect(await fail('api_keys.create', { body: { agent_id: a.id, expires_at: iso(9) } }, { now })).toEqual([400, 'validation_error', 'expires_at must be in the future'])
      expect(await snapshot(e)).toEqual(mid)
    })

    if (name === 'postgres') {
      it('refuses another organisation\'s agent: invalid_reference, no row, no event', async () => {
        const org = await seedOrganization(e.app!, { name: 'Foreign' })
        const owner = await seedUser(e.app!, { organizationId: org.id, role: 'owner' })
        const foreign = await seedAgent(e.app!, { organizationId: org.id, createdBy: owner.id })
        const before = await snapshot(e)
        expect(await fail('api_keys.create', { body: { agent_id: foreign.id } })).toEqual([400, 'invalid_reference', 'a referenced record does not exist'])
        expect(await snapshot(e)).toEqual(before)
      })
    }

    it('issues a key for a disabled agent (the rule of CORE27)', async () => {
      const a = await newAgent()
      await call('agents.update', { params: { id: a.id }, body: { disabled: true } })
      const k = await newKey(a.id)
      expect(k.agent_id).toBe(a.id)
    })

    it('revoke stamps revoked_at and updated_at with now, emits one event; a second revoke is unchanged with no event', async () => {
      const a = await newAgent()
      const k = await newKey(a.id, { now: at(1) })
      const revoked = await call('api_keys.revoke', { params: { id: k.id } }, { now: at(2) })
      expect(revoked).toMatchObject({ id: k.id, revoked_at: iso(2), updated_at: iso(2), created_at: iso(1) })
      expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: iso(2), updated_at: iso(2) })
      const ev = await events('api_key.revoked')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ resource_id: k.id, actor_id: e.userId, created_at: iso(2), after: revoked })
      expect(ev[0]!.before).toMatchObject({ revoked_at: null, updated_at: iso(1) })
      const again = await run('api_keys.revoke', { params: { id: k.id } }, { now: at(3) })
      expect(again.value).toEqual(revoked)
      expect(again.events).toEqual([])
      expect(await events('api_key.revoked')).toHaveLength(1)
      expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: iso(2), updated_at: iso(2) })
    })

    it('revoke of an unknown id and of an id that is not a UUID is 404', async () => {
      expect(await fail('api_keys.revoke', { params: { id: UNKNOWN } })).toEqual([404, 'not_found', 'api_key not found'])
      expect(await fail('api_keys.revoke', { params: { id: 'nope' } })).toEqual([404, 'not_found', 'api_key not found'])
    })

    if (name === 'postgres') {
      it('revoke of another organisation\'s key is 404 and changes nothing', async () => {
        const org = await seedOrganization(e.app!, { name: 'Foreign' })
        const owner = await seedUser(e.app!, { organizationId: org.id, role: 'owner' })
        const foreign = await seedAgent(e.app!, { organizationId: org.id, createdBy: owner.id })
        const key = await seedApiKey(e.app!, { organizationId: org.id, agentId: foreign.id, createdBy: owner.id })
        const before = await snapshot(e)
        expect(await fail('api_keys.revoke', { params: { id: key.id } })).toEqual([404, 'not_found', 'api_key not found'])
        expect(await snapshot(e)).toEqual(before)
      })
    }

    it('list and get return records without key_hash or the plaintext, and filter by agent', async () => {
      const a = await newAgent()
      const b = await newAgent({ name: 'other' })
      const k = await newKey(a.id)
      await newKey(b.id)
      const list = await call('api_keys.list', { query: { agent_id: a.id } })
      expect(list.data.map((x: any) => x.id)).toEqual([k.id])
      const got = await call('api_keys.get', { params: { id: k.id } })
      const { key, ...record } = k
      expect(got).toEqual(record)
      expect(JSON.stringify([list, got])).not.toContain('key_hash')
      expect(JSON.stringify([list, got])).not.toContain(key)
    })

    it('secrets: neither the hash nor the plaintext appears in any response or event but the one create response', async () => {
      const a = await newAgent()
      const k = await newKey(a.id)
      const hash = await hashApiKey(k.key)
      const seen = [
        await call('api_keys.list', { query: {} }),
        await call('api_keys.get', { params: { id: k.id } }),
        await call('api_keys.revoke', { params: { id: k.id } }),
        await call('api_keys.revoke', { params: { id: k.id } }),
        await call('agents.get', { params: { id: a.id } }),
        await e.rows('events'),
      ]
      const text = JSON.stringify(seen)
      expect(text).not.toContain(k.key)
      expect(text).not.toContain(hash)
      expect(text).not.toContain('key_hash')
      for (const ev of await e.rows('events')) expect(Object.keys((ev.after ?? {}) as object)).not.toContain('key_hash')
    })
  })

  describe('memberships', () => {
    it('list returns the owner and the member; filters by role and user; a removed membership is neither listed nor found', async () => {
      const all = await call('memberships.list', { query: {} })
      expect(all.data.map((m: any) => [m.user_id, m.role]).sort()).toEqual(
        [
          [e.userId, 'owner'],
          [e.user2Id, 'member'],
        ].sort(),
      )
      expect((await call('memberships.list', { query: { role: 'owner' } })).data.map((m: any) => m.user_id)).toEqual([e.userId])
      expect((await call('memberships.list', { query: { user_id: e.user2Id } })).data.map((m: any) => m.user_id)).toEqual([e.user2Id])
      const extra = await e.seedMember('member')
      expect((await call('memberships.get', { params: { id: extra.membershipId } })).user_id).toBe(extra.userId)
      await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
      expect((await call('memberships.list', { query: {} })).data.map((m: any) => m.id)).not.toContain(extra.membershipId)
      expect(await fail('memberships.get', { params: { id: extra.membershipId } })).toEqual([404, 'not_found', 'membership not found'])
    })

    it('has no write operations', () => {
      for (const op of ['create', 'update', 'delete']) expect(registry.get(`memberships.${op}`)).toBeUndefined()
    })
  })

  describe('users', () => {
    it('list returns live members only, keyset by id: each user once and then a null cursor', async () => {
      const extra = await e.seedMember('member')
      const expected = [e.userId, e.user2Id, extra.userId].sort()
      const seen: string[] = []
      let after: string | undefined
      for (let i = 0; i < 10; i++) {
        const page = await call('users.list', { query: { limit: 1, ...(after ? { after } : {}) } })
        expect(page.data).toHaveLength(1)
        seen.push(page.data[0].id)
        if (page.next_cursor === null) break
        after = page.next_cursor
      }
      expect(seen).toEqual(expected)
      const all = await call('users.list', { query: {} })
      expect(all.next_cursor).toBeNull()
      expect(all.data.map((u: any) => u.id)).toEqual(expected)
      expect(Object.keys(all.data[0]).sort()).toEqual(['created_at', 'email', 'id', 'name', 'updated_at'])
      await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
      expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).toEqual([e.userId, e.user2Id].sort())
    })

    it('get finds a live member and a removed member, and 404s a user with no membership here', async () => {
      const extra = await e.seedMember('member')
      expect((await call('users.get', { params: { id: extra.userId } })).id).toBe(extra.userId)
      await e.update('memberships', extra.membershipId, { deleted_at: iso(1), updated_at: iso(1) })
      expect((await call('users.get', { params: { id: extra.userId } })).id).toBe(extra.userId)
      expect(await fail('users.get', { params: { id: UNKNOWN } })).toEqual([404, 'not_found', 'user not found'])
      expect(await fail('users.get', { params: { id: 'nope' } })).toEqual([404, 'not_found', 'user not found'])
    })

    if (name === 'd1') {
      it('users.get: a user with no membership row (seeded directly) is 404 and absent from the list', async () => {
        const loner = '0190b2c4-0000-7000-8000-00000000f001'
        await seedPrincipal(e.d1!, { id: loner, kind: 'user' })
        expect(await fail('users.get', { params: { id: loner } })).toEqual([404, 'not_found', 'user not found'])
        expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).not.toContain(loner)
      })
    } else {
      it('users.get: another organisation\'s user is 404 and absent from the list', async () => {
        const org = await seedOrganization(e.app!, { name: 'Foreign' })
        const foreign = await seedUser(e.app!, { organizationId: org.id, role: 'owner' })
        expect(await fail('users.get', { params: { id: foreign.id } })).toEqual([404, 'not_found', 'user not found'])
        expect((await call('users.list', { query: {} })).data.map((u: any) => u.id)).not.toContain(foreign.id)
      })
    }
  })

  describe('clock parity (D2): every stamp is the unit clock, the response, the row and the event agree', () => {
    it('agent create and update, key issue and revoke', async () => {
      const a = await newAgent({}, { now: at(1) })
      expect(a).toMatchObject({ created_at: iso(1), updated_at: iso(1) })
      expect(await row('principals', a.id)).toMatchObject({ created_at: iso(1) })
      const u = await call('agents.update', { params: { id: a.id }, body: { disabled: true, name: 'n' } }, { now: at(2) })
      expect(u).toMatchObject({ updated_at: iso(2), disabled_at: iso(2) })
      expect(await row('agents', a.id)).toMatchObject({ updated_at: iso(2), disabled_at: iso(2) })
      const k = await newKey(a.id, { now: at(3) })
      expect(k).toMatchObject({ created_at: iso(3), updated_at: iso(3) })
      const r = await call('api_keys.revoke', { params: { id: k.id } }, { now: at(4) })
      expect(r).toMatchObject({ revoked_at: iso(4), updated_at: iso(4), created_at: iso(3) })
      expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: iso(4), updated_at: iso(4), created_at: iso(3) })
      const ev = (await e.rows('events')).filter((x) => x.type.startsWith('agent.') || x.type.startsWith('api_key.'))
      expect(ev.map((x) => [x.type, x.created_at])).toEqual([
        ['agent.created', iso(1)],
        ['agent.updated', iso(2)],
        ['api_key.created', iso(3)],
        ['api_key.revoked', iso(4)],
      ])
      expect(ev[1]!.after).toEqual(u)
      expect(ev[3]!.after).toEqual(r)
    })
  })

  describe('statement counts', () => {
    it('are constant, and printed for RESULT.md', async () => {
      const a = await run('agents.create', { body: { name: 'c' } })
      const b = await run('agents.update', { params: { id: a.value.id }, body: { name: 'd' } })
      const k = await run('api_keys.create', { body: { agent_id: a.value.id } })
      const r = await run('api_keys.revoke', { params: { id: k.value.id } })
      const l = await run('users.list', { query: {} })
      const counts = { 'agent create': a.stats.statements, 'agent update': b.stats.statements, 'key issue': k.stats.statements, 'key revoke': r.stats.statements, 'users.list': l.stats.statements }
      console.log(`[statements] ${name} ${JSON.stringify(counts)}`)
      for (const n of Object.values(counts)) expect(n).toBeGreaterThan(0)
      // a second agent create costs exactly the same (no per-row work)
      const a2 = await run('agents.create', { body: { name: 'c2', scopes: ['tasks:read', 'tasks:write'] } })
      expect(a2.stats.statements).toBe(a.stats.statements)
    })
  })

  describe('atomicity: a failure at the first mutation, first event or result rolls everything back', () => {
    const labels: StatementLabel[] = ['first-mutation', 'first-event', 'result']
    const cases: Record<string, () => Promise<() => Promise<PreparedOperation<unknown>>>> = {
      'agent create': async () => () => prepareOp('agents.create', { body: { name: 'f', scopes: ['tasks:read'] } }),
      'key issue': async () => {
        const a = await newAgent()
        return () => prepareOp('api_keys.create', { body: { agent_id: a.id } })
      },
      'key revoke': async () => {
        const a = await newAgent()
        const k = await newKey(a.id)
        return () => prepareOp('api_keys.revoke', { params: { id: k.id } })
      },
      'agent update': async () => {
        const a = await newAgent()
        return () => prepareOp('agents.update', { params: { id: a.id }, body: { name: 'z', disabled: true } })
      },
    }
    for (const [label, prepare] of Object.entries(cases)) {
      it.each(labels)(`${label}: a real constraint fault after %s changes nothing`, async (after) => {
        const make = await prepare()
        const before = await snapshot(e)
        const err = await e.run(withFault(await make(), { after })).then(() => null, (x: unknown) => x)
        expect(err).toBeInstanceOf(StatementFailed)
        expect(await snapshot(e)).toEqual(before)
      })
    }
  })

  if (name === 'd1') {
    describe('D1 drift: what changed between the plan and the commit batch aborts the unit', () => {
      const keyed = async () => {
        const a = await newAgent({}, { now: at(1) })
        const k = await newKey(a.id, { now: at(1) })
        return { a, k }
      }
      const revokeEvents = async () => (await e.rows('events')).filter((x) => x.type === 'api_key.revoked')

      it('double revoke: a direct revoke between plan and commit makes the unit 409 with no api_key.revoked event; the retry returns the revoked key with none', async () => {
        const { k } = await keyed()
        e.betweenPlanAndCommit(async () => {
          await e.update('api_keys', k.id, { revoked_at: iso(5), updated_at: iso(5) })
        })
        expect(await fail('api_keys.revoke', { params: { id: k.id } }, { now: at(6) })).toEqual([409, 'conflict', 'the record changed while the operation was running; retry'])
        expect(await revokeEvents()).toHaveLength(0)
        expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: iso(5), updated_at: iso(5) })
        const retry = await run('api_keys.revoke', { params: { id: k.id } }, { now: at(7) })
        expect(retry.value).toMatchObject({ revoked_at: iso(5), updated_at: iso(5) })
        expect(retry.events).toEqual([])
        expect(await revokeEvents()).toHaveLength(0)
      })

      it('revoke vs a revoke that did not move updated_at: the revoked_at guard alone makes it 409, with no api_key.revoked event', async () => {
        const { k } = await keyed()
        e.betweenPlanAndCommit(async () => {
          await e.update('api_keys', k.id, { revoked_at: iso(5) })
        })
        expect((await fail('api_keys.revoke', { params: { id: k.id } }, { now: at(6) }))[1]).toBe('conflict')
        expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: iso(5), updated_at: iso(1) })
        expect(await revokeEvents()).toHaveLength(0)
      })

      it('revoke vs touch: a bump of only updated_at between plan and commit is 409 (the stamp guard) and the key stays live', async () => {
        const { k } = await keyed()
        e.betweenPlanAndCommit(async () => {
          await e.update('api_keys', k.id, { updated_at: iso(5) })
        })
        expect((await fail('api_keys.revoke', { params: { id: k.id } }, { now: at(6) }))[1]).toBe('conflict')
        expect(await row('api_keys', k.id)).toMatchObject({ revoked_at: null, updated_at: iso(5) })
        expect(await revokeEvents()).toHaveLength(0)
      })

      it('agent update vs update: a direct rename between plan and commit is 409 and the direct name stays', async () => {
        const { a } = await keyed()
        e.betweenPlanAndCommit(async () => {
          await e.update('agents', a.id, { name: 'direct', updated_at: iso(5) })
        })
        expect((await fail('agents.update', { params: { id: a.id }, body: { name: 'planned' } }, { now: at(6) }))[1]).toBe('conflict')
        expect(await row('agents', a.id)).toMatchObject({ name: 'direct' })
        expect((await events('agent.updated')).length).toBe(0)
      })

      it('key issue racing the deletion of its agent: the guarded insert is a no-op, so 409 and no key row', async () => {
        const { a } = await keyed()
        const keysBefore = (await e.rows('api_keys')).length
        e.betweenPlanAndCommit(async () => {
          await e.d1!.prepare('delete from api_keys').run()
          await e.d1!.prepare('delete from agents where id = ?').bind(a.id).run()
        })
        expect((await fail('api_keys.create', { body: { agent_id: a.id } }, { now: at(6) }))[1]).toBe('conflict')
        expect(keysBefore).toBe(1)
        expect((await e.rows('api_keys')).length).toBe(0)
        expect((await events('api_key.created')).length).toBe(1) // the setup key's event only
      })
    })
  }
})
