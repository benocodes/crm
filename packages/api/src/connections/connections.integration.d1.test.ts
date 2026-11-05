import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY_REFERENCES } from '../identity/merge.js'
import { SCOPE_DESCRIPTIONS, SCOPE_POLICY, isAgentGrantable } from '../auth/roles.js'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { parseGmailConfig } from './config.js'

// CHN140 D20, D22, D41, D42, D43: the `connections` resource (list, get, delete), its scopes, its secrecy and the Postgres answer.
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

const call = async (method: string, path: string, scopes: string[], kind: 'user' | 'agent' = 'user', body?: unknown) => {
  const token = mintTestUserToken({ userId: kind === 'agent' ? e.agentId : e.userId, organizationId: e.organizationId, scopes, kind })
  const res = await app.request(`https://vault.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null }
}
let n = 0
async function seedConnection(over: Record<string, unknown> = {}) {
  n++
  const identity = await e.insert('identities', { kind: 'email', value: `own-${n}@vault.test`, contact_id: null, own: true })
  return e.insert('channel_connections', { provider: 'google', account_id: `sub-${n}`, identity_id: identity.id, owner_id: e.userId, status: 'active', granted_scopes: ['openid', 'email'], connected_at: SEED_AT, ...over })
}
async function seedMachinery(connectionId: string, opts: { synced?: string; errorCode?: string } = {}) {
  await e.insert('channel_credentials', { connection_id: connectionId, refresh_token_ciphertext: 'c2VhbGVk-SENTINEL-CIPHERTEXT', key_version: 1 })
  await e.insert('gmail_watches', { connection_id: connectionId, mailbox: `m-${connectionId.slice(-6)}@vault.test`, expires_at: '2026-11-12T00:00:00.000Z' })
  await e.insert('mail_sync_state', { connection_id: connectionId, ...(opts.errorCode ? { last_error_code: opts.errorCode, last_error_at: SEED_AT } : {}) })
  await e.insert('mail_sync_cursors', { connection_id: connectionId, history_id: '123', ...(opts.synced ? { last_synced_at: opts.synced } : {}) })
}

describe('connections.list and connections.get (D42)', () => {
  it('a connection that has never synced has last_synced_at and last_error_code null (empty state), and no credential field', async () => {
    const c = await seedConnection()
    await e.insert('mail_sync_state', { connection_id: c.id })
    await e.insert('mail_sync_cursors', { connection_id: c.id, history_id: '1' })
    const got = await call('GET', `/meta/v1/connections/${c.id}`, ['connections:read'])
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ id: c.id, provider: 'google', account_id: c.account_id, identity_id: c.identity_id, owner_id: e.userId, status: 'active', granted_scopes: ['openid', 'email'], last_synced_at: null, last_error_code: null, created_by: e.userId })
    expect(Object.keys(got.body).sort()).toEqual(['account_id', 'connected_at', 'created_at', 'created_by', 'granted_scopes', 'id', 'identity_id', 'last_error_code', 'last_synced_at', 'organization_id', 'owner_id', 'provider', 'status', 'updated_at'])
  })

  it('joins the cursor\'s last_synced_at and the state\'s last_error_code on get and on list', async () => {
    const c = await seedConnection()
    await seedMachinery(c.id as string, { synced: '2026-11-05T09:30:00.000Z', errorCode: 'rate_limited' })
    const got = await call('GET', `/meta/v1/connections/${c.id}`, ['connections:read'])
    expect(got.body).toMatchObject({ last_synced_at: '2026-11-05T09:30:00.000Z', last_error_code: 'rate_limited' })
    const list = await call('GET', '/meta/v1/connections', ['connections:read'])
    expect(list.body.data).toEqual([expect.objectContaining({ id: c.id, last_synced_at: '2026-11-05T09:30:00.000Z', last_error_code: 'rate_limited' })])
  })

  it('an unknown id is 404, a deleted connection is not listed, and the routes live on /meta/v1 only', async () => {
    const c = await seedConnection()
    expect((await call('GET', '/meta/v1/connections/0190b2c4-0000-7000-8000-00000000dead', ['connections:read'])).status).toBe(404)
    expect((await call('GET', '/api/v1/connections', ['connections:read'])).status).toBe(404)
    await e.update('channel_connections', c.id as string, { deleted_at: SEED_AT })
    expect((await call('GET', '/meta/v1/connections', ['connections:read'])).body.data).toEqual([])
  })

  it('has no create and no update route: a connection exists only through the callback', async () => {
    const c = await seedConnection()
    expect((await call('POST', '/meta/v1/connections', ['connections:write'], 'user', { provider: 'google' })).status).toBe(404)
    expect((await call('PATCH', `/meta/v1/connections/${c.id}`, ['connections:write'], 'user', { status: 'active' })).status).toBe(404)
  })
})

describe('connections.delete (D26, D56)', () => {
  it('soft-deletes, removes the credential, cursor, state and watch rows, keeps sources and captured messages, and emits connection.deleted', async () => {
    const c = await seedConnection()
    await seedMachinery(c.id as string)
    const captured = await runCapture(e, { connection_id: c.id as string, messages: [captureMessage(e.organizationId)] })
    expect(await e.rows('message_sources')).toHaveLength(1)
    const res = await call('DELETE', `/meta/v1/connections/${c.id}`, ['connections:write'])
    expect(res.status).toBe(204)
    for (const t of ['channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors']) expect(await e.rows(t), t).toEqual([])
    expect((await e.rows('channel_connections'))[0]).toMatchObject({ id: c.id, deleted_at: expect.any(String) })
    expect(await e.rows('message_sources')).toHaveLength(1)
    expect(await e.rows('thread_sources')).toHaveLength(1)
    expect((await e.rows('messages')).map((m) => m.id)).toEqual([captured.value.captured[0]!.message_id])
    const ev = (await e.rows('events')).filter((x) => x.type === 'connection.deleted')
    expect(ev).toEqual([expect.objectContaining({ resource_id: c.id, actor_id: e.userId, after: null })])
    expect(JSON.stringify(ev[0]!.before)).not.toContain('CIPHERTEXT')
  })

  it('deleting one connection leaves another connection\'s machinery alone', async () => {
    const a = await seedConnection()
    const b = await seedConnection()
    await seedMachinery(a.id as string)
    await seedMachinery(b.id as string)
    expect((await call('DELETE', `/meta/v1/connections/${a.id}`, ['connections:write'])).status).toBe(204)
    for (const t of ['channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors']) expect((await e.rows(t)).map((r) => r.connection_id), t).toEqual([b.id])
  })

  it('refuses without connections:write (an agent with read only), and deleting twice is 404', async () => {
    const c = await seedConnection()
    expect((await call('DELETE', `/meta/v1/connections/${c.id}`, ['connections:read'], 'agent')).status).toBe(403)
    expect((await call('DELETE', `/meta/v1/connections/${c.id}`, ['connections:write'])).status).toBe(204)
    expect((await call('DELETE', `/meta/v1/connections/${c.id}`, ['connections:write'])).status).toBe(404)
  })
})

describe('scopes (D20)', () => {
  it('connections:read is agent-grantable, connections:write is human-only; both are declared and described for the Clerk mirror', () => {
    expect(isAgentGrantable('connections:read')).toBe(true)
    expect(isAgentGrantable('connections:write')).toBe(false)
    expect(SCOPE_POLICY['connections:read']).toEqual({ member: true, agentGrantable: true })
    expect(SCOPE_POLICY['connections:write']).toEqual({ member: true, agentGrantable: false })
    const declared = createVaultRegistry().declaredScopes()
    expect(declared).toEqual(expect.arrayContaining(['connections:read', 'connections:write']))
    for (const s of ['connections:read', 'connections:write']) expect(SCOPE_DESCRIPTIONS[s]?.length, s).toBeGreaterThan(10)
  })

  it('an agent cannot be granted connections:write: scope_not_grantable', async () => {
    const res = await call('POST', '/meta/v1/agents', ['agents:write'], 'user', { name: 'sneaky', scopes: ['connections:write'] })
    expect([res.status, res.body.error.code]).toEqual([400, 'scope_not_grantable'])
    expect((await call('POST', '/meta/v1/agents', ['agents:write'], 'user', { name: 'reader', scopes: ['connections:read'] })).status).toBe(201)
  })

  it('an agent (an API key) is refused connections.authorize, even holding the scope; and an agent with connections:read can list', async () => {
    const auth = createApp({
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      gmail: { config: parseGmailConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', OAUTH_STATE_SECRET: 'o', CREDENTIALS_KEY: Buffer.alloc(32).toString('base64') }).config },
    })
    const token = (scopes: string[]) => mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
    const post = (scopes: string[]) => auth.request('https://vault.test/meta/v1/connections/authorize', { method: 'POST', headers: { authorization: `Bearer ${token(scopes)}`, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) })
    expect((await post(['connections:read'])).status).toBe(403)
    const withWrite = await post(['connections:write'])
    expect(withWrite.status).toBe(403)
    expect(((await withWrite.json()) as any).error.code).toBe('user_required')
    expect((await call('GET', '/meta/v1/connections', ['connections:read'], 'agent')).status).toBe(200)
    expect((await call('GET', '/meta/v1/connections', ['tasks:read'], 'agent')).status).toBe(403)
  })

  it('authorize rejects a provider other than google and a body with other keys (validation at the route)', async () => {
    const res = await call('POST', '/meta/v1/connections/authorize', ['connections:write'], 'user', { provider: 'microsoft' })
    expect([res.status, res.body.error.code]).toEqual([400, 'validation_error'])
    expect((await call('POST', '/meta/v1/connections/authorize', ['connections:write'], 'user', { provider: 'google', x: 1 })).status).toBe(400)
  })
})

describe('secrecy (D41)', () => {
  it('the ciphertext appears in no list or get answer, in neither OpenAPI document and not in /meta/v1/schema', async () => {
    const c = await seedConnection()
    await seedMachinery(c.id as string)
    const texts = [
      (await call('GET', '/meta/v1/connections', ['connections:read'])).text,
      (await call('GET', `/meta/v1/connections/${c.id}`, ['connections:read'])).text,
      (await call('GET', '/meta/v1/openapi.json', [])).text,
      (await call('GET', '/api/v1/openapi.json', [])).text,
      (await call('GET', '/meta/v1/schema', ['schema:read'])).text,
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/refresh_token_ciphertext/)
      expect(text).not.toContain('SENTINEL-CIPHERTEXT')
    }
  })

  it('the four machinery tables are hidden from schema discovery; channel_connections is listed with described columns', async () => {
    const schema = (await call('GET', '/meta/v1/schema', ['schema:read'])).body
    const names = (schema.tables as Array<{ name: string }>).map((t) => t.name)
    for (const hidden of ['channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors']) expect(names, hidden).not.toContain(hidden)
    expect(names).toContain('channel_connections')
    const table = (schema.tables as Array<{ name: string; columns: Array<{ name: string; description?: string }> }>).find((t) => t.name === 'channel_connections')!
    for (const col of table.columns) expect(col.description, col.name).toBeTruthy()
  })
})

describe('merge guard (D27)', () => {
  it('channel_connections.identity_id is in IDENTITY_REFERENCES', () => {
    expect(IDENTITY_REFERENCES).toContainEqual({ table: 'channel_connections', column: 'identity_id' })
  })
})

describe('Postgres compiles only (D29): the connection operations and the callback answer 501 not_implemented', () => {
  it('on a binding that is not D1, every connections route and the callback answer 501 before any unit runs', async () => {
    const pg = createApp({
      storage: coldStorage(),
      userAuthenticator: fakeUserAuthenticator(),
      gmail: { config: parseGmailConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', OAUTH_STATE_SECRET: 'o', CREDENTIALS_KEY: Buffer.alloc(32).toString('base64') }).config },
    })
    const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ['connections:read', 'connections:write'] })
    const send = (method: string, path: string, body?: unknown) => pg.request(`https://vault.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const id = '0190b2c4-0000-7000-8000-000000000001'
    for (const [method, path, body] of [['GET', '/meta/v1/connections'], ['GET', `/meta/v1/connections/${id}`], ['DELETE', `/meta/v1/connections/${id}`], ['POST', '/meta/v1/connections/authorize', { provider: 'google' }]] as const) {
      const res = await send(method, path, body)
      expect([res.status, ((await res.json()) as any).error.code], `${method} ${path}`).toEqual([501, 'not_implemented'])
    }
    const cb = await pg.request('https://vault.test/oauth/google/callback?code=x&state=y')
    expect(cb.status).toBe(501)
  })
})
