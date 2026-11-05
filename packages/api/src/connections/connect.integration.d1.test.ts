import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { step, uuidv7 } from '@vault/storage'
import { resolveOperation } from '../identity/resolve.js'
import type { Role } from '../auth/roles.js'
import { SCOPE_POLICY, type ScopePolicy } from '../auth/roles.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { FAKE_ENDPOINTS, FAKE_GMAIL_BASE, FakeGoogle, type ConsentOptions, type FakeAccount } from '../test/google.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { parseGmailConfig, type GmailConfig } from './config.js'
import { openToken } from './credentials.js'
import { connectOperation } from './connect.js'
import { GMAIL_READONLY } from './google.js'
import { signState } from './state.js'

// CHN140 D3, D4, D9, D10, D31, D55-D57: the connect flow end to end on a local D1 binding: authorize, Google's consent (faked), the
// callback and the one unit it runs. Every Google call goes to FakeGoogle; nothing reaches the network.
const KEY_BYTES = new Uint8Array(32).fill(3)
const ENV = {
  GOOGLE_CLIENT_ID: 'fake-client-id.apps.test',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  OAUTH_STATE_SECRET: 'state-secret-for-tests',
  CREDENTIALS_KEY: Buffer.from(KEY_BYTES).toString('base64'),
  PUBLIC_BASE_URL: 'https://vault.test',
}
const BASE = 'https://vault.test'
const SCOPES_ALL = ['openid', 'email', GMAIL_READONLY]
const ANN: FakeAccount = { sub: 'sub-ann', email: 'ann@example.test', historyId: '555', sendAs: [{ sendAsEmail: 'ann@example.test', isPrimary: true }, { sendAsEmail: 'Sales@Example.test', verificationStatus: 'accepted' }, { sendAsEmail: 'pending@example.test', verificationStatus: 'pending' }] }
const CONNECTION_TABLES = ['channel_connections', 'channel_credentials', 'gmail_watches', 'mail_sync_state', 'mail_sync_cursors', 'identities', 'contacts', 'events'] as const

let e: Engine
let google: FakeGoogle
let now: Date
let roles: Map<string, Role | null>
let roleFailure: boolean
let policy: ScopePolicy
let env: Record<string, string | undefined>
let app: ReturnType<typeof createApp>

const buildApp = (envVars: Record<string, string | undefined>, over: { roleOf?: (s: string) => Promise<Role | null> } = {}) => {
  const { config, problems } = parseGmailConfig(envVars)
  return createApp({
    storage: () => e.binding,
    userAuthenticator: fakeUserAuthenticator(),
    clock: () => now,
    newId: () => uuidv7(now),
    gmail: {
      config,
      problems,
      endpoints: FAKE_ENDPOINTS,
      fetch: google.fetch,
      gmailBaseUrl: FAKE_GMAIL_BASE,
      policy,
      roleOf:
        over.roleOf ??
        (async (subject) => {
          if (roleFailure) throw new Error('role source down')
          return roles.get(subject) ?? null
        }),
    },
  })
}

beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET })
  google.clock = () => now.getTime()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date('2026-11-05T10:00:00.000Z')
  roles = new Map([
    ['user_engine_1', 'owner'],
    ['user_engine_2', 'member'],
  ])
  roleFailure = false
  policy = SCOPE_POLICY
  env = { ...ENV }
  app = buildApp(env)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const token = (userId: string, scopes: string[], kind: 'user' | 'agent' = 'user') => mintTestUserToken({ userId, organizationId: e.organizationId, scopes, kind })
