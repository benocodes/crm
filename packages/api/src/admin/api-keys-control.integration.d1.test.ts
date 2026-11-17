import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileOperation } from '@vibase/storage'
import { readAgentForKey } from './crm-key-reads.js'
import { hashApiKey } from '../auth/api-keys.js'
import { openApiKeyKit, NO_SUCH, NOW, OWNER_SCOPES, type ApiKeyKit } from '../test/api-key-kit.js'

// [[CORE351]] groups 1 to 4: the four `api_keys.*` operations on the control store (D1 CRM database + control database, Miniflare), through the real REST app.
let k: ApiKeyKit
beforeAll(async () => {
  k = await openApiKeyKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const KEYS = '/meta/v1/api-keys'
const auditOf = (id: string) => k.ctl('select * from control_audit where target_id = ? order by id', id)

describe('group 1: writes on control with audit (P1, D12)', () => {
  it('create writes one control key and one api_key.created audit row, no CRM key and no event; the plaintext is in the result only', async () => {
    const before = await k.counts()
    const r = await k.owner('POST', KEYS, { agent_id: k.e.agentId, expires_at: '2027-01-01T00:00:00.000Z' })
    expect(r.status).toBe(201)
    const { key, ...record } = r.body
    expect(key).toMatch(/^vk_/)
    expect(record).toEqual({
      id: record.id,
      organization_id: k.e.organizationId,
      agent_id: k.e.agentId,
      prefix: key.slice(0, 11),
      last_used_at: null,
      revoked_at: null,
      expires_at: '2027-01-01T00:00:00.000Z',
      created_by: k.e.userId,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    const after = await k.counts()
    expect(after).toEqual({ ...before, ctlKeys: before.ctlKeys + 1, audit: before.audit + 1 })
    const row = (await k.ctl('select * from api_keys where id = ?', record.id))[0]!
    expect(row.key_hash).toBe(await hashApiKey(key))
    const log = await auditOf(record.id)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ action: 'api_key.created', actor_id: k.e.userId, target_id: record.id })
    expect(JSON.stringify([row, log])).not.toContain(key)
    expect(log[0]!.detail).not.toContain(row.key_hash)
  })

  it('revoke writes revoked_at and updated_at at the clock and one api_key.revoked audit row; a repeat writes nothing', async () => {
    const made = await k.create()
    k.clock.now = new Date(NOW.getTime() + 60_000)
    const at = k.clock.now.toISOString()
    const before = await k.counts()
    const r = await k.owner('POST', `${KEYS}/${made.id}/revoke`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: made.id, revoked_at: at, updated_at: at, created_at: NOW.toISOString() })
    expect(r.body.key).toBeUndefined()
    expect(await k.counts()).toEqual({ ...before, audit: before.audit + 1 })
    expect((await auditOf(made.id)).map((a) => a.action)).toEqual(['api_key.created', 'api_key.revoked'])
    k.clock.now = new Date(NOW.getTime() + 120_000)
    const again = await k.owner('POST', `${KEYS}/${made.id}/revoke`)
    expect(again.body).toEqual(r.body)
    expect(await k.counts()).toEqual({ ...before, audit: before.audit + 1 })
  })

  it('secrets: neither the hash nor the plaintext is in any response but create, nor in an event', async () => {
    const made = await k.create()
    const hash = await hashApiKey(made.key)
    const seen = [
      await k.owner('GET', KEYS),
      await k.owner('GET', `${KEYS}/${made.id}`),
      await k.owner('POST', `${KEYS}/${made.id}/revoke`),
    ]
    const text = JSON.stringify(seen) + JSON.stringify(await k.crm('select * from events'))
    for (const bad of [made.key, hash, 'key_hash']) expect(text).not.toContain(bad)
  })
})

describe('group 2: control only; a CRM-held key is not found (P2 dropped by the user)', () => {
  it('an id in neither store is 404 for get and revoke; an id that is not a UUID is 400 for revoke (the adapter), as today', async () => {
    for (const [m, p, status] of [
      ['GET', `${KEYS}/${NO_SUCH}`, 404],
      ['POST', `${KEYS}/${NO_SUCH}/revoke`, 404],
      ['POST', `${KEYS}/nope/revoke`, 400],
    ] as const) {
      const r = await k.owner(m, p)
      expect(r.status, p).toBe(status)
    }
  })

  it('a control key is read and revoked in control (the CRM database has no api_keys table, CORE329)', async () => {
    const c = await k.ctlKey({ prefix: 'vk_control00' })
    expect((await k.owner('GET', `${KEYS}/${c.id}`)).body.prefix).toBe('vk_control00')
    await k.owner('POST', `${KEYS}/${c.id}/revoke`)
    expect((await k.ctl('select revoked_at from api_keys where id = ?', c.id))[0]!.revoked_at).not.toBeNull()
    expect((await auditOf(c.id)).map((a) => a.action)).toEqual(['api_key.revoked'])
  })
})

describe('group 3: authority and refusals match today (P1, P6)', () => {
  it('scopes: agents:write for create and revoke, agents:read for list and get; owners and agents alike', async () => {
    const made = await k.create()
    for (const who of ['owner', 'agent'] as const) {
      const call = (scopes: string[], m: string, p: string, b?: unknown) =>
        who === 'owner' ? k.owner(m, p, b, scopes) : k.agent(scopes, m, p, b)
      expect((await call(['agents:read'], 'GET', KEYS)).status, who).toBe(200)
      expect((await call(['agents:read'], 'GET', `${KEYS}/${made.id}`)).status).toBe(200)
      expect((await call(['agents:write'], 'GET', KEYS)).status).toBe(403)
      expect((await call(['agents:read'], 'POST', KEYS, { agent_id: k.e.agentId })).status).toBe(403)
      expect((await call(['agents:read'], 'POST', `${KEYS}/${made.id}/revoke`)).status).toBe(403)
      expect((await call(['agents:write'], 'POST', KEYS, { agent_id: k.e.agentId })).status).toBe(201)
    }
  })

  it('refusals write nothing, audit included: missing agent, past expiry, expiry equal to now, bad body', async () => {
    const before = await k.counts()
    const cases: Array<[unknown, number, string, string?]> = [
      [{ agent_id: NO_SUCH }, 400, 'invalid_reference', 'a referenced record does not exist'],
      [
        { agent_id: k.e.agentId, expires_at: new Date(NOW.getTime() - 1000).toISOString() },
        400,
        'validation_error',
        'expires_at must be in the future',
      ],
      [
        { agent_id: k.e.agentId, expires_at: NOW.toISOString() },
        400,
        'validation_error',
        'expires_at must be in the future',
      ],
      [{ agent_id: k.e.agentId, key: 'vk_mine' }, 400, 'validation_error'],
      [{}, 400, 'validation_error'],
    ]
    for (const [body, status, code, message] of cases) {
      const r = await k.owner('POST', KEYS, body)
      expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([status, code])
      if (message) expect(r.body.error.message).toBe(message)
    }
    expect(await k.counts()).toEqual(before)
  })

  it('the agent read is scoped to the organisation on both dialects (a D1 deployment holds one organisation and its binding refuses a foreign one, so the predicate is proven at the program)', () => {
    for (const dialect of ['d1', 'postgres'] as const) {
      const compiled = compileOperation(readAgentForKey(k.e.organizationId, k.e.agentId), dialect, {})
      const text = compiled.reads.map((r) => `${r.sql} ${JSON.stringify(r.parameters)}`).join(' ')
      expect(text, dialect).toMatch(/organization_id/)
      expect(text, dialect).toContain(k.e.organizationId)
    }
  })

  it('a disabled agent may be issued a key (CORE27)', async () => {
    await k.e.update('agents', k.e.agentId, { disabled_at: NOW.toISOString() })
    expect((await k.owner('POST', KEYS, { agent_id: k.e.agentId })).status).toBe(201)
  })

  it('drift: a control write between the read and the revoke is replanned once; a second drift is 409 and writes nothing', async () => {
    const made = await k.create()
    let n = 0
    const real = k.store.revoke
    const bump = async () =>
      k.control
        .prepare('update api_keys set updated_at = ? where id = ?')
        .bind(new Date(NOW.getTime() + ++n * 1000).toISOString(), made.id)
        .run()
    k.store.revoke = async (a) => {
      await bump()
      return real(a)
    }
    const before = await k.counts()
    const r = await k.owner('POST', `${KEYS}/${made.id}/revoke`)
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict'])
    expect(await k.counts()).toEqual(before)
    k.store.revoke = real
    expect((await k.owner('POST', `${KEYS}/${made.id}/revoke`)).status).toBe(200)
  })

  it("a revoke racing another revoke answers 200 with the racer's revoked_at and exactly one api_key.revoked audit row", async () => {
    const made = await k.create()
    const real = k.store.revoke
    const racerAt = new Date(NOW.getTime() + 30_000).toISOString()
    let raced = false
    k.store.revoke = async (a) => {
      if (!raced) {
        raced = true
        await real({
          ...a,
          auditId: '0190b2c4-0000-7000-8000-0000000000aa',
          now: racerAt,
          expectedUpdatedAt: undefined,
        })
      }
      return real(a)
    }
    k.clock.now = new Date(NOW.getTime() + 60_000)
    const r = await k.owner('POST', `${KEYS}/${made.id}/revoke`)
    k.store.revoke = real
    expect(r.status).toBe(200)
    expect(r.body.revoked_at).toBe(racerAt)
    expect((await auditOf(made.id)).filter((a) => a.action === 'api_key.revoked')).toHaveLength(1)
  })
})

describe('group 4: list surface (P3, P4): sort x order x filter, with cursor continuation', () => {
  interface Row {
    id: string
    agent_id: string
    prefix: string
    created_at: string
    updated_at: string
    last_used_at: string | null
    expires_at: string | null
    revoked_at: string | null
  }
  let rows: Row[]
  beforeEach(async () => {
    const at = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString()
    const agent2 = await seedSecondAgent()
    for (let i = 0; i < 9; i++) {
      const c = await k.ctlKey({
        id: `0190b2c4-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
        agent_id: i % 2 ? agent2 : k.e.agentId,
        prefix: i % 3 === 0 ? 'vk_alpha' : 'vk_beta',
        created_at: at(Math.floor(i / 3)),
        updated_at: at(i % 2),
        last_used_at: i % 3 === 1 ? null : at(10 + ((i * 5) % 4)),
        expires_at: i % 4 === 0 ? null : at(100 + (i % 3)),
        revoked_at: i === 5 ? at(50) : null,
      })
      void c
    }
    rows = (await k.ctl(
      'select id, agent_id, prefix, created_at, updated_at, last_used_at, expires_at, revoked_at from api_keys',
    )) as Row[]
  })
  async function seedSecondAgent(): Promise<string> {
    return k.seedAgent()
  }
  const cmp = (a: string | null, b: string | null, order: 'asc' | 'desc'): number => {
    if (a === b) return 0
    if (a === null) return order === 'asc' ? -1 : 1
    if (b === null) return order === 'asc' ? 1 : -1
    return (a < b ? -1 : 1) * (order === 'asc' ? 1 : -1)
  }
  const filters: Array<[string, string, (r: Row) => boolean]> = [
    ['none', '', () => true],
    ['agent_id eq', '', (r) => r.agent_id === k.e.agentId],
    ['revoked_at is.null', 'revoked_at=is.null', (r) => r.revoked_at === null],
    ['expires_at not.is.null', 'expires_at=not.is.null', (r) => r.expires_at !== null],
    ['prefix like', 'prefix=like.vk_al*', (r) => r.prefix.startsWith('vk_al')],
    [
      'last_used_at gte',
      '',
      (r) => r.last_used_at !== null && r.last_used_at >= new Date(NOW.getTime() + 11 * 60_000).toISOString(),
    ],
  ]
  const sorts = [undefined, 'id', 'created_at', 'updated_at', 'last_used_at', 'expires_at'] as const
  const cases = sorts.flatMap((s) => (['asc', 'desc'] as const).flatMap((o) => filters.map((f) => [s, o, f] as const)))
  it.each(cases)(
    'sort=%s order=%s filter=%s: the same ids in order across pages',
    async (sort, order, [name, qs, pred]) => {
      const query = new URLSearchParams()
      if (name === 'agent_id eq') query.set('agent_id', k.e.agentId)
      if (name === 'last_used_at gte')
        query.set('last_used_at', `gte.${new Date(NOW.getTime() + 11 * 60_000).toISOString()}`)
      if (qs) {
        const [key, v] = qs.split('=')
        query.set(key!, v!)
      }
      if (sort) query.set('sort', sort)
      if (sort) query.set('order', order)
      else if (order === 'desc') return // order needs sort
      query.set('limit', '3')
      const col = (sort ?? 'id') as keyof Row
      const expected = rows
        .filter(pred)
        .sort((a, b) => cmp(a[col] as string | null, b[col] as string | null, order) || cmp(a.id, b.id, order))
        .map((r) => r.id)
      const got: string[] = []
      let after: string | null = null
      for (let i = 0; i < 10; i++) {
        const q = new URLSearchParams(query)
        if (after) q.set('after', after)
        const r = await k.owner('GET', `${KEYS}?${q}`)
        expect(r.status, r.text).toBe(200)
        got.push(...r.body.data.map((x: Row) => x.id))
        after = r.body.next_cursor
        if (!after) break
      }
      expect(got).toEqual(expected)
    },
  )

  it("the shapes and codes are today's: an unknown sort, order without sort and a foreign cursor are 400", async () => {
    for (const q of ['sort=prefix', 'order=desc', 'after=nope', 'sort=created_at&order=sideways', 'nope=1']) {
      const r = await k.owner('GET', `${KEYS}?${q}`)
      expect([r.status, r.body.error.code], q).toEqual([400, 'validation_error'])
    }
  })
})

describe('group 5 (api half): without a store the four operations answer 501 provider_not_configured (P5)', () => {
  it('the registry has them all the same, and each answers 501 when composed without a control store', async () => {
    const { createApp } = await import('../rest/app.js')
    const { createVibaseRegistry } = await import('../operations.js')
    const { fakeUserAuthenticator, mintTestUserToken } = await import('../test/user-auth.js')
    const registry = createVibaseRegistry()
    for (const name of ['api_keys.create', 'api_keys.revoke', 'api_keys.list', 'api_keys.get'])
      expect(registry.get(name), name).toBeDefined()
    const app = createApp({ registry, storage: () => k.e.binding, userAuthenticator: fakeUserAuthenticator() })
    const token = mintTestUserToken({ userId: k.e.userId, organizationId: k.e.organizationId, scopes: OWNER_SCOPES })
    for (const [m, p, b] of [
      ['POST', KEYS, { agent_id: k.e.agentId }],
      ['POST', `${KEYS}/${NO_SUCH}/revoke`, undefined],
      ['GET', KEYS, undefined],
      ['GET', `${KEYS}/${NO_SUCH}`, undefined],
    ] as const) {
      const res = await app.request(p, {
        method: m,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
      expect([res.status, ((await res.json()) as any).error.code], p).toEqual([501, 'provider_not_configured'])
    }
  })
})

describe('key authentication at the app, control only (moved from the auth suite, CORE329)', () => {
  it('a refused (revoked) key is 401 and logs neither the key past 8 characters nor its hash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const revoked = await k.ctlKey({ revoked_at: new Date(NOW.getTime() - 10_000).toISOString() })
      const res = await k.keyCall(revoked.key, '/api/v1/tasks')
      expect(res.status).toBe(401)
      expect(res.body.error).toEqual({ code: 'unauthenticated', message: 'invalid or expired credentials' })
      const logs = JSON.stringify(warn.mock.calls)
      expect(logs).toContain(revoked.key.slice(0, 8))
      expect(logs).not.toContain(revoked.key.slice(0, 9))
      expect(logs).not.toContain(await hashApiKey(revoked.key))
    } finally {
      warn.mockRestore()
    }
  })

  it('an agent key is refused 403 user_required on /meta/v1/me', async () => {
    const { key } = await k.ctlKey()
    const res = await k.keyCall(key, '/meta/v1/me')
    expect([res.status, res.body.error.code]).toEqual([403, 'user_required'])
  })
})
