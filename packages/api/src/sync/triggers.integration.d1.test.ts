import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { SCOPE_POLICY, type Role } from '../auth/roles.js'
import { parseGmailConfig } from '../connections/config.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { FAKE_ENDPOINTS, FAKE_GMAIL_BASE, FakeGoogle } from '../test/google.js'
import { seedGmailConnection } from '../test/gmail-sync.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { requestDueSyncs } from './cron.js'
import { requestSync, type MailSyncInstances, type MailSyncParams } from './request.js'

// [[CHN141]]: the non-push triggers on local D1: `requestSync`, `connections.sync`, the connect flow's request and the cron's selection.
const KEY = new Uint8Array(32).fill(3)
const ENV = { GOOGLE_CLIENT_ID: 'fake-client-id.apps.test', GOOGLE_CLIENT_SECRET: 'fake-client-secret', OAUTH_STATE_SECRET: 'state-secret-for-tests', CREDENTIALS_KEY: Buffer.from(KEY).toString('base64'), PUBLIC_BASE_URL: 'https://vault.test' }
const BASE = 'https://vault.test'
const MIN = 60_000

let e: Engine
let google: FakeGoogle
let now: Date
let created: Array<{ id: string; params: MailSyncParams }>
let instances: MailSyncInstances
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date('2026-11-05T10:00:00.000Z')
  google.clock = () => now.getTime()
  created = []
  instances = { create: async (o) => void created.push(o) }
})
afterEach(() => vi.restoreAllMocks())

const raw = (sql: string, ...binds: unknown[]) => e.d1!.prepare(sql).bind(...binds).run()
const deps = (over: Partial<Parameters<typeof requestSync>[0]> = {}) => ({ binding: e.binding, organizationId: e.organizationId, clock: () => now, newId: () => uuidv7(now), instances, ...over })
let n = 0
const seed = (over: { lastSyncedAt?: string | null } = {}) => {
  n++
  return seedGmailConnection(e, { key: KEY, refreshToken: google.issueRefreshToken(), sub: `sub-${n}`, mailbox: `box${n}@vault.test`, lastSyncedAt: over.lastSyncedAt ?? null })
}
const stateOf = async (id: string) => (await e.rows('mail_sync_state')).find((r) => r.connection_id === id)!

describe('requestSync (D11)', () => {
  it('writes sync_requested_at in its own unit, then creates one instance named for the connection', async () => {
    const id = await seed()
    let seenInCreate: unknown = 'unset'
    const spy: MailSyncInstances = {
      create: async (o) => {
        seenInCreate = (await stateOf(id)).sync_requested_at
        created.push(o)
      },
    }
    const out = await requestSync(deps({ instances: spy }), id)
    expect(out.requested_at).toBe(now.toISOString())
    expect((await stateOf(id)).sync_requested_at).toBe(now.toISOString())
    expect(seenInCreate).toBe(now.toISOString()) // the request was committed before the instance existed
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ connection_id: id })
    expect(created[0]!.id).toMatch(new RegExp(`^mail-sync-${id}-[0-9a-f-]{36}$`))
    expect(out.instance_id).toBe(created[0]!.id)
  })
  it('two requests make two distinct instance ids', async () => {
    const id = await seed()
    await requestSync(deps(), id)
    await requestSync(deps(), id)
    expect(new Set(created.map((c) => c.id)).size).toBe(2)
  })
  it('an instance that cannot be created leaves the request recorded (the cron will serve it) and throws', async () => {
    const id = await seed()
    await expect(requestSync(deps({ instances: { create: async () => Promise.reject(new Error('workflows down')) } }), id)).rejects.toThrow('workflows down')
    expect((await stateOf(id)).sync_requested_at).toBe(now.toISOString())
  })
})