const api = (method: string, path: string, opts: { as?: string; scopes?: string[]; kind?: 'user' | 'agent'; body?: unknown; app?: ReturnType<typeof createApp> } = {}) =>
  (opts.app ?? app).request(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token(opts.as ?? e.userId, opts.scopes ?? ['connections:read', 'connections:write'], opts.kind)}`, 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
const authorize = async (as = e.userId) => {
  const res = await api('POST', '/meta/v1/connections/authorize', { as, body: { provider: 'google' } })
  expect(res.status).toBe(200)
  return (await res.json()) as { authorize_url: string; expires_at: string }
}
/** The whole browser trip: authorize, consent at Google, the redirect to the callback. Returns the callback's response. */
async function connect(account: FakeAccount = ANN, opts: { as?: string; consent?: ConsentOptions; mutateCallback?: (url: URL) => void | Promise<void>; app?: ReturnType<typeof createApp> } = {}) {
  const { authorize_url } = await authorize(opts.as)
  const callback = new URL(await google.consent(authorize_url, account, opts.consent))
  await opts.mutateCallback?.(callback)
  return (opts.app ?? app).request(callback.toString())
}
const rows = (table: string) => e.rows(table)
const snapshot = async () => Object.fromEntries(await Promise.all(CONNECTION_TABLES.map(async (t) => [t, (await rows(t)).length])))
const events = async () => (await rows('events')).filter((r) => /^(connection|identity)\./.test(r.type as string))

describe('connect, happy path (one unit, acting as the user)', () => {
  it('writes the connection, one credential, the cursor, the sync-state row, the own identities and the events', async () => {
    const res = await connect()
    expect(res.status).toBe(200)
    const conns = await rows('channel_connections')
    expect(conns).toHaveLength(1)
    const c = conns[0]!
    expect(c).toMatchObject({ provider: 'google', account_id: 'sub-ann', owner_id: e.userId, created_by: e.userId, status: 'active', deleted_at: null, connected_at: now.toISOString() })
    expect(c.granted_scopes).toEqual(SCOPES_ALL)
    const idents = await rows('identities')
    expect(idents.map((i) => `${i.value}:${i.own}:${i.contact_id}`).sort()).toEqual(['ann@example.test:true:null', 'sales@example.test:true:null'])
    expect(idents.find((i) => i.id === c.identity_id)!.value).toBe('ann@example.test')
    // The credential: the stored text is not the token, and opens to it under the key.
    const creds = await rows('channel_credentials')
    expect(creds).toHaveLength(1)
    expect(creds[0]).toMatchObject({ connection_id: c.id, key_version: 1, created_by: e.userId })
    expect(google.refreshTokens.at(-1)).toBeDefined()
    expect(creds[0]!.refresh_token_ciphertext).not.toContain(google.refreshTokens.at(-1))
    expect(await openToken(KEY_BYTES, creds[0]!.refresh_token_ciphertext as string)).toBe(google.refreshTokens.at(-1))
    // The cursor holds the profile's history id; the state row exists and is blank; nothing watches (D55).
    expect(await rows('mail_sync_cursors')).toEqual([expect.objectContaining({ connection_id: c.id, history_id: '555', page_token: null, last_synced_at: null, created_by: e.userId })])
    expect(await rows('mail_sync_state')).toEqual([expect.objectContaining({ connection_id: c.id, sync_requested_at: null, lease_until: null, run_id: null, last_success_at: null, last_error_code: null })])
    expect(await rows('gmail_watches')).toEqual([])
    // Events: connection.created and identity.created, all by the user.
    const ev = await events()
    expect(ev.map((x) => x.type).sort()).toEqual(['connection.created', 'identity.created', 'identity.created'])
    for (const x of ev) expect(x.actor_id).toBe(e.userId)
    const created = ev.find((x) => x.type === 'connection.created')!
    expect(created.resource_id).toBe(c.id)
    expect(JSON.stringify(created.after)).not.toContain('ciphertext')
  })

  it('asks Google for nothing but the token, the keys, the profile and the send-as list: no watch, no history, no messages (D55)', async () => {
    const before = google.calls.length
    await connect()
    const seen = google.calls.slice(before).map((c) => `${c.method} ${c.url.replace('https://fake-google.test', '')}`)
    expect(seen.sort()).toEqual(['GET /gmail/v1/users/me/profile', 'GET /gmail/v1/users/me/settings/sendAs', 'GET /oauth2/v3/certs', 'POST /token'].sort())
  })

  it('the authorize URL carries the redirect URI of PUBLIC_BASE_URL, or the request origin when it is unset', async () => {
    const { authorize_url, expires_at } = await authorize()
    expect(new URL(authorize_url).searchParams.get('redirect_uri')).toBe('https://vault.test/oauth/google/callback')
    expect(expires_at).toBe(new Date(now.getTime() + 10 * 60_000).toISOString())
    const local = buildApp({ ...ENV, PUBLIC_BASE_URL: undefined })
    const res = await local.request('http://localhost:8787/meta/v1/connections/authorize', {
      method: 'POST',
      headers: { authorization: `Bearer ${token(e.userId, ['connections:write'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google' }),
    })
    const authBody = (await res.json()) as { authorize_url: string }
    expect(res.status, JSON.stringify(authBody)).toBe(200)
    const url = new URL(authBody.authorize_url)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/oauth/google/callback')
    // And the callback of the same origin completes the flow (the redirect URI must match at the token endpoint).
    const back = new URL(await google.consent(url.toString(), ANN))
    expect((await local.request(back.toString())).status).toBe(200)
  })

  it('a late statement that fails leaves nothing: no connection, credential, cursor, state row or identity (absence mutation target)', async () => {
    const before = await snapshot()
    const op = connectOperation(e.env(), {
      google_sub: 'sub-ann',
      mailbox: 'ann@example.test',
      own_addresses: ['ann@example.test', 'sales@example.test'],
      granted_scopes: SCOPES_ALL,
      ciphertext: 'c2VhbGVk',
      key_version: 1,
      history_id: '555',
    })
    const faulty = {
      ...op,
      build: (found: Parameters<typeof op.build>[0], qc: Parameters<typeof op.build>[1]) => {
        const built = op.build(found, qc)
        const fault = step(sql`insert into "tasks" ("id", "organization_id") select null, "id" from "organizations"`.compile(qc.db), 'fault')
        return { ...built, steps: [...built.steps, fault] }
      },
    }
    await expect(e.run(faulty as never)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })
})

