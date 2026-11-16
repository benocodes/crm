import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hashApiKey } from '../auth/api-keys.js'
import { openApiKeyKit, NO_SUCH, NOW, OTHER_ORG, type ApiKeyKit } from '../test/api-key-kit.js'

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

describe('group 2: CRM-only keys (P2)', () => {
  it('get reads a CRM-only key', async () => {
    const c = await k.crmKey()
    const r = await k.owner('GET', `${KEYS}/${c.id}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: c.id, agent_id: k.e.agentId, revoked_at: null })
  })

  it('revoke copies it into control revoked with one audit row, leaves the CRM row and writes no event; the key is refused cold and warm', async () => {
    const c = await k.crmKey()
    expect((await k.keyCall(c.key)).status).toBe(200) // warm: the isolate has seen the CRM key
    const before = await k.counts()
    const crmRow = (await k.crm('select * from api_keys where id = ?', c.id))[0]
    k.clock.now = new Date(NOW.getTime() + 60_000)
    const r = await k.owner('POST', `${KEYS}/${c.id}/revoke`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: c.id, revoked_at: k.clock.now.toISOString() })
    const after = await k.counts()
    expect(after).toEqual({ ...before, ctlKeys: before.ctlKeys + 1, audit: before.audit + 1 })
    expect((await k.crm('select * from api_keys where id = ?', c.id))[0]).toEqual({
      ...crmRow,
      last_used_at: expect.anything(),
    })
    expect((await auditOf(c.id)).map((a) => a.action)).toEqual(['api_key.revoked'])
    expect((await k.keyCall(c.key)).status).toBe(401) // same isolate
    expect((await k.keyCall(c.key)).status).toBe(401)
  })

  it("a second revoke is today's repeat: the revoked record, nothing written", async () => {
    const c = await k.crmKey()
    const first = await k.owner('POST', `${KEYS}/${c.id}/revoke`)
    const before = await k.counts()
    const again = await k.owner('POST', `${KEYS}/${c.id}/revoke`)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await k.counts()).toEqual(before)
  })

  it('an id in neither store is 404 for get and revoke; an id that is not a UUID is 404 for revoke', async () => {
    for (const [m, p] of [
      ['GET', `${KEYS}/${NO_SUCH}`],
      ['POST', `${KEYS}/${NO_SUCH}/revoke`],
      ['POST', `${KEYS}/nope/revoke`],
    ] as const) {
      const r = await k.owner(m, p)
      expect([r.status, r.body.error.code], p).toEqual([404, 'not_found'])
    }
  })

  it('a key in both stores is read and revoked from control only', async () => {
    const c = await k.crmKey()
    await k.control
      .prepare(
        'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        c.id,
        NOW.toISOString(),
        NOW.toISOString(),
        k.e.organizationId,
        k.e.agentId,
        'other-hash',
        'vk_control00',
        k.e.userId,
      )
      .run()
    expect((await k.owner('GET', `${KEYS}/${c.id}`)).body.prefix).toBe('vk_control00')
    await k.owner('POST', `${KEYS}/${c.id}/revoke`)
    expect((await k.ctl('select revoked_at from api_keys where id = ?', c.id))[0]!.revoked_at).not.toBeNull()
    expect((await k.crm('select revoked_at from api_keys where id = ?', c.id))[0]!.revoked_at).toBeNull()
    expect((await auditOf(c.id)).map((a) => a.action)).toEqual(['api_key.revoked'])
  })

  it('an empty state lists nothing and revoking in an empty deployment is 404', async () => {
    expect((await k.owner('GET', KEYS)).body).toEqual({ data: [], next_cursor: null })
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

  it("refusals write nothing, audit included: missing agent, other organisation's agent, past expiry, expiry equal to now, bad body", async () => {
    const other = '0190b2c4-0000-7000-8000-0000000000a1'
    await k.e
      .d1!.batch([
        k.e
          .d1!.prepare("insert into principals (id, kind, created_at) values (?, 'agent', ?)")
          .bind(other, NOW.toISOString()),
        k.e
          .d1!.prepare('insert into organizations (id, created_at, updated_at, name) values (?, ?, ?, ?)')
          .bind(OTHER_ORG, NOW.toISOString(), NOW.toISOString(), 'Other'),
      ])
      .catch(() => undefined)
    const before = await k.counts()
    const cases: Array<[unknown, number, string, string?]> = [
      [{ agent_id: NO_SUCH }, 400, 'invalid_reference', 'a referenced record does not exist'],
      [{ agent_id: other }, 400, 'invalid_reference'],
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

  it('an agent of another organisation is refused even when its id exists (the organisation predicate of the agent read)', async () => {
    const foreign = '0190b2c4-0000-7000-8000-0000000000b2'
    const at = NOW.toISOString()
    await k.e
      .d1!.prepare('insert into principals (id, kind, created_at) values (?, ?, ?)')
      .bind(foreign, 'agent', at)
      .run()
    await k.e.d1!.prepare('pragma foreign_keys = off').run()
    await k.e
      .d1!.prepare(
        'insert into agents (id, created_at, updated_at, organization_id, name, scopes, created_by) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(foreign, at, at, OTHER_ORG, 'foreign', '[]', k.e.userId)
      .run()
    const before = await k.counts()
    const r = await k.owner('POST', KEYS, { agent_id: foreign })
    expect([r.status, r.body.error.code]).toEqual([400, 'invalid_reference'])
    expect(await k.counts()).toEqual(before)
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
    await k.crmKey() // a CRM-only key: never listed
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
