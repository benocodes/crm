import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, openControlDb, type D1Like } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import {
  SCOPE_POLICY,
  assertAgentGrantable,
  createVibaseRegistry,
  defaultGrantScopes,
  grantableScopes,
  scopesForRole,
} from '@vibase/api'
import { registrationScopes, resourcesFor } from '@vibase/auth'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, renameClient, type AuthKit } from './test/auth-kit.js'
import {
  bootstrapD1,
  unauditedControl,
  NOW,
  clerkKit,
  clerkUser,
  openWorkerD1,
  openWorkerPair,
  type ClerkKit,
  type WorkerPair,
  composeD1Worker,
} from './test/kit.js'

// [[CORE627]] groups 1 to 4 through the composition: the REAL Better Auth mints the tokens on the control-plane database, the Worker (composeD1Worker, `better-auth`) serves the four first-party OAuth
// client operations on REST and MCP, and every write lands in `CONTROL_DB` with its `control_audit` row.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let bootKey: string
let otherClient: string
const declared = createVibaseRegistry().declaredScopes()
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  const r = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(unauditedControl(w.control)) },
  )
  orgId = r.organizationId
  bootUser = r.userId!
  bootKey = r.key
  kit = authKit(w.control, { scopes: declared })
  otherClient = await kit.registerClient('Claude Desktop')
})

const worker = (control: D1WorkerEnv['CONTROL_DB'] = w.control) =>
  composeD1Worker({
    DB: w.d1,
    CONTROL_DB: control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  })
type Res = { status: number; json: any; text: string }
const call = async (
  wk: ReturnType<typeof worker>,
  method: string,
  path: string,
  tok: string | null,
  body?: unknown,
): Promise<Res> => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: {
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, text }
}
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
/** Everything the operations may write: the client tables, the resources and the audit log. */
const authState = async () =>
  JSON.stringify({
    clients: await rows(w.control, 'select * from auth_oauth_clients order by id'),
    links: await rows(w.control, 'select * from auth_oauth_client_resources order by id'),
    resources: await rows(w.control, 'select * from auth_oauth_resources order by id'),
    audit: await rows(w.control, 'select * from control_audit order by id'),
  })
const crmCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      ['events', 'users', 'principals', 'agents', 'memberships', 'organizations'].map(async (t) => [
        t,
        (await rows(w.d1, `select count(*) n from "${t}"`))[0]!.n as number,
      ]),
    ),
  )

async function human(role: 'owner' | 'member', email = `${role}@x.test`) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return {
    id,
    cookie,
    session: () => kit.sessionJwt(cookie),
    oauth: async (client: string, scope = 'openid contacts:read') =>
      (await kit.deviceTokens(cookie, client, scope)).access_token,
  }
}
async function agentAccount() {
  const { userId, cookie } = await kit.signUp('agent-account@x.test')
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read', 'contacts:write'] })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, id)
    .run()
  return { session: () => kit.sessionJwt(cookie) }
}

const PATH = '/meta/v1/oauth-clients'
const REDIRECT = 'https://app.test/cb'
const body = (over: Record<string, unknown> = {}) => ({ name: 'Deals board', redirect_uris: [REDIRECT], ...over })
const create = (wk: ReturnType<typeof worker>, tok: string, b: unknown = body()) => call(wk, 'POST', PATH, tok, b)
const RECORD_KEYS = ['client_id', 'created_at', 'name', 'redirect_uris', 'scopes', 'skip_consent', 'updated_at']
/** A first-party client written through the store, at a chosen id and time. */
const seedClient = async (clientId: string, now = '2026-11-01T10:00:00.000Z') =>
  createOAuthClient(openControlDb(w.control), {
    organizationId: orgId,
    clientId,
    name: `App ${clientId}`,
    redirectUris: [REDIRECT],
    scopes: ['openid', 'offline_access'],
    skipConsent: true,
    resources: resourcesFor(AUTH_BASE),
    actorId: bootUser,
    now,
    newId: () => uuidv7(NOW),
  })