describe('own identities (D10)', () => {
  it('an address already on a contact moves to own (identity.updated), the contact stays', async () => {
    await e.run(resolveOperation(e.env(), [{ kind: 'email', value: 'sales@example.test', name: 'Sales Desk' }]))
    const contactsBefore = await rows('contacts')
    expect(contactsBefore).toHaveLength(1)
    await connect()
    const sales = (await rows('identities')).find((i) => i.value === 'sales@example.test')!
    expect(sales).toMatchObject({ own: true, contact_id: null })
    expect(await rows('contacts')).toEqual(contactsBefore)
    expect((await events()).filter((x) => x.type === 'identity.updated').map((x) => x.resource_id)).toEqual([sales.id])
  })

  it('an unverified send-as alias is not made own, and an address with no identity yet is created own (empty state)', async () => {
    await connect()
    const values = (await rows('identities')).map((i) => i.value)
    expect(values).not.toContain('pending@example.test')
    expect(values).toContain('sales@example.test')
    expect((await events()).filter((x) => x.type === 'identity.created')).toHaveLength(2)
  })

  it('an address that is already own changes nothing for it (no second identity, no event)', async () => {
    await connect()
    const identsBefore = await rows('identities')
    const evBefore = (await events()).length
    await connect({ ...ANN, sendAs: ANN.sendAs })
    expect(await rows('identities')).toEqual(identsBefore)
    expect((await events()).slice(evBefore).map((x) => x.type)).toEqual(['connection.updated'])
  })
})

describe('reconnect (D31, D56)', () => {
  it('the same Google account by another connections:write holder updates the row: owner moves, active again, scopes replaced, created_by stays, one new credential replaces the old', async () => {
    await connect(ANN, { consent: { granted: [...SCOPES_ALL, 'https://www.googleapis.com/auth/gmail.send'] } })
    const first = (await rows('channel_connections'))[0]!
    const firstCred = (await rows('channel_credentials'))[0]!
    await e.update('channel_connections', first.id as string, { status: 'reauth_required' })
    now = new Date('2026-11-06T10:00:00.000Z')
    const res = await connect({ ...ANN, historyId: '900' }, { as: e.user2Id })
    expect(res.status).toBe(200)
    const conns = await rows('channel_connections')
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ id: first.id, owner_id: e.user2Id, created_by: e.userId, status: 'active', connected_at: now.toISOString(), deleted_at: null })
    expect(conns[0]!.granted_scopes).toEqual(SCOPES_ALL)
    const creds = await rows('channel_credentials')
    expect(creds).toHaveLength(1)
    expect(creds[0]!.id).not.toBe(firstCred.id)
    expect(await openToken(KEY_BYTES, creds[0]!.refresh_token_ciphertext as string)).toBe(google.refreshTokens.at(-1))
    expect((await events()).filter((x) => x.type === 'connection.updated')).toEqual([expect.objectContaining({ resource_id: first.id, actor_id: e.user2Id })])
    expect((await events()).filter((x) => x.type === 'connection.created')).toHaveLength(1)
    // The cursor is kept (a new history id would open a gap), the old error is cleared, one row each.
    expect(await rows('mail_sync_cursors')).toEqual([expect.objectContaining({ connection_id: first.id, history_id: '555' })])
    expect(await rows('mail_sync_state')).toHaveLength(1)
  })

  it('a reconnect after a disconnect creates a new connection; the deleted row stays', async () => {
    await connect()
    const first = (await rows('channel_connections'))[0]!
    expect((await api('DELETE', `/meta/v1/connections/${first.id}`)).status).toBe(204)
    await connect()
    const conns = await rows('channel_connections')
    expect(conns).toHaveLength(2)
    expect(conns.find((c) => c.id === first.id)!.deleted_at).not.toBeNull()
    const second = conns.find((c) => c.id !== first.id)!
    expect(second).toMatchObject({ deleted_at: null, status: 'active' })
    expect((await events()).filter((x) => x.type === 'connection.created')).toHaveLength(2)
    expect(await rows('channel_credentials')).toEqual([expect.objectContaining({ connection_id: second.id })])
  })
})

