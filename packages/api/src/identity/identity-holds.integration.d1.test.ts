import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE573]] D11 (a live connection holds its identity) and D12 (`own` is set by people), over REST on D1.
const registry = createVibaseRegistry()
const ALL = registry.declaredScopes()
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(() => e.close())
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

type As = 'user' | 'agent'
const call = async (as: As, method: string, path: string, body?: unknown) => {
  const token = mintTestUserToken({
    userId: as === 'user' ? e.userId : e.agentId,
    organizationId: e.organizationId,
    scopes: as === 'user' ? ALL : ['contacts:read', 'contacts:write'],
    kind: as,
  })
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null }
}
const codeOf = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]

let n = 0
const identity = (own: boolean, contactId: string | null = null) =>
  e.insert('identities', { kind: 'email', value: `i${++n}@h.test`, contact_id: own ? null : contactId, own })
const contact = (name = 'C') => e.insert('contacts', { name })
const connect = (identityId: string, over: Record<string, unknown> = {}) =>
  e.insert('connections', {
    provider: 'google',
    account_id: `acct-${++n}`,
    identity_id: identityId,
    owner_id: e.userId,
    status: 'active',
    granted_scopes: [],
    connected_at: '2026-11-05T09:00:00.000Z',
    ...over,
  })
const snapshot = async () => ({
  identities: JSON.stringify(await e.rows('identities')),
  events: (await e.events()).length,
})

describe('D11: the hold (P1, P2)', () => {
  for (const status of ['active', 'reauth_required', 'suspended'] as const) {
    it(`a ${status} connection holds its identity: delete and update of contact_id/own are 409 identity_in_use, nothing written, no connection id named`, async () => {
      const own = await identity(true)
      const conn = await connect(own.id as string, { status })
      const c = await contact()
      const before = await snapshot()
      const del = await call('user', 'DELETE', `/api/v1/identities/${own.id}`)
      const toContact = await call('user', 'PATCH', `/api/v1/identities/${own.id}`, { contact_id: c.id })
      for (const r of [del, toContact]) {
        expect(codeOf(r)).toEqual([409, 'identity_in_use'])
        expect(r.text).not.toContain(conn.id as string)
      }
      expect(await snapshot()).toEqual(before)
    })
  }

  it('a contact-owned identity a connection references is held against own: true as well', async () => {
    const c = await contact()
    const i = await identity(false, c.id as string)
    await connect(i.id as string)
    const before = await snapshot()
    expect(codeOf(await call('user', 'PATCH', `/api/v1/identities/${i.id}`, { own: true }))).toEqual([
      409,
      'identity_in_use',
    ])
    expect(await snapshot()).toEqual(before)
  })

  it('empty state: an identity with no connection, or only a disconnected one, is deleted and changed freely', async () => {
    const a = await identity(true)
    expect((await call('user', 'DELETE', `/api/v1/identities/${a.id}`)).status).toBe(204)
    const b = await identity(true)
    await connect(b.id as string, { deleted_at: '2026-11-06T09:00:00.000Z' })
    const c = await contact()
    expect((await call('user', 'PATCH', `/api/v1/identities/${b.id}`, { contact_id: c.id })).status).toBe(200)
    const d = await identity(true)
    await connect(d.id as string, { deleted_at: '2026-11-06T09:00:00.000Z' })
    expect((await call('user', 'DELETE', `/api/v1/identities/${d.id}`)).status).toBe(204)
  })

  it('P2: a no-op update (own: true on an own identity, a person) is not refused by the hold; a held contact identity re-sent its own contact too', async () => {
    const own = await identity(true)
    await connect(own.id as string)
    const noop = await call('user', 'PATCH', `/api/v1/identities/${own.id}`, { own: true })
    expect([noop.status, noop.body.own]).toEqual([200, true])
    const c = await contact()
    const mine = await identity(false, c.id as string)
    await connect(mine.id as string)
    expect((await call('user', 'PATCH', `/api/v1/identities/${mine.id}`, { contact_id: c.id })).status).toBe(200)
  })

  it('P2: 403 before 409: an agent sending own: true or an own-to-contact change on a held identity gets 403 user_required', async () => {
    const own = await identity(true)
    await connect(own.id as string)
    const c = await contact()
    expect(codeOf(await call('agent', 'PATCH', `/api/v1/identities/${own.id}`, { own: true }))).toEqual([
      403,
      'user_required',
    ])
    expect(codeOf(await call('agent', 'PATCH', `/api/v1/identities/${own.id}`, { contact_id: c.id }))).toEqual([
      403,
      'user_required',
    ])
    // an agent's delete of a held identity is the hold, not 403
    expect(codeOf(await call('agent', 'DELETE', `/api/v1/identities/${own.id}`))).toEqual([409, 'identity_in_use'])
  })

  it('drift: a connection committed between plan and commit refuses a delete, nothing written', async () => {
    const own = await identity(true)
    const before = await snapshot()
    e.betweenPlanAndCommit(async () => void (await connect(own.id as string)))
    const r = await call('user', 'DELETE', `/api/v1/identities/${own.id}`)
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict'])
    expect((await e.rows('identities')).find((x) => x.id === own.id)!.deleted_at).toBeNull()
    expect((await e.events()).length).toBe(before.events)
  })

  it('drift: a connection committed between plan and commit refuses a change of contact_id, nothing written', async () => {
    const own = await identity(true)
    const c = await contact()
    const before = await snapshot()
    e.betweenPlanAndCommit(async () => void (await connect(own.id as string)))
    const r = await call('user', 'PATCH', `/api/v1/identities/${own.id}`, { contact_id: c.id })
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict'])
    expect(await snapshot()).toEqual(before)
  })
})