describe('connections.sync (D43, D75)', () => {
  const app = (over: { config?: boolean; instances?: MailSyncInstances | null } = {}) => {
    const { config } = parseGmailConfig(ENV)
    return createApp({
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      clock: () => now,
      newId: () => uuidv7(now),
      gmail: { config: over.config === false ? null : config, endpoints: FAKE_ENDPOINTS, fetch: google.fetch, gmailBaseUrl: FAKE_GMAIL_BASE, ...(over.instances === null ? {} : { instances: over.instances ?? instances }) },
    })
  }
  const post = async (a: ReturnType<typeof app>, id: string, o: { scopes?: string[]; kind?: 'user' | 'agent' } = {}) => {
    const kind = o.kind ?? 'user'
    const token = mintTestUserToken({ userId: kind === 'agent' ? e.agentId : e.userId, organizationId: e.organizationId, scopes: o.scopes ?? ['connections:write'], kind })
    const res = await a.request(`${BASE}/meta/v1/connections/${id}/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    const text = await res.text()
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
  }
  const unknownId = uuidv7(new Date('2026-11-05T09:00:00.000Z'))

  it('202 { requested_at } sets sync_requested_at and creates exactly one instance', async () => {
    const id = await seed()
    const res = await post(app(), id)
    expect(res).toEqual({ status: 202, body: { requested_at: now.toISOString() } })
    expect((await stateOf(id)).sync_requested_at).toBe(now.toISOString())
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ connection_id: id })
    expect(created[0]!.id).toMatch(new RegExp(`^mail-sync-${id}-[0-9a-f-]{36}$`))
  })
  it('an agent is refused: without the scope 403 insufficient_scope; holding it, 403 user_required; nothing is requested', async () => {
    const id = await seed()
    const without = await post(app(), id, { kind: 'agent', scopes: ['connections:read'] })
    expect([without.status, without.body.error.code]).toEqual([403, 'insufficient_scope'])
    const holding = await post(app(), id, { kind: 'agent', scopes: ['connections:write'] })
    expect([holding.status, holding.body.error.code]).toEqual([403, 'user_required'])
    expect(created).toEqual([])
    expect((await stateOf(id)).sync_requested_at).toBeNull()
  })
  it('the scope is refused before anything else: an agent gets 403 for an unknown id on an unconfigured deployment', async () => {
    const res = await post(app({ config: false }), unknownId, { kind: 'agent', scopes: ['connections:read'] })
    expect(res.status).toBe(403)
  })
  it('501 provider_not_configured when Gmail is unconfigured, and when there is no MAIL_SYNC binding; before the 404', async () => {
    const id = await seed()
    for (const a of [app({ config: false }), app({ instances: null })]) {
      const res = await post(a, id)
      expect([res.status, res.body.error.code]).toEqual([501, 'provider_not_configured'])
      expect([(await post(a, unknownId)).status]).toEqual([501])
    }
    expect(created).toEqual([])
    expect((await stateOf(id)).sync_requested_at).toBeNull()
  })
  it('404 not_found for an unknown id and for a soft-deleted connection', async () => {
    const id = await seed()
    expect((await post(app(), unknownId)).body.error.code).toBe('not_found')
    const del = await app().request(`${BASE}/meta/v1/connections/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ['connections:write'], kind: 'user' })}` } })
    expect(del.status).toBe(204)
    const res = await post(app(), id)
    expect([res.status, res.body.error.code]).toEqual([404, 'not_found'])
    expect(created).toEqual([])
  })
  it('409 connection_inactive for reauth_required and suspended, writing nothing', async () => {
    const id = await seed()
    for (const status of ['reauth_required', 'suspended']) {
      await raw('update channel_connections set status = ?', status)
      const res = await post(app(), id)
      expect([res.status, res.body.error.code]).toEqual([409, 'connection_inactive'])
    }
    expect(created).toEqual([])
    expect((await stateOf(id)).sync_requested_at).toBeNull()
  })
  it('an instance that cannot be created is 503 sync_unavailable, with the request recorded', async () => {
    const id = await seed()
    const res = await post(app({ instances: { create: async () => Promise.reject(new Error('workflows down: secret detail')) } }), id)
    expect([res.status, res.body.error.code]).toEqual([503, 'sync_unavailable'])
    expect(JSON.stringify(res.body)).not.toContain('secret detail')
    expect((await stateOf(id)).sync_requested_at).toBe(now.toISOString())
  })
})

describe('the connect flow requests a sync after its unit commits (D9, D55)', () => {
  const roles = new Map<string, Role | null>([['user_engine_1', 'owner']])
  const build = (inst: MailSyncInstances | undefined) => {
    const { config, problems } = parseGmailConfig(ENV)
    return createApp({
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      clock: () => now,
      newId: () => uuidv7(now),
      gmail: { config, problems, endpoints: FAKE_ENDPOINTS, fetch: google.fetch, gmailBaseUrl: FAKE_GMAIL_BASE, policy: SCOPE_POLICY, roleOf: async (s) => roles.get(s) ?? null, ...(inst ? { instances: inst } : {}) },
    })
  }
  const connect = async (a: ReturnType<typeof build>) => {
    const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ['connections:write'], kind: 'user' })
    const auth = await a.request(`${BASE}/meta/v1/connections/authorize`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) })
    const { authorize_url } = (await auth.json()) as { authorize_url: string }
    const cb = new URL(await google.consent(authorize_url, { sub: 'sub-ann', email: 'ann@example.test', historyId: '555' }))
    return a.request(cb.toString())
  }
  it('a successful callback requests exactly one sync, after the connection exists', async () => {
    let existed: number | null = null
    const inst: MailSyncInstances = {
      create: async (o) => {
        existed = (await e.rows('channel_connections')).length
        created.push(o)
      },
    }
    expect((await connect(build(inst))).status).toBe(200)
    const [conn] = await e.rows('channel_connections')
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ connection_id: conn!.id })
    expect(existed).toBe(1)
    expect((await stateOf(conn!.id as string)).sync_requested_at).toBe(now.toISOString())
  })
  it('a failed unit requests none and writes no request', async () => {
    await raw("create trigger boom_credentials before insert on channel_credentials begin select raise(abort, 'boom'); end")
    try {
      const res = await connect(build(instances))
      expect(res.status).toBe(503)
    } finally {
      await raw('drop trigger boom_credentials')
    }
    expect(created).toEqual([])
    expect(await e.rows('channel_connections')).toEqual([])
    expect(await e.rows('mail_sync_state')).toEqual([])
  })
  it('without a MAIL_SYNC binding the connection is still committed, and a line says no sync was requested', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    const res = await connect(build(undefined))
    expect(res.status).toBe(200)
    expect((await e.rows('channel_connections')).length).toBe(1)
    expect(lines.some((l) => /no sync was requested/.test(l))).toBe(true)
  })
  it('an instance that cannot be created does not undo the connect: 200, connection kept, the failure logged without detail', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    const res = await connect(build({ create: async () => Promise.reject(new Error('workflows down: secret detail')) }))
    expect(res.status).toBe(200)
    expect((await e.rows('channel_connections')).length).toBe(1)
    expect(lines.join('\n')).not.toContain('secret detail')
    expect(lines.some((l) => /sync request failed/.test(l))).toBe(true)
  })
})

describe('the cron: which connections get a request (D14, D75)', () => {
  const iso = (offsetMin: number) => new Date(now.getTime() + offsetMin * MIN).toISOString()
  const setState = (id: string, p: { success?: number | null; lease?: number | null }) =>
    raw('update mail_sync_state set last_success_at = ?, lease_until = ?, run_id = ? where connection_id = ?', p.success == null ? null : iso(p.success), p.lease == null ? null : iso(p.lease), p.lease == null ? null : 'some-run', id)
  it('requests never-synced, stale and expired-lease connections; not fresh, held-lease, non-active or soft-deleted ones', async () => {
    const never = await seed()
    const stale = await seed()
    const fresh = await seed()
    const held = await seed()
    const expired = await seed()
    const reauth = await seed()
    const gone = await seed()
    await setState(never, {})
    await setState(stale, { success: -20 })
    await setState(fresh, { success: -5 })
    await setState(held, { lease: 3 })
    await setState(expired, { success: -5, lease: -1 })
    await setState(reauth, { success: -60 })
    await setState(gone, { success: -60 })
    await raw("update channel_connections set status = 'reauth_required' where id = ?", reauth)
    await raw('update channel_connections set deleted_at = ? where id = ?', iso(-1), gone)
    const out = await requestDueSyncs(deps())
    expect([...out.requested].sort()).toEqual([never, stale, expired].sort())
    expect(out.failed).toBe(0)
    expect(created.map((c) => c.params.connection_id).sort()).toEqual([never, stale, expired].sort())
    expect((await stateOf(fresh)).sync_requested_at).toBeNull()
    expect((await stateOf(held)).sync_requested_at).toBeNull()
  })
  it('empty state: no connections is no request and no error', async () => {
    expect(await requestDueSyncs(deps())).toEqual({ requested: [], failed: 0 })
    expect(created).toEqual([])
  })
  it('one connection whose instance cannot be created does not stop the others, and is counted', async () => {
    const a = await seed()
    const b = await seed()
    let calls = 0
    const flaky: MailSyncInstances = {
      create: async (o) => {
        if (calls++ === 0) throw new Error('boom')
        created.push(o)
      },
    }
    const out = await requestDueSyncs(deps({ instances: flaky }))
    expect(out.failed).toBe(1)
    expect(out.requested).toHaveLength(1)
    expect([a, b]).toContain(out.requested[0])
  })
})