describe('every callback refusal writes nothing and emits nothing (D9, D33, D57)', () => {
  const stateOf = (cb: URL) => cb.searchParams.get('state')!
  const cases: Array<[string, string, () => NonNullable<Parameters<typeof connect>[1]>]> = [
    ['an expired state', 'state_invalid', () => ({ mutateCallback: () => void (now = new Date(now.getTime() + 11 * 60_000)) })],
    ['a tampered state', 'state_invalid', () => ({ mutateCallback: (u) => u.searchParams.set('state', stateOf(u).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))) })],
    ['a missing state', 'state_invalid', () => ({ mutateCallback: (u) => u.searchParams.delete('state') })],
    ['a state signed with another secret', 'state_invalid', () => ({ mutateCallback: async (u) => u.searchParams.set('state', await signState('another-secret', { user_id: e.userId, nonce: 'n', expires_at: now.getTime() + 60_000 })) })],
    ['a missing code', 'exchange_failed', () => ({ mutateCallback: (u) => u.searchParams.delete('code') })],
    ['the person pressing Cancel', 'consent_denied', () => ({ consent: { deny: true } })],
    ['Gmail unticked on the consent screen', 'scope_missing', () => ({ consent: { granted: ['openid', 'email'] } })],
    ['an ID token for another audience', 'exchange_failed', () => ({ consent: { idToken: { aud: 'someone-else' } } })],
    ['an ID token from another issuer', 'exchange_failed', () => ({ consent: { idToken: { iss: 'https://evil.test' } } })],
    ['an unverified email', 'exchange_failed', () => ({ consent: { idToken: { emailVerified: false } } })],
    ['an expired ID token', 'exchange_failed', () => ({ consent: { idToken: { expired: true } } })],
    ['no refresh token in the response', 'exchange_failed', () => ({ consent: { noRefreshToken: true } })],
  ]
  it.each(cases)('%s -> %s', async (_name, code, make) => {
    // `mutateCallback` may be async (the signed state); connect() awaits it through a thenable wrapper.
    const opts = make()
    const mutate = opts.mutateCallback
    const before = await snapshot()
    google.calls.length = 0
    const { authorize_url } = await authorize()
    const callback = new URL(await google.consent(authorize_url, ANN, opts.consent))
    await mutate?.(callback)
    const res = await app.request(callback.toString())
    const text = await res.text()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(text).toContain(`<code>${code}</code>`)
    expect(text).not.toContain('secret provider text')
    expect(await snapshot()).toEqual(before)
  })

  it('the token endpoint failing is exchange_failed, and the page carries no provider text', async () => {
    google.failToken(502)
    const before = await snapshot()
    const res = await connect()
    google.failToken(null)
    const text = await res.text()
    expect(text).toContain('<code>exchange_failed</code>')
    expect(text).not.toContain('secret provider text')
    expect(await snapshot()).toEqual(before)
  })

  it('the Gmail profile call failing is exchange_failed', async () => {
    const before = await snapshot()
    const failing = createApp({
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      clock: () => now,
      gmail: { config: parseGmailConfig(ENV).config, endpoints: FAKE_ENDPOINTS, fetch: google.fetch, gmailBaseUrl: `${FAKE_GMAIL_BASE}/nope`, roleOf: async () => 'owner' },
    })
    const res = await connect(ANN, { app: failing })
    expect(await res.text()).toContain('<code>exchange_failed</code>')
    expect(await snapshot()).toEqual(before)
  })

  it('not_a_member: a role the provider does not know (404 at the role source), and a role without connections:write', async () => {
    const before = await snapshot()
    roles.set('user_engine_1', null)
    expect(await (await connect()).text()).toContain('<code>not_a_member</code>')
    roles.set('user_engine_1', 'member')
    policy = { ...SCOPE_POLICY, 'connections:write': { member: false, agentGrantable: false } }
    app = buildApp(env)
    expect(await (await connect()).text()).toContain('<code>not_a_member</code>')
    expect(await snapshot()).toEqual(before)
  })

  it('temporarily_unavailable: a role-source failure is retryable, says so, and changes nothing (D57)', async () => {
    roleFailure = true
    const before = await snapshot()
    const res = await connect()
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('<code>temporarily_unavailable</code>')
    expect(await snapshot()).toEqual(before)
    roleFailure = false
    expect((await connect()).status).toBe(200)
  })

  it('a user principal with no sign-in link (no role source subject) is not a member', async () => {
    const orphan = await e.seedMember('member')
    const before = await snapshot()
    expect(await (await connect(ANN, { as: orphan.userId })).text()).toContain('<code>not_a_member</code>')
    expect(await snapshot()).toEqual(before)
  })
})

