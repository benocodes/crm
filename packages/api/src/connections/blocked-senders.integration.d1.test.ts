import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineOperation, unit } from '@vibase/storage'
import { SCOPE_POLICY, SCOPE_DESCRIPTIONS, scopesForRole } from '../auth/roles.js'
import { normalizeAgentScopes } from '../resources/agents.js'
import { createVibaseRegistry } from '../operations.js'
import { proposalMeta } from '../proposal.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { VALUE_CASES } from '../test/blocked-value-cases.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { captureSettingsRead, type CaptureSettings } from './capture-settings.js'

// [[CHN410]]: the workspace blocklist, `blocked_senders` ([[CHN406]] D8, D9, D10, D13, planner rules P1 to P4). Fixtures are direct inserts: setup bypasses the code under test.
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

const BOTH = ['blocked_senders:read', 'blocked_senders:write']
type Who = 'owner' | 'agent'
const call = async (method: string, path: string, body?: unknown, opts: { who?: Who; scopes?: string[] } = {}) => {
  const who = opts.who ?? 'owner'
  const token = mintTestUserToken({
    userId: who === 'agent' ? e.agentId : e.userId,
    organizationId: e.organizationId,
    scopes: opts.scopes ?? BOTH,
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
const PATH = '/meta/v1/blocked-senders'
const create = (body: unknown, opts: { who?: Who; scopes?: string[] } = {}) => call('POST', PATH, body, opts)
const del = (id: string, opts: { who?: Who; scopes?: string[] } = {}) =>
  call('DELETE', `${PATH}/${id}`, undefined, opts)
const list = (query = '', opts: { who?: Who; scopes?: string[] } = {}) =>
  call('GET', `${PATH}${query ? `?${query}` : ''}`, undefined, opts)
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const events = async (type?: string) =>
  (await e.events()).filter((x: any) => (type ? x.type === type : String(x.type).startsWith('blocked_sender.')))
const entry = (kind: 'address' | 'domain', value: string, over: Record<string, unknown> = {}) =>
  e.insert('blocked_senders', { kind, value, ...over })
const UNKNOWN = '0190b2c4-0000-7000-8000-00000000dead'

describe('resource semantics (D8, P2, P3)', () => {
  it('create answers 201 with the normalised record, created_by the actor; get and list return it', async () => {
    const r = await create({ kind: 'domain', value: '  Spam.Example ' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({
      organization_id: e.organizationId,
      kind: 'domain',
      value: 'spam.example',
      created_by: e.userId,
    })
    expect(Object.keys(r.body).sort()).toEqual([
      'created_at',
      'created_by',
      'id',
      'kind',
      'organization_id',
      'updated_at',
      'value',
    ])
    expect((await call('GET', `${PATH}/${r.body.id}`)).body).toEqual(r.body)
    expect((await list()).body.data).toEqual([r.body])
  })

  it('list filters by kind and by value (the value is trimmed and lowercased, then matched exactly: no wildcards)', async () => {
    await entry('domain', 'spam.example')
    await entry('domain', 'other.example')
    await entry('address', 'a@spam.example')
    const values = async (q: string) => (await list(q)).body.data.map((r: any) => r.value).sort() as string[]
    expect(await values('kind=domain')).toEqual(['other.example', 'spam.example'])
    expect(await values('kind=address')).toEqual(['a@spam.example'])
    expect(await values(`value=${encodeURIComponent(' Spam.Example ')}`)).toEqual(['spam.example'])
    expect(await values('value=example')).toEqual([])
    expect(await values('value=*.example')).toEqual([])
    expect(await values('kind=domain&value=a%40spam.example')).toEqual([])
    expect(refusal(await list('kind=other'))).toEqual([400, 'validation_error'])
  })

  it('delete is soft: deleted_at set, row kept, 204; then get is 404, list omits it and a second delete is 404', async () => {
    const r = await create({ kind: 'domain', value: 'spam.example' })
    const gone = await del(r.body.id)
    expect(gone.status).toBe(204)
    const row = (await e.rows('blocked_senders')).find((x) => x.id === r.body.id)
    expect(row?.deleted_at).not.toBeNull()
    expect(refusal(await call('GET', `${PATH}/${r.body.id}`))).toEqual([404, 'not_found'])
    expect((await list()).body.data).toEqual([])
    expect(refusal(await del(r.body.id))).toEqual([404, 'not_found'])
    expect(refusal(await del(UNKNOWN))).toEqual([404, 'not_found'])
    expect(await events('blocked_sender.deleted')).toHaveLength(1)
  })

  it('a live duplicate is 409 blocked_sender_exists naming the existing id; an address and a domain of one host coexist; a deleted entry can be created again with a new id', async () => {
    const first = await create({ kind: 'domain', value: 'spam.example' })
    const mark = (await e.events()).length
    for (const value of ['spam.example', ' SPAM.Example ']) {
      const dup = await create({ kind: 'domain', value })
      expect(refusal(dup)).toEqual([409, 'blocked_sender_exists'])
      expect(dup.body.error.message).toContain(first.body.id)
    }
    const addr = await create({ kind: 'address', value: 'x@spam.example' })
    expect(addr.status).toBe(201)
    expect(refusal(await create({ kind: 'address', value: 'X@Spam.Example' }))).toEqual([409, 'blocked_sender_exists'])
    // the same text cannot be both kinds: an address needs an @, a domain has none
    expect(refusal(await create({ kind: 'address', value: 'spam.example' }))).toEqual([400, 'validation_error'])
    expect(refusal(await create({ kind: 'domain', value: 'x@spam.example' }))).toEqual([400, 'validation_error'])
    expect((await e.events()).length).toBe(mark + 1)
    await del(first.body.id)
    const again = await create({ kind: 'domain', value: 'spam.example' })
    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(first.body.id)
    expect((await e.rows('blocked_senders')).filter((r) => r.value === 'spam.example')).toHaveLength(2)
  })

  it('drift: a duplicate that lands between plan and write is refused by the unique index (409 conflict): one live row, no event', async () => {
    e.betweenPlanAndCommit(async () => void (await entry('domain', 'raced.example')))
    const r = await create({ kind: 'domain', value: 'Raced.Example' })
    expect(refusal(r)).toEqual([409, 'conflict'])
    expect((await e.rows('blocked_senders')).filter((x) => x.deleted_at === null)).toHaveLength(1)
    expect(await events()).toEqual([])
  })

  it('drift: a delete between plan and write leaves the row to the other delete: one deleted_at, one event, the loser is refused', async () => {
    const row = await create({ kind: 'domain', value: 'spam.example' })
    const mark = (await events()).length
    e.betweenPlanAndCommit(async () => {
      await e.update('blocked_senders', row.body.id, { deleted_at: SEED_AT })
    })
    const r = await del(row.body.id)
    expect([404, 409]).toContain(r.status)
    const stored = (await e.rows('blocked_senders')).find((x) => x.id === row.body.id)
    expect(stored?.deleted_at).toBe(SEED_AT)
    expect((await events()).length).toBe(mark)
  })
})

describe('authority (D9, P1)', () => {
  it('a member (read only) lists and gets but cannot create or delete', async () => {
    const row = await entry('domain', 'spam.example')
    const read = { scopes: ['blocked_senders:read'] }
    expect((await list('', read)).status).toBe(200)
    expect((await call('GET', `${PATH}/${row.id}`, undefined, read)).status).toBe(200)
    expect(refusal(await create({ kind: 'domain', value: 'x.example' }, read))).toEqual([403, 'insufficient_scope'])
    expect(refusal(await del(row.id as string, read))).toEqual([403, 'insufficient_scope'])
    expect(refusal(await list('', { scopes: [] }))).toEqual([403, 'insufficient_scope'])
    expect(await e.rows('blocked_senders')).toHaveLength(1)
    expect(await events()).toEqual([])
  })

  it('an owner creates and deletes; an agent holding read lists', async () => {
    const r = await create({ kind: 'domain', value: 'spam.example' })
    expect(r.status).toBe(201)
    const asAgent = await list('', { who: 'agent', scopes: ['blocked_senders:read'] })
    expect(asAgent.status).toBe(200)
    expect(asAgent.body.data).toHaveLength(1)
    expect((await del(r.body.id)).status).toBe(204)
  })

  it('SCOPE_POLICY and the role mirror: read is for members and agents, write is for owners only and cannot be granted to an agent', () => {
    expect(SCOPE_POLICY['blocked_senders:read']).toEqual({ member: true, agentGrantable: true })
    expect(SCOPE_POLICY['blocked_senders:write']).toEqual({ member: false, agentGrantable: false })
    expect(SCOPE_POLICY['blocked_senders:request_approval']).toBeUndefined()
    const declared = createVibaseRegistry().declaredScopes()
    expect(declared).toContain('blocked_senders:read')
    expect(declared).toContain('blocked_senders:write')
    expect(declared).not.toContain('blocked_senders:request_approval')
    const member = scopesForRole('member', declared).toStrings()
    expect(member).toContain('blocked_senders:read')
    expect(member).not.toContain('blocked_senders:write')
    expect(scopesForRole('owner', declared).toStrings()).toEqual(expect.arrayContaining(BOTH))
    expect(() => normalizeAgentScopes(['blocked_senders:read'])).not.toThrow()
    expect(() => normalizeAgentScopes(['blocked_senders:write'])).toThrow(/not grantable/)
    expect(SCOPE_DESCRIPTIONS['blocked_senders:read']).toBeTruthy()
    expect(SCOPE_DESCRIPTIONS['blocked_senders:write']).toBeTruthy()
  })

  it('an agent actor with the write scope forced through the token is 403 user_required on create and delete', async () => {
    const row = await entry('domain', 'spam.example')
    expect(refusal(await create({ kind: 'domain', value: 'x.example' }, { who: 'agent' }))).toEqual([
      403,
      'user_required',
    ])
    expect(refusal(await del(row.id as string, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect(await e.rows('blocked_senders')).toHaveLength(1)
    expect((await e.rows('blocked_senders'))[0]!.deleted_at).toBeNull()
    expect(await events()).toEqual([])
  })

  it('is not proposable: an action request naming it is refused', async () => {
    const reg = createVibaseRegistry()
    for (const name of ['blocked_senders.create', 'blocked_senders.delete']) {
      const decl = reg.get(name)
      expect(decl, name).toBeDefined()
      expect(proposalMeta(decl!).eligible).toBe(false)
    }
    const res = await call(
      'POST',
      '/api/v1/action-requests',
      { operation: 'blocked_senders.create', arguments: { kind: 'domain', value: 'x.example' }, reason: 'x' },
      { scopes: [...BOTH, 'action_requests:read'] },
    )
    expect(refusal(res)).toEqual([400, 'operation_not_proposable'])
  })

  it('refusal order: scope, then user_required, then the body (400), then the plan (404 / 409)', async () => {
    const row = await entry('domain', 'spam.example')
    // each input fails two checks; the earlier check in the order wins
    expect(refusal(await create({ kind: 'nope' }, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect(refusal(await create({ kind: 'domain', value: 'spam.example' }, { who: 'agent' }))).toEqual([
      403,
      'user_required',
    ])
    expect(refusal(await create({ kind: 'nope' }, { who: 'agent', scopes: ['blocked_senders:read'] }))).toEqual([
      403,
      'insufficient_scope',
    ])
    // an owner with a body that is malformed and also duplicates a live entry: the body is checked first
    expect(refusal(await create({ kind: 'domain', value: 'spam.example', extra: 1 }))).toEqual([
      400,
      'validation_error',
    ])
    expect(refusal(await create({ kind: 'domain', value: ' Spam.Example. ' }))).toEqual([400, 'validation_error'])
    expect(refusal(await create({ kind: 'domain', value: 'spam.example' }))).toEqual([409, 'blocked_sender_exists'])
    expect(refusal(await del(UNKNOWN, { who: 'agent' }))).toEqual([403, 'user_required'])
    expect((await e.rows('blocked_senders')).filter((r) => r.id === row.id)).toHaveLength(1)
    expect(await events()).toEqual([])
  })
})

describe('validation (P4): the matrix', () => {
  const bad = async (body: unknown, needle?: string | RegExp) => {
    const res = await create(body)
    expect(refusal(res), JSON.stringify(body).slice(0, 80)).toEqual([400, 'validation_error'])
    expect(res.body.error.code).not.toBe('invalid_identity')
    if (needle) expect(res.body.error.message).toMatch(needle)
    return res
  }

  it('an empty body, an unknown field and a kind other than address or domain are 400 validation_error', async () => {
    await bad({})
    await bad({ kind: 'domain', value: 'a.example', note: 'x' })
    await bad({ kind: 'sender', value: 'a.example' })
    await bad({ kind: 'domain' })
    await bad({ value: 'a.example' })
    expect(await e.rows('blocked_senders')).toEqual([])
    expect(await events()).toEqual([])
  })

  it.each(VALUE_CASES)('%s %j through create', async (kind, input, stored) => {
    if (stored === null) {
      const res = await bad({ kind, value: input }, /value/)
      expect(res.body.error.message).not.toMatch(/invalid_identity/)
      expect(await e.rows('blocked_senders')).toEqual([])
    } else {
      const res = await create({ kind, value: input })
      expect([res.status, res.body.value]).toEqual([201, stored])
      expect((await e.rows('blocked_senders'))[0]).toMatchObject({ kind, value: stored })
    }
  })

  it.each(VALUE_CASES)('%s %j answers the same through connections.update', async (kind, input, stored) => {
    const identity = await e.insert('identities', {
      kind: 'email',
      value: 'own@vibase.test',
      contact_id: null,
      own: true,
    })
    const c = await e.insert('connections', {
      provider: 'google',
      account_id: 'sub-1',
      identity_id: identity.id,
      owner_id: e.userId,
      status: 'active',
      granted_scopes: ['openid'],
      connected_at: SEED_AT,
    })
    const res = await call(
      'PATCH',
      `/meta/v1/connections/${c.id}`,
      { blocked_senders: [{ kind, value: input }] },
      {
        scopes: ['connections:read', 'connections:write'],
      },
    )
    if (stored === null) expect(refusal(res)).toEqual([400, 'validation_error'])
    else expect([res.status, res.body.blocked_senders]).toEqual([200, [{ kind, value: stored }]])
  })
})

describe('events (D10)', () => {
  it('one blocked_sender.created per create (after equals the record) and one blocked_sender.deleted per delete, none on a refusal', async () => {
    const r = await create({ kind: 'domain', value: 'spam.example' })
    let created = await events('blocked_sender.created')
    expect(created).toHaveLength(1)
    expect(created[0]!.before).toBeNull()
    expect(created[0]!.after).toEqual(r.body)
    expect(created[0]!.actor_id).toBe(e.userId)
    expect(created[0]!.resource_type).toBe('blocked_sender')
    expect(created[0]!.resource_id).toBe(r.body.id)
    await create({ kind: 'domain', value: 'spam.example' }) // 409
    await create({ kind: 'domain', value: 'bad.' }) // 400
    await create({ kind: 'domain', value: 'agent.example' }, { who: 'agent' }) // 403
    created = await events('blocked_sender.created')
    expect(created).toHaveLength(1)
    expect((await del(r.body.id)).status).toBe(204)
    await del(r.body.id) // 404
    const deleted = await events('blocked_sender.deleted')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.before).toEqual(r.body)
    expect(deleted[0]!.after).toBeNull()
    expect(deleted[0]!.resource_id).toBe(r.body.id)
    expect(await events('blocked_sender.updated')).toEqual([])
  })

  it('on the feed, blocked_senders:read shows both events and its absence hides them', async () => {
    const r = await create({ kind: 'domain', value: 'spam.example' })
    await del(r.body.id)
    const feed = async (scopes: string[]) =>
      ((await call('GET', '/api/v1/events?limit=200', undefined, { scopes })).body.data as { type: string }[])
        .map((x) => x.type)
        .filter((t) => t.startsWith('blocked_sender.'))
        .sort()
    expect(await feed(['events:read', 'blocked_senders:read'])).toEqual([
      'blocked_sender.created',
      'blocked_sender.deleted',
    ])
    expect(await feed(['events:read', 'tags:read'])).toEqual([])
  })
})

describe('effective settings (D11): captureSettingsRead sees what the operation wrote', () => {
  const run = async (connectionId: string): Promise<CaptureSettings | null> =>
    (
      await e.run(
        defineOperation<CaptureSettings | null>({
          name: 'test.capture_settings',
          mutates: false,
          reads: (qc) => ({ settings: captureSettingsRead(qc, e.organizationId, connectionId).read }),
          build: (found, qc) =>
            unit({
              steps: [],
              events: [],
              decode: () => captureSettingsRead(qc, e.organizationId, connectionId).decode(found.maybe('settings')),
            }),
        }),
      )
    ).value
  let n = 0
  const connection = async () => {
    n++
    const identity = await e.insert('identities', {
      kind: 'email',
      value: `own-${n}@vibase.test`,
      contact_id: null,
      own: true,
    })
    return e.insert('connections', {
      provider: 'google',
      account_id: `sub-${n}`,
      identity_id: identity.id,
      owner_id: e.userId,
      status: 'active',
      granted_scopes: ['openid'],
      connected_at: SEED_AT,
    })
  }

  it('the live workspace entries are unioned with the connection’s own, once each, sorted and split by kind; a workspace delete drops the entry', async () => {
    const c = await connection()
    const a = await create({ kind: 'domain', value: 'b.example' })
    await create({ kind: 'domain', value: 'a.example' })
    await create({ kind: 'address', value: 'x@both.example' })
    const gone = await create({ kind: 'domain', value: 'gone.example' })
    await del(gone.body.id)
    const patched = await call(
      'PATCH',
      `/meta/v1/connections/${c.id}`,
      {
        blocked_senders: [
          { kind: 'domain', value: 'b.example' },
          { kind: 'domain', value: 'z.example' },
          { kind: 'address', value: 'x@both.example' },
        ],
      },
      { scopes: ['connections:read', 'connections:write'] },
    )
    expect(patched.status).toBe(200)
    const s = (await run(c.id as string))!
    expect(s.blocked_domains).toEqual(['a.example', 'b.example', 'z.example'])
    expect(s.blocked_addresses).toEqual(['x@both.example'])
    await del(a.body.id)
    expect((await run(c.id as string))!.blocked_domains).toEqual(['a.example', 'b.example', 'z.example'])
    const b = (await list('value=b.example')).body.data
    expect(b).toEqual([]) // b.example is no longer a workspace entry, but the connection's own stays
    expect((await run(c.id as string))!.blocked_domains).toContain('b.example')
    // the workspace entry that was the only source drops out
    const only = await create({ kind: 'domain', value: 'only.example' })
    expect((await run(c.id as string))!.blocked_domains).toContain('only.example')
    await del(only.body.id)
    expect((await run(c.id as string))!.blocked_domains).not.toContain('only.example')
  })
})

describe('surfaces (D13)', () => {
  it('OpenAPI lists GET and POST on the collection and GET and DELETE on the member, and no PATCH', async () => {
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const col = meta.paths['/meta/v1/blocked-senders']
    const mem = meta.paths['/meta/v1/blocked-senders/{id}']
    expect(Object.keys(col).sort()).toEqual(['get', 'post'])
    expect(Object.keys(mem).sort()).toEqual(['delete', 'get'])
    const schema = col.post.requestBody.content['application/json'].schema
    expect(Object.keys(schema.properties).sort()).toEqual(['kind', 'value'])
    expect(schema.additionalProperties).toBe(false)
    expect(col.post.description).toMatch(/vibase blocked-senders create/)
    expect(col.post.description).toMatch(/--kind domain --value/)
  })

  it('the MCP tools exist for the four operations and answer as REST does for the same actor', async () => {
    const rpc = async (who: Who, method: string, params: unknown = {}) => {
      const token = mintTestUserToken({
        userId: who === 'agent' ? e.agentId : e.userId,
        organizationId: e.organizationId,
        scopes: BOTH,
        kind: who === 'agent' ? 'agent' : 'user',
      })
      return (await (
        await app.request('/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json()) as any
    }
    const tools = (await rpc('owner', 'tools/list')).result.tools.map((t: any) => t.name)
    for (const name of [
      'blocked_senders_list',
      'blocked_senders_get',
      'blocked_senders_create',
      'blocked_senders_delete',
    ])
      expect(tools).toContain(name)
    expect(tools).not.toContain('blocked_senders_update')
    const call_ = (who: Who, name: string, args: unknown) => rpc(who, 'tools/call', { name, arguments: args })
    const made = await call_('owner', 'blocked_senders_create', { kind: 'domain', value: 'Spam.Example' })
    expect(made.result.isError, JSON.stringify(made)).not.toBe(true)
    expect(JSON.stringify(made)).toContain('"value":"spam.example"')
    const id = (await list()).body.data[0].id
    expect(JSON.stringify(await call_('owner', 'blocked_senders_list', {}))).toContain('spam.example')
    expect(JSON.stringify(await call_('owner', 'blocked_senders_get', { id }))).toContain(id)
    const refused = await call_('agent', 'blocked_senders_create', { kind: 'domain', value: 'x.example' })
    expect(refused.result.isError).toBe(true)
    expect(JSON.stringify(refused)).toContain('user_required')
    const dup = await call_('owner', 'blocked_senders_create', { kind: 'domain', value: 'spam.example' })
    expect(dup.result.isError).toBe(true)
    expect(JSON.stringify(dup)).toContain('blocked_sender_exists')
    expect((await call_('owner', 'blocked_senders_delete', { id })).result.isError).not.toBe(true)
    expect((await list()).body.data).toEqual([])
  })
})