describe('D12: own is set by people (P3)', () => {
  it('an agent: create own: true, update own: true and update own-to-contact are 403 user_required, nothing written', async () => {
    const c = await contact()
    const unowned = await identity(false, c.id as string)
    const own = await identity(true)
    const before = await snapshot()
    const rs = [
      await call('agent', 'POST', '/api/v1/identities', { kind: 'email', value: 'new@h.test', own: true }),
      await call('agent', 'PATCH', `/api/v1/identities/${unowned.id}`, { own: true }),
      await call('agent', 'PATCH', `/api/v1/identities/${own.id}`, { contact_id: c.id }),
    ]
    for (const r of rs) expect(codeOf(r)).toEqual([403, 'user_required'])
    expect(await snapshot()).toEqual(before)
  })

  it('an agent still creates and re-points contact identities', async () => {
    const c = await contact('A')
    const d = await contact('B')
    const made = await call('agent', 'POST', '/api/v1/identities', {
      kind: 'email',
      value: 'ok@h.test',
      contact_id: c.id,
    })
    expect(made.status).toBe(201)
    expect((await call('agent', 'PATCH', `/api/v1/identities/${made.body.id}`, { contact_id: d.id })).status).toBe(200)
    expect((await call('agent', 'DELETE', `/api/v1/identities/${made.body.id}`)).status).toBe(204)
  })

  it('a person: the same three writes succeed on unheld identities', async () => {
    const c = await contact()
    const made = await call('user', 'POST', '/api/v1/identities', { kind: 'email', value: 'mine@h.test', own: true })
    expect([made.status, made.body.own]).toEqual([201, true])
    const unowned = await identity(false, c.id as string)
    expect((await call('user', 'PATCH', `/api/v1/identities/${unowned.id}`, { own: true })).body.own).toBe(true)
    const r = await call('user', 'PATCH', `/api/v1/identities/${unowned.id}`, { contact_id: c.id })
    expect([r.status, r.body.own, r.body.contact_id]).toEqual([200, false, c.id])
  })
})

describe('descriptions', () => {
  it('the four operations name their new codes', () => {
    const text = (name: string) =>
      String((registry.get(name) as { description?: string } | undefined)?.description ?? '')
    expect(text('identities.create')).toContain('user_required')
    expect(text('identities.update')).toContain('user_required')
    expect(text('identities.update')).toContain('identity_in_use')
    expect(text('identities.delete')).toContain('identity_in_use')
    expect(text('api_keys.create')).toContain('delegated_agent')
  })
})
