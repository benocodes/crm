import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineOperation, unit } from '@vibase/storage'
import { SCOPE_DESCRIPTIONS } from '../auth/roles.js'
import { createVibaseRegistry } from '../operations.js'
import { proposalMeta } from '../proposal.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { captureSettingsRead, type CaptureSettings } from './capture-settings.js'

// [[CHN409]]: `connections.update` ([[CHN406]] D4, D5, D6, D7, D10, D13, P1 to P3). Fixtures are direct inserts: setup bypasses the code under test.
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

type Who = 'owner' | 'other' | 'agent'
const call = async (method: string, path: string, body?: unknown, opts: { who?: Who; scopes?: string[] } = {}) => {
  const who = opts.who ?? 'owner'
  const token = mintTestUserToken({
    userId: who === 'agent' ? e.agentId : who === 'other' ? e.user2Id : e.userId,
    organizationId: e.organizationId,
    scopes: opts.scopes ?? ['connections:read', 'connections:write'],
    kind: who === 'agent' ? 'agent' : 'user',
  })
  const res = await app.request(`https://vibase.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const patch = (id: string, body: unknown, opts: { who?: Who; scopes?: string[] } = {}) =>
  call('PATCH', `/meta/v1/connections/${id}`, body, opts)
const get = async (id: string) => (await call('GET', `/meta/v1/connections/${id}`)).body

let n = 0
async function seedConnection(over: Record<string, unknown> = {}) {
  n++
  const identity = await e.insert('identities', {
    kind: 'email',
    value: `own-${n}@vibase.test`,
    contact_id: null,
    own: true,
  })
  const c = await e.insert('channel_connections', {
    provider: 'google',
    account_id: `sub-${n}`,
    identity_id: identity.id,
    owner_id: e.userId,
    status: 'active',
    granted_scopes: ['openid'],
    connected_at: SEED_AT,
    ...over,
  })
  for (const l of ['INBOX', 'SENT']) await e.insert('connection_capture_labels', { connection_id: c.id, label_id: l })
  return c
}
const own = (connection_id: string, kind: 'address' | 'domain', value: string) =>
  e.insert('connection_blocked_senders', { connection_id, kind, value })
const updatedEvents = async (id?: string) =>
  (await e.events()).filter((x: any) => x.type === 'connection.updated' && (id === undefined || x.resource_id === id))
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]

describe('write semantics (D5)', () => {
  it('each field alone changes only itself; the others read back unchanged', async () => {
    const c = await seedConnection({ contact_creation: 'sent' })
    await own(c.id as string, 'domain', 'keep.example')
    const base = await get(c.id as string)
    const cases: Array<[string, unknown]> = [
      ['capture_labels', ['INBOX', 'Label_1']],
      ['blocked_senders', [{ kind: 'address', value: 'a@x.example' }]],
      ['exclude_group_addresses', true],
      ['exclude_personal_domains', true],
      ['contact_creation', 'none'],
    ]
    let prev = base
    for (const [field, value] of cases) {
      const res = await patch(c.id as string, { [field]: value })
      expect(res.status, field).toBe(200)
      const now = await get(c.id as string)
      for (const k of Object.keys(prev).filter((k) => !['updated_at', field].includes(k)))
        expect(now[k], `${field} left ${k}`).toEqual(prev[k])
      expect(now[field]).toEqual(value)
      prev = now
    }
  })

  it('a list replaces the whole list: a shorter list removes rows, an empty blocked list clears it', async () => {
    const c = await seedConnection()
    await own(c.id as string, 'domain', 'a.example')
    await own(c.id as string, 'domain', 'b.example')
    await own(c.id as string, 'address', 'x@a.example')
    expect((await patch(c.id as string, { blocked_senders: [{ kind: 'domain', value: 'b.example' }] })).status).toBe(
      200,
    )
    expect((await get(c.id as string)).blocked_senders).toEqual([{ kind: 'domain', value: 'b.example' }])
    expect(await e.rows('connection_blocked_senders')).toHaveLength(1)
    expect((await patch(c.id as string, { capture_labels: ['SENT'] })).status).toBe(200)
    expect(await e.rows('connection_capture_labels')).toHaveLength(1)
    expect((await patch(c.id as string, { blocked_senders: [] })).status).toBe(200)
    expect((await get(c.id as string)).blocked_senders).toEqual([])
    expect(await e.rows('connection_blocked_senders')).toHaveLength(0)
  })

  it('the same body twice leaves the same state; the 200 body equals a following connections.get; captureSettingsRead sees the values', async () => {
    const c = await seedConnection()
    const body = {
      capture_labels: ['Label_2', 'INBOX'],
      blocked_senders: [
        { kind: 'domain', value: 'z.example' },
        { kind: 'address', value: 'a@a.example' },
      ],
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'none',
    }
    const first = await patch(c.id as string, body)
    expect(first.status).toBe(200)
    const second = await patch(c.id as string, body)
    expect(second.status).toBe(200)
    const stable = (r: any) => ({ ...r, updated_at: undefined })
    expect(stable(second.body)).toEqual(stable(first.body))
    expect(await get(c.id as string)).toEqual(second.body)
    expect(second.body.capture_labels).toEqual(['INBOX', 'Label_2'])
    expect(second.body.blocked_senders).toEqual([
      { kind: 'address', value: 'a@a.example' },
      { kind: 'domain', value: 'z.example' },
    ])
    const settings = (
      await e.run(
        defineOperation<CaptureSettings | null>({
          name: 'test.capture_settings',
          mutates: false,
          reads: (qc) => ({ s: captureSettingsRead(qc, e.organizationId, c.id as string).read }),
          build: (found, qc) =>
            unit({
              steps: [],
              events: [],
              decode: () => captureSettingsRead(qc, e.organizationId, c.id as string).decode(found.maybe('s')),
            }),
        }),
      )
    ).value
    expect(settings).toMatchObject({
      capture_labels: ['INBOX', 'Label_2'],
      blocked_addresses: ['a@a.example'],
      blocked_domains: ['z.example'],
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'none',
    })
  })

  it('is atomic: a list insert a 0021 constraint refuses leaves the columns and the other list as they were, and emits no event', async () => {
    const c = await seedConnection({ contact_creation: 'sent' })
    await own(c.id as string, 'domain', 'old.example')
    // The test seam: a trigger refuses one value that validation accepts, so the failure comes from storage, after earlier statements ran.
    await e
      .d1!.prepare(
        `create trigger refuse_boom before insert on connection_blocked_senders when new.value = 'boom@x.example' begin select raise(abort, 'refused'); end`,
      )
      .run()
    const before = await get(c.id as string)
    const res = await patch(c.id as string, {
      contact_creation: 'none',
      exclude_group_addresses: true,
      capture_labels: ['INBOX', 'Label_9'],
      blocked_senders: [{ kind: 'address', value: 'boom@x.example' }],
    })
    expect(res.status).not.toBe(200)
    expect(await get(c.id as string)).toEqual(before)
    expect(await updatedEvents(c.id as string)).toEqual([])
  })
})

describe('authority (D6, P3)', () => {
  it('refuses in order, each with nothing written and no event', async () => {
    const mine = await seedConnection()
    const theirs = await seedConnection({ owner_id: e.user2Id })
    const gone = await seedConnection({ deleted_at: SEED_AT })
    const body = { contact_creation: 'none' }
    // lacking the scope
    expect(refusal(await patch(mine.id as string, body, { scopes: ['connections:read'] }))).toEqual([
      403,
      'insufficient_scope',
    ])
    // an agent, even one handed connections:write
    expect(refusal(await patch(mine.id as string, body, { who: 'agent' }))).toEqual([403, 'user_required'])
    // unknown and disconnected
    expect(refusal(await patch('0190b2c4-0000-7000-8000-00000000dead', body))).toEqual([404, 'not_found'])
    expect(refusal(await patch(gone.id as string, body))).toEqual([404, 'not_found'])
    // another member's connection
    expect(refusal(await patch(theirs.id as string, body))).toEqual([403, 'not_connection_owner'])
    for (const c of [mine, theirs, gone])
      expect((await e.rows('channel_connections')).find((r) => r.id === c.id)?.contact_creation).toBe(
        'sent_and_received',
      )
    expect(await updatedEvents()).toEqual([])
  })

  it('accepts reauth_required and suspended connections', async () => {
    for (const status of ['reauth_required', 'suspended']) {
      const c = await seedConnection({ status })
      const res = await patch(c.id as string, { contact_creation: 'sent' })
      expect([res.status, res.body.status, res.body.contact_creation], status).toEqual([200, status, 'sent'])
    }
  })

  it('is not proposable: an action request for it is refused, and its proposal decision says so', async () => {
    const c = await seedConnection()
    const decl = createVibaseRegistry().get('connections.update')
    expect(decl).toBeDefined()
    expect(proposalMeta(decl!).eligible).toBe(false)
    const res = await call(
      'POST',
      '/api/v1/action-requests',
      { operation: 'connections.update', arguments: { id: c.id, contact_creation: 'none' }, reason: 'x' },
      { scopes: ['connections:write', 'action_requests:read'] },
    )
    expect(refusal(res)).toEqual([400, 'operation_not_proposable'])
  })

  it('drift: a disconnect between plan and write writes nothing, emits no event and answers 404', async () => {
    const c = await seedConnection()
    e.betweenPlanAndCommit(async () => {
      await e.update('channel_connections', c.id as string, { deleted_at: SEED_AT })
    })
    const res = await patch(c.id as string, { contact_creation: 'none', capture_labels: ['INBOX'] })
    expect(refusal(res)).toEqual([404, 'not_found'])
    const row = (await e.rows('channel_connections')).find((r) => r.id === c.id)
    expect(row?.contact_creation).toBe('sent_and_received')
    expect(await e.rows('connection_capture_labels')).toHaveLength(2)
    expect(await updatedEvents()).toEqual([])
  })

  it('drift: an owner change between plan and write writes nothing, emits no event and answers 403 not_connection_owner', async () => {
    const c = await seedConnection()
    e.betweenPlanAndCommit(async () => {
      await e.update('channel_connections', c.id as string, { owner_id: e.user2Id })
    })
    const res = await patch(c.id as string, { contact_creation: 'none', capture_labels: ['INBOX'] })
    expect(refusal(res)).toEqual([403, 'not_connection_owner'])
    const row = (await e.rows('channel_connections')).find((r) => r.id === c.id)
    expect(row?.contact_creation).toBe('sent_and_received')
    expect(await e.rows('connection_capture_labels')).toHaveLength(2)
    expect(await updatedEvents()).toEqual([])
  })
})

describe('validation and normalisation (D4, D7, P2): the matrix', () => {
  const bad = async (body: unknown, needle?: string | RegExp) => {
    const c = await seedConnection()
    const res = await patch(c.id as string, body)
    expect(refusal(res), JSON.stringify(body).slice(0, 80)).toEqual([400, 'validation_error'])
    if (needle) expect(res.body.error.message).toMatch(needle)
    expect(await updatedEvents()).toEqual([])
    return res
  }
  const stored = async (body: unknown) => {
    const c = await seedConnection()
    const res = await patch(c.id as string, body)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body
  }
  const blocked = (value: string, kind = 'domain') => ({ blocked_senders: [{ kind, value }] })
  const many = (count: number, make: (i: number) => unknown) => Array.from({ length: count }, (_, i) => make(i))

  it('an empty body and an unknown field are refused', async () => {
    await bad({})
    await bad({ owner_id: e.user2Id })
    await bad({ status: 'active' })
    await bad({ provider: 'google' })
    await bad({ contact_creation: 'always' })
  })

  it('labels: empty, 51, a bad pattern, a duplicate and each system label are refused', async () => {
    await bad({ capture_labels: [] })
    await bad({ capture_labels: many(51, (i) => `L_${i}`) })
    await bad({ capture_labels: ['has space'] })
    await bad({ capture_labels: ['a'.repeat(101)] })
    await bad({ capture_labels: ['INBOX', 'INBOX'] }, /capture_labels\[1\]/)
    for (const l of ['DRAFT', 'SPAM', 'TRASH', 'CHAT'])
      await bad({ capture_labels: ['INBOX', l] }, /capture_labels\[1\]/)
    const ok = await stored({ capture_labels: many(50, (i) => `L_${i}`) })
    expect(ok.capture_labels).toHaveLength(50)
  })

  it('blocked senders: 501 entries and an unknown kind are refused, 500 are accepted', async () => {
    await bad({ blocked_senders: many(501, (i) => ({ kind: 'domain', value: `d${i}.example` })) })
    await bad(blocked('example.com', 'phone'))
    const ok = await stored({ blocked_senders: many(500, (i) => ({ kind: 'domain', value: `d${i}.example` })) })
    expect(ok.blocked_senders).toHaveLength(500)
  })

  it('an address is trimmed and lowercased; one without an @ or not an address is refused naming its index', async () => {
    expect((await stored(blocked(' Foo@Example.COM ', 'address'))).blocked_senders).toEqual([
      { kind: 'address', value: 'foo@example.com' },
    ])
    const res = await bad(
      {
        blocked_senders: [
          { kind: 'address', value: 'ok@example.com' },
          { kind: 'address', value: 'no-at-sign' },
        ],
      },
      /blocked_senders\[1\]/,
    )
    expect(res.body.error.code).toBe('validation_error')
    await bad(blocked('a@b', 'address'), /blocked_senders\[0\]/)
  })

  it('a domain is lowercased; a leading @ or ., a trailing ., a single label, a 254-character one are refused; punycode is accepted', async () => {
    expect((await stored(blocked(' Example.COM '))).blocked_senders).toEqual([{ kind: 'domain', value: 'example.com' }])
    for (const v of [
      '@example.com',
      '.example.com',
      'example.com.',
      'localhost',
      `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(10)}.com`,
    ])
      await bad(blocked(v), /blocked_senders\[0\]/)
    expect(
      `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(10)}.com`.length,
    ).toBeGreaterThan(253)
    expect((await stored(blocked('xn--80ak6aa92e.xn--p1ai'))).blocked_senders).toEqual([
      { kind: 'domain', value: 'xn--80ak6aa92e.xn--p1ai' },
    ])
  })

  it('two entries equal after normalising are refused, not collapsed', async () => {
    await bad(
      {
        blocked_senders: [
          { kind: 'domain', value: 'Example.com' },
          { kind: 'domain', value: 'example.COM ' },
        ],
      },
      /blocked_senders\[1\]/,
    )
    await bad(
      {
        blocked_senders: [
          { kind: 'address', value: 'A@x.example' },
          { kind: 'address', value: ' a@X.example' },
        ],
      },
      /blocked_senders\[1\]/,
    )
  })
})

describe('the event (D10)', () => {
  it('one connection.updated per accepted call, a no-op included; before is the record before, after the stored record; none on a refusal', async () => {
    const c = await seedConnection({ contact_creation: 'sent' })
    await own(c.id as string, 'domain', 'z.example')
    await own(c.id as string, 'address', 'a@z.example')
    const record = (r: any) => {
      const { last_synced_at: _s, last_error_code: _e, ...rest } = r
      return rest
    }
    const before = record(await get(c.id as string))
    const body = { capture_labels: ['SENT', 'INBOX', 'Label_1'], contact_creation: 'none' }
    const first = await patch(c.id as string, body)
    expect(first.status).toBe(200)
    let events = await updatedEvents(c.id as string)
    expect(events).toHaveLength(1)
    expect(events[0]!.before).toEqual(before)
    expect(events[0]!.after).toEqual(record(first.body))
    expect((events[0]!.after as any).capture_labels).toEqual(['INBOX', 'Label_1', 'SENT'])
    expect(events[0]!.actor_id).toBe(e.userId)
    // the same body again: a no-op, and still one more event
    expect((await patch(c.id as string, body)).status).toBe(200)
    events = await updatedEvents(c.id as string)
    expect(events).toHaveLength(2)
    expect((events[1]!.before as any).capture_labels).toEqual(['INBOX', 'Label_1', 'SENT'])
    // refusals add none
    await patch(c.id as string, { capture_labels: [] })
    await patch(c.id as string, {}, { who: 'other' })
    await patch('0190b2c4-0000-7000-8000-00000000dead', body)
    expect(await updatedEvents()).toHaveLength(2)
  })
})

describe('surfaces (D13, P1)', () => {
  it('OpenAPI lists PATCH /meta/v1/connections/{id} with the strict body; the connect description is the revised text', async () => {
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const op = meta.paths['/meta/v1/connections/{id}']?.patch
    expect(op?.operationId).toBe('connections.update')
    const schema = op.requestBody.content['application/json'].schema
    expect(Object.keys(schema.properties).sort()).toEqual([
      'blocked_senders',
      'capture_labels',
      'contact_creation',
      'exclude_group_addresses',
      'exclude_personal_domains',
    ])
    expect(schema.additionalProperties).toBe(false)
    expect(op.description).toMatch(/vibase connections update/)
    expect(SCOPE_DESCRIPTIONS['connections:write']).toBe(
      'Connect and disconnect mailboxes, and change their capture settings',
    )
  })

  it('the MCP tool exists and answers as REST does for the same actor', async () => {
    const c = await seedConnection()
    const theirs = await seedConnection({ owner_id: e.user2Id })
    const rpc = async (who: Who, args: unknown) => {
      const token = mintTestUserToken({
        userId: who === 'agent' ? e.agentId : e.userId,
        organizationId: e.organizationId,
        scopes: ['connections:read', 'connections:write'],
        kind: who === 'agent' ? 'agent' : 'user',
      })
      return (await (
        await app.request('/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'connections_update', arguments: args },
          }),
        })
      ).json()) as any
    }
    const listed = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ['connections:write'], kind: 'user' })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(((await listed.json()) as any).result.tools.map((t: any) => t.name)).toContain('connections_update')
    const ok = await rpc('owner', { id: c.id, contact_creation: 'none' })
    expect(ok.result.isError, JSON.stringify(ok)).not.toBe(true)
    expect(JSON.stringify(ok)).toContain('"contact_creation":"none"')
    expect((await get(c.id as string)).contact_creation).toBe('none')
    const refused = await rpc('owner', { id: theirs.id, contact_creation: 'none' })
    expect(refused.result.isError).toBe(true)
    expect(JSON.stringify(refused)).toContain('not_connection_owner')
  })
})