describe('group 3: create input and refusals (D7, P3, P4)', () => {
  it('creates a client: 201, D12 keys only, defaults applied, a 32-character base64url id that differs per create', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const a = await create(wk, tok)
    expect(a.status, a.text).toBe(201)
    expect(Object.keys(a.json).sort()).toEqual(RECORD_KEYS)
    expect(a.json).toMatchObject({ name: 'Deals board', redirect_uris: [REDIRECT], skip_consent: true })
    expect(a.json.client_id).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a.json.scopes).toEqual(registrationScopes(declared, grantableScopes(declared), defaultGrantScopes(declared)).defaults)
    expect(a.json.scopes).toContain('offline_access')
    expect(a.json.created_at).toBe(a.json.updated_at)
    const b = await create(wk, tok)
    expect(b.json.client_id).not.toBe(a.json.client_id)
    const [row] = await rows(w.control, 'select * from auth_oauth_clients where client_id = ?', a.json.client_id)
    expect(row).toMatchObject({ reference_id: orgId, user_id: null, skip_consent: 1, client_secret: null })
  })

  it('accepts every rule at its edge', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const uris = Array.from({ length: 10 }, (_, i) => `https://app${i}.test/cb`)
    for (const edge of [
      { name: 'x'.repeat(100) },
      { name: '  Padded  ' },
      { redirect_uris: uris },
      { redirect_uris: ['http://localhost:5199/cb'] },
      { redirect_uris: ['http://127.0.0.1:3000/cb?x=1'] },
      { scopes: ['openid', 'contacts:read'] },
      { skip_consent: true },
    ]) {
      const res = await create(wk, tok, body(edge))
      expect(res.status, `${JSON.stringify(edge)} ${res.text}`).toBe(201)
    }
    expect((await create(wk, tok, body({ name: '  Padded  ' }))).json.name).toBe('Padded')
    const dup = await create(wk, tok, body({ redirect_uris: [REDIRECT, REDIRECT, 'https://b.test/cb', REDIRECT] }))
    expect(dup.json.redirect_uris).toEqual([REDIRECT, 'https://b.test/cb'])
    const sc = await create(wk, tok, body({ scopes: ['openid', 'openid', 'contacts:read'] }))
    expect(sc.json.scopes).toEqual(['openid', 'contacts:read'])
  })

  it('refuses one past each edge, and every refusal writes no client, resource or audit row (P4)', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const before = await authState()
    const refused: Array<[string, Record<string, unknown>]> = [
      ['name empty', { name: '' }],
      ['name blank', { name: '   ' }],
      ['name 101', { name: 'x'.repeat(101) }],
      ['name missing', { name: undefined }],
      ['no uris', { redirect_uris: [] }],
      ['uris missing', { redirect_uris: undefined }],
      ['11 uris', { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app${i}.test/cb`) }],
      ['http non-loopback', { redirect_uris: ['http://example.com/cb'] }],
      ['http localhost lookalike', { redirect_uris: ['http://localhost.evil.test/cb'] }],
      ['fragment', { redirect_uris: ['https://app.test/cb#frag'] }],
      ['empty fragment', { redirect_uris: ['https://app.test/cb#'] }],
      ['user info', { redirect_uris: ['https://user:pw@app.test/cb'] }],
      ['star host', { redirect_uris: ['https://*.app.test/cb'] }],
      ['star path', { redirect_uris: ['https://app.test/*'] }],
      ['not a url', { redirect_uris: ['nope'] }],
      ['custom scheme', { redirect_uris: ['myapp://cb'] }],
      ['scope outside the ceiling', { scopes: ['openid', 'nope:read'] }],
      ['human-only scope', { scopes: ['openid', 'members:write'] }],
      ['oauth_clients scope', { scopes: ['oauth_clients:write'] }],
      ['client_id given', { client_id: 'mine' }],
      ['unknown field', { extra: 1 }],
      ['skip_consent a string', { skip_consent: 'no' }],
    ]
    for (const [what, over] of refused) {
      const res = await create(wk, tok, body(over))
      expect(res.status, `${what}: ${res.text}`).toBe(400)
      expect(res.json.error.code, what).toBe('validation_error')
    }
    expect((await create(wk, tok, body({ scopes: ['openid', 'nope:read'] }))).json.error.message).toContain('nope:read')
    expect(await authState()).toBe(before)
  })

  it('skip_consent false answers the exact message and writes nothing', async () => {
    const owner = await human('owner')
    const before = await authState()
    const res = await create(worker(), await owner.session(), body({ skip_consent: false }))
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_error')
    expect(res.json.error.message).toBe('skip_consent = false is not implemented yet')
    expect(await authState()).toBe(before)
  })

  it('writes one oauth_client.created audit row naming the owner (P5), and no CRM event or row', async () => {
    const owner = await human('owner')
    const crm = await crmCounts()
    const res = await create(worker(), await owner.session())
    const audit = await rows(w.control, 'select * from control_audit where target_id = ?', res.json.client_id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: owner.id, action: 'oauth_client.created', target_type: 'oauth_client' })
    expect(await crmCounts()).toEqual(crm)
  })
})

describe('group 4: first-party visibility and the record (D5, D12, D13)', () => {
  it('get and delete of a DCR client, vibase-cli and an unknown id answer 404 not_found and change nothing', async () => {
    const owner = await human('owner')
    const cli = await kit.registerClient('CLI')
    await renameClient(w.control, cli, 'vibase-cli')
    const wk = worker()
    const tok = await owner.session()
    const before = await authState()
    for (const id of [otherClient, 'vibase-cli', 'no-such-client']) {
      for (const method of ['GET', 'DELETE']) {
        const res = await call(wk, method, `${PATH}/${id}`, tok)
        expect(res.status, `${method} ${id}`).toBe(404)
        expect(res.json.error.code).toBe('not_found')
      }
    }
    expect(await authState()).toBe(before)
  })

  it('list returns only first-party clients, ordered by created_at then client_id, nothing else; an empty state is { data: [] }', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    expect((await call(wk, 'GET', PATH, tok)).json).toEqual({ data: [] })
    await seedClient('b'.repeat(32), '2026-11-01T10:00:00.000Z')
    await seedClient('a'.repeat(32), '2026-11-01T10:00:00.000Z')
    await seedClient('0'.repeat(32), '2026-11-01T10:00:01.000Z')
    const res = await call(wk, 'GET', PATH, tok)
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['data'])
    expect(res.json.data.map((r: any) => r.client_id)).toEqual(['a'.repeat(32), 'b'.repeat(32), '0'.repeat(32)])
    for (const r of res.json.data) expect(Object.keys(r).sort()).toEqual(RECORD_KEYS)
  })

  it('get returns the record; delete answers 204 with an empty body, writes one oauth_client.deleted audit row naming the owner, and the client is gone', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const made = await create(wk, tok)
    const id = made.json.client_id
    const got = await call(wk, 'GET', `${PATH}/${id}`, tok)
    expect(got.status).toBe(200)
    expect(got.json).toEqual(made.json)
    const del = await call(wk, 'DELETE', `${PATH}/${id}`, tok)
    expect(del.status).toBe(204)
    expect(del.text).toBe('')
    expect((await call(wk, 'GET', `${PATH}/${id}`, tok)).status).toBe(404)
    expect((await call(wk, 'DELETE', `${PATH}/${id}`, tok)).status).toBe(404)
    expect(await rows(w.control, 'select client_id from auth_oauth_clients where client_id = ?', id)).toEqual([])
    const audit = await rows(
      w.control,
      "select actor_id from control_audit where target_id = ? and action = 'oauth_client.deleted'",
      id,
    )
    expect(audit).toEqual([{ actor_id: owner.id }])
  })
})

describe('group 2: the authority matrix, operation x credential (D3)', () => {
  const who = ['owner session', 'member session', 'agent API key', 'DCR-registered client'] as const
  const ops = ['create', 'list', 'get', 'delete'] as const
  const cells = ops.flatMap((op) => who.map((w2) => [op, w2] as const))

  it.each(cells)('%s as %s', async (op, which) => {
    const owner = await human('owner')
    const target = await seedClient('t'.repeat(32))
    expect(target).not.toBe('exists')
    const token: Record<(typeof who)[number], () => Promise<string>> = {
      'owner session': () => owner.session(),
      'member session': async () => (await human('member', 'm@x.test')).session(),
      'agent API key': async () => bootKey,
      'DCR-registered client': async () => (await human('owner', 'delegator@x.test')).oauth(otherClient),
    }
    const wk = worker()
    const before = await authState()
    const tok = await token[which]()
    const res =
      op === 'create'
        ? await create(wk, tok)
        : op === 'list'
          ? await call(wk, 'GET', PATH, tok)
          : op === 'get'
            ? await call(wk, 'GET', `${PATH}/${'t'.repeat(32)}`, tok)
            : await call(wk, 'DELETE', `${PATH}/${'t'.repeat(32)}`, tok)
    if (which === 'owner session') {
      expect(res.status, res.text).toBe(op === 'create' ? 201 : op === 'delete' ? 204 : 200)
      return
    }
    expect(res.status, res.text).toBe(403)
    expect(res.json.error.code).toBe('insufficient_scope')
    expect(res.text).toContain(`oauth_clients:${op === 'list' || op === 'get' ? 'read' : 'write'}`)
    expect(await authState()).toBe(before)
  })

  it('neither scope is agent-grantable, a member scope, a default grant or in registrationScopes; both are declared with consent text', () => {
    const reg = registrationScopes(declared, grantableScopes(declared), defaultGrantScopes(declared))
    for (const s of ['oauth_clients:read', 'oauth_clients:write']) {
      expect(declared).toContain(s)
      expect(SCOPE_POLICY[s]).toEqual({ member: false, agentGrantable: false })
      expect(grantableScopes(declared)).not.toContain(s)
      expect(defaultGrantScopes(declared)).not.toContain(s)
      expect(reg.allowed).not.toContain(s)
      expect(reg.defaults).not.toContain(s)
      expect(() => assertAgentGrantable([s], declared)).toThrow(/not grantable/)
      expect(scopesForRole('member', declared).toStrings()).not.toContain(s)
      expect(scopesForRole('owner', declared).toStrings()).toContain(s)
    }
  })

  it('MCP: the four tools are listed for the owner only', async () => {
    const owner = await human('owner')
    const member = await human('member', 'm2@x.test')
    const agent = await agentAccount()
    const wk = worker()
    const names = async (tok: string) =>
      (
        (await call(wk, 'POST', '/mcp', tok, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result
          .tools as Array<{ name: string }>
      )
        .map((t) => t.name)
        .filter((n) => n.startsWith('oauth_clients_'))
        .sort()
    expect(await names(await owner.session())).toEqual([
      'oauth_clients_create',
      'oauth_clients_delete',
      'oauth_clients_get',
      'oauth_clients_list',
    ])
    expect(await names(await member.session())).toEqual([])
    expect(await names(await agent.session())).toEqual([])
  })
})

describe('group 1 (no runtime): a composition without the built-in provider', () => {
  let clerk: ClerkKit
  let single: Awaited<ReturnType<typeof openWorkerD1>>
  beforeAll(async () => {
    clerk = await clerkKit()
    single = await openWorkerD1()
  })
  afterAll(() => single.dispose())

  it('on Clerk the four operations refuse with 501 provider_not_configured', async () => {
    const issuer = clerk.issuer.issuer
    await single.d1.batch([
      single.d1
        .prepare('insert into deployment (singleton, organization_id, auth_provider, auth_org_id) values (1, ?, ?, ?)')
        .bind(orgId, 'clerk', issuer),
      single.d1
        .prepare(
          'insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)',
        )
        .bind(orgId, NOW.toISOString(), NOW.toISOString(), 'Acme', 'clerk', issuer),
    ])
    const wk = composeD1Worker({ DB: single.d1, ...clerk.env, CLERK_WEBHOOK_SECRET: undefined }, { fetch: clerk.fetch })
    const tok = await mintClerkToken(clerk.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' } })
    clerk.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true }))
    const req = (method: string, path: string, b?: unknown) =>
      wk.fetch(
        new Request(`https://w.test${path}`, {
          method,
          headers: { authorization: `Bearer ${tok}`, ...(b ? { 'content-type': 'application/json' } : {}) },
          body: b ? JSON.stringify(b) : undefined,
        }),
      )
    for (const res of [
      await req('POST', PATH, body()),
      await req('GET', PATH),
      await req('GET', `${PATH}/abc`),
      await req('DELETE', `${PATH}/abc`),
    ]) {
      expect(res.status).toBe(501)
      expect(((await res.json()) as any).error.code).toBe('provider_not_configured')
    }
  })
})