describe('result surface (D32)', () => {
  it('with CONNECT_RETURN_URL set the callback redirects with connection_id, or with error', async () => {
    app = buildApp({ ...env, CONNECT_RETURN_URL: 'https://app.example.test/connected' })
    const ok = await connect()
    expect(ok.status).toBe(302)
    const location = new URL(ok.headers.get('location')!)
    expect(`${location.origin}${location.pathname}`).toBe('https://app.example.test/connected')
    expect(location.searchParams.get('connection_id')).toBe((await rows('channel_connections'))[0]!.id)
    expect(location.searchParams.get('error')).toBeNull()
    const denied = await connect(ANN, { consent: { deny: true } })
    expect(denied.status).toBe(302)
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('consent_denied')
    expect(new URL(denied.headers.get('location')!).searchParams.get('connection_id')).toBeNull()
  })

  it('unset, it serves a built-in page: no script, no external URL, the address HTML-escaped', async () => {
    const res = await connect({ ...ANN, email: 'x&y@example.test', sendAs: [{ sendAsEmail: 'x&y@example.test', isPrimary: true }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('x&amp;y@example.test')
    expect(html).not.toContain('x&y@')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).toContain('You can close this tab')
  })

  it('the error page carries the fixed text of the code and nothing from the query string', async () => {
    const res = await connect(ANN, { consent: { deny: true }, mutateCallback: (u) => u.searchParams.set('error_description', '<script>alert(1)</script>') })
    const html = await res.text()
    expect(html).toContain('<code>consent_denied</code>')
    expect(html).not.toContain('alert(1)')
  })
})

describe('secrecy: no token, code, secret or key reaches a log line', () => {
  it('a full flow, a refusal and a failure print no refresh token, access token, code, client secret, state secret or key', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    await connect()
    await connect(ANN, { consent: { deny: true } })
    google.failToken(500)
    await connect()
    google.failToken(null)
    roleFailure = true
    await connect()
    const printed = spies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n')
    for (const secret of [...google.refreshTokens, ...google.accessTokens, ENV.GOOGLE_CLIENT_SECRET, ENV.OAUTH_STATE_SECRET, ENV.CREDENTIALS_KEY, 'secret provider text']) {
      expect(printed).not.toContain(secret)
    }
  })
})

describe('config gate (D58)', () => {
  const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const
  it.each(REQUIRED)('without %s: the callback answers 404, authorize answers 501 provider_not_configured, list still works, the log names the variable and no value', async (name) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const partial = { ...ENV, [name]: undefined }
    const gated = buildApp(partial)
    const cb = await gated.request(`${BASE}/oauth/google/callback?code=x&state=y`)
    expect(cb.status).toBe(404)
    const auth = await api('POST', '/meta/v1/connections/authorize', { app: gated, body: { provider: 'google' } })
    expect(auth.status).toBe(501)
    expect(((await auth.json()) as { error: { code: string } }).error.code).toBe('provider_not_configured')
    const list = await api('GET', '/meta/v1/connections', { app: gated })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([])
    const logged = warn.mock.calls.flat().map(String).join('\n')
    expect(logged).toContain(name)
    for (const [k, v] of Object.entries(ENV)) if (k !== name && v) expect(logged).not.toContain(v)
  })

  it('a key that does not decode to 32 bytes gates the surface too', async () => {
    const gated = buildApp({ ...ENV, CREDENTIALS_KEY: Buffer.alloc(16).toString('base64') })
    expect((await gated.request(`${BASE}/oauth/google/callback`)).status).toBe(404)
    expect((await api('POST', '/meta/v1/connections/authorize', { app: gated, body: { provider: 'google' } })).status).toBe(501)
  })

  it('nothing configured at all is quiet: no log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    buildApp({})
    expect(warn).not.toHaveBeenCalled()
  })
})
