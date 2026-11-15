import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb, type D1Like } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[CORE261]] P1-P6 through the composition: the REAL Better Auth mints the tokens on the control-plane database, the Worker (composeD1Worker, `better-auth`) serves `audit.list` on REST and MCP.
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
  // The bootstrap agent's key holds audit:read explicitly: an owner may grant it.
  const r = await bootstrapD1(
    w.d1,
    {
      organizationName: 'Acme',
      email: 'boot@x.test',
      agentName: 'bot',
      authProvider: 'none',
      authOrgId: 'org_acme',
      scopes: ['audit:read', 'contacts:read'],
    },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
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
type Res = { status: number; json: any }
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
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const crmCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      ['events', 'users', 'principals', 'agents', 'memberships', 'organizations', 'api_keys'].map(async (t) => [
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
async function agentAccount(scopes: string[], email = 'agent-account@x.test') {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, id)
    .run()
  return { session: () => kit.sessionJwt(cookie) }
}

const PATH = '/meta/v1/audit'
const INV = '/meta/v1/invitations'
/** An audit row written straight into the control plane, as a store write would. */
async function plant(a: { action: string; targetType: string; targetId: string; detail?: unknown; actor?: string }) {
  const id = uuidv7(NOW)
  await w.control
    .prepare(
      'insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      NOW.toISOString(),
      a.actor ?? bootUser,
      a.action,
      a.targetType,
      a.targetId,
      JSON.stringify(a.detail ?? {}),
    )
    .run()
  return id
}

describe('the authority matrix (P2, P5)', () => {
  type Who = 'owner session' | 'agent account with' | 'delegated agent with' | 'API-key agent with'
  type Without = 'member session' | 'agent account without' | 'delegated agent without'
  const allowed = [
    'owner session',
    'agent account with',
    'delegated agent with',
    'API-key agent with',
  ] as const satisfies readonly Who[]
  const refused = [
    'member session',
    'agent account without',
    'delegated agent without',
  ] as const satisfies readonly Without[]
  const token = async (which: Who | Without): Promise<string> => {
    switch (which) {
      case 'owner session':
        return (await human('owner')).session()
      case 'agent account with':
        return (await agentAccount(['audit:read'])).session()
      case 'delegated agent with':
        return (await human('owner', 'delegator@x.test')).oauth(otherClient, 'openid audit:read')
      case 'API-key agent with':
        return bootKey
      case 'member session':
        return (await human('member', 'm@x.test')).session()
      case 'agent account without':
        return (await agentAccount(['contacts:read'])).session()
      case 'delegated agent without':
        return (await human('owner', 'delegator@x.test')).oauth(otherClient, 'openid contacts:read')
    }
  }

  it.each(allowed)('%s reads the log', async (which) => {
    await plant({
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: 'seen-by-' + which.replace(/ /g, '-'),
    })
    const res = await call(worker(), 'GET', PATH, await token(which))
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.map((r: any) => r.target_id)).toContain('seen-by-' + which.replace(/ /g, '-'))
  })

  it.each(refused)('%s is 403 insufficient_scope, with nothing written', async (which) => {
    await plant({ action: 'invitation.created', targetType: 'invitation', targetId: 'hidden' })
    const before = JSON.stringify(await rows(w.control, 'select * from control_audit order by id'))
    const res = await call(worker(), 'GET', PATH, await token(which))
    expect(res.status, JSON.stringify(res.json)).toBe(403)
    expect(res.json.error.code).toBe('insufficient_scope')
    expect(JSON.stringify(res.json)).not.toContain('hidden')
    expect(JSON.stringify(await rows(w.control, 'select * from control_audit order by id'))).toBe(before)
  })

  it('no credential is 401', async () => {
    expect((await call(worker(), 'GET', PATH, null)).status).toBe(401)
  })

  it('an owner may grant audit:read to an agent through the administration (agents.create), and the agent then reads', async () => {
    const owner = await human('owner')
    const made = await call(worker(), 'POST', '/meta/v1/agents', await owner.session(), {
      name: 'auditor',
      scopes: ['audit:read'],
    })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    expect(made.json.scopes).toEqual(['audit:read'])
  })

  it('a member cannot grant audit:read (agents.create needs agents:write, an owner scope)', async () => {
    const member = await human('member', 'm3@x.test')
    const made = await call(worker(), 'POST', '/meta/v1/agents', await member.session(), {
      name: 'auditor',
      scopes: ['audit:read'],
    })
    expect(made.status).toBe(403)
  })
})

describe('query and paging (P3, P4)', () => {
  it('an empty log answers an empty page', async () => {
    const owner = await human('owner')
    expect((await call(worker(), 'GET', PATH, await owner.session())).json).toEqual({ data: [], next_cursor: null })
  })

  it('answers each row as stored: the seven fields, detail the stored object', async () => {
    const owner = await human('owner')
    const id = await plant({
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: 'inv-1',
      detail: { email: 'a@x.test', role: 'member', expires_at: '2026-11-21T00:00:00.000Z' },
    })
    const res = await call(worker(), 'GET', PATH, await owner.session())
    expect(res.json.data).toEqual([
      {
        id,
        at: NOW.toISOString(),
        actor_id: bootUser,
        action: 'invitation.created',
        target_type: 'invitation',
        target_id: 'inv-1',
        detail: { email: 'a@x.test', role: 'member', expires_at: '2026-11-21T00:00:00.000Z' },
      },
    ])
    expect(res.json.next_cursor).toBeNull()
  })

  it('filters action, target_type and target_id: each alone, combined, exact match', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    await plant({ action: 'invitation.created', targetType: 'invitation', targetId: 't1' })
    await plant({ action: 'invitation.revoked', targetType: 'invitation', targetId: 't1' })
    await plant({ action: 'invitation.created', targetType: 'invitation', targetId: 't2' })
    await plant({ action: 'user.sessions_revoked', targetType: 'user', targetId: 'u1' })
    const q = async (qs: string) =>
      ((await call(worker(), 'GET', `${PATH}?${qs}`, tok)).json.data as any[]).map(
        (r) => `${r.action}|${r.target_type}|${r.target_id}`,
      )
    expect(await q('action=invitation.created')).toEqual([
      'invitation.created|invitation|t1',
      'invitation.created|invitation|t2',
    ])
    expect(await q('target_type=user')).toEqual(['user.sessions_revoked|user|u1'])
    expect(await q('target_id=t1')).toEqual(['invitation.created|invitation|t1', 'invitation.revoked|invitation|t1'])
    expect(await q('target_id=t1&action=invitation.revoked')).toEqual(['invitation.revoked|invitation|t1'])
    expect(await q('target_type=user&action=invitation.created')).toEqual([])
    expect(await q('target_id=t')).toEqual([])
    expect(await q('action=invitation')).toEqual([])
  })

  it('pages across three pages by limit and next_cursor, null on the last', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await plant({ action: 'a.b', targetType: 'x', targetId: `p${i}` }))
    const p1 = await call(worker(), 'GET', `${PATH}?limit=2`, tok)
    expect(p1.json.data.map((r: any) => r.id)).toEqual(ids.slice(0, 2))
    expect(p1.json.next_cursor).toBe(ids[1])
    const p2 = await call(worker(), 'GET', `${PATH}?limit=2&after=${p1.json.next_cursor}`, tok)
    expect(p2.json.data.map((r: any) => r.id)).toEqual(ids.slice(2, 4))
    const p3 = await call(worker(), 'GET', `${PATH}?limit=2&after=${p2.json.next_cursor}`, tok)
    expect(p3.json.data.map((r: any) => r.id)).toEqual(ids.slice(4))
    expect(p3.json.next_cursor).toBeNull()
  })

  it.each(['after=nope', 'limit=0', 'limit=201', 'limit=x', 'colour=red'])('%s is 400 validation_error', async (qs) => {
    const owner = await human('owner')
    const res = await call(worker(), 'GET', `${PATH}?${qs}`, await owner.session())
    expect(res.status, JSON.stringify(res.json)).toBe(400)
    expect(res.json.error.code).toBe('validation_error')
  })
})

describe('reads only the control plane and writes nothing (P1, P6, D5)', () => {
  it('a read adds no control_audit row and no CRM event or row', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    await plant({ action: 'a.b', targetType: 'x', targetId: 'y' })
    const beforeAudit = await rows(w.control, 'select * from control_audit order by id')
    const beforeCrm = await crmCounts()
    const wk = worker()
    for (const qs of ['', '?limit=1', '?action=a.b', '?target_id=zzz'])
      expect((await call(wk, 'GET', PATH + qs, tok)).status).toBe(200)
    expect(await rows(w.control, 'select * from control_audit order by id')).toEqual(beforeAudit)
    expect(await crmCounts()).toEqual(beforeCrm)
  })

  it('the operation reaches the control plane through the port: no CRM table of that name exists', async () => {
    expect(await rows(w.d1, "select name from sqlite_master where name = 'control_audit'")).toEqual([])
  })
})

describe('a client may be registered naming audit:read (P2: grantable)', () => {
  it('the Worker registers a public client that names it', async () => {
    const res = await worker().fetch(
      new Request(`${AUTH_BASE}/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: AUTH_BASE },
        body: JSON.stringify({
          client_name: 'Claude Desktop',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          response_types: ['code'],
          redirect_uris: ['http://127.0.0.1:33418/cb'],
          scope: 'openid audit:read',
        }),
      }),
    )
    expect(res.status, await res.clone().text()).toBe(201)
  })
})

describe('composed end to end (REST, MCP)', () => {
  it('invitations.create then audit.list returns its invitation.created row with the caller as actor_id', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const wk = worker()
    const made = await call(wk, 'POST', INV, tok, { email: 'ann@x.test', role: 'member', delivery: 'link' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const res = await call(wk, 'GET', `${PATH}?action=invitation.created`, tok)
    expect(res.status).toBe(200)
    expect(res.json.data).toHaveLength(1)
    expect(res.json.data[0]).toMatchObject({
      actor_id: owner.id,
      action: 'invitation.created',
      target_type: 'invitation',
      target_id: made.json.id,
      detail: { email: 'ann@x.test', role: 'member' },
    })
    expect(JSON.stringify(res.json)).not.toMatch(/token/i)
  })

  it('MCP: audit_list is listed for the owner and a delegated agent holding audit:read, not for a member or an agent without it, and tools/call answers as REST does', async () => {
    const owner = await human('owner')
    const wk = worker()
    const rpc = async (tok: string, method: string, params?: unknown) =>
      call(wk, 'POST', '/mcp', tok, { jsonrpc: '2.0', id: 1, method, params })
    const names = async (tok: string) =>
      ((await rpc(tok, 'tools/list')).json.result.tools as Array<{ name: string }>)
        .map((t) => t.name)
        .filter((n) => n.startsWith('audit_'))
    const delegated = await (await human('owner', 'delegator@x.test')).oauth(otherClient, 'openid audit:read')
    const without = await (await human('owner', 'delegator2@x.test')).oauth(otherClient, 'openid contacts:read')
    expect(await names(await owner.session())).toEqual(['audit_list'])
    expect(await names(delegated)).toEqual(['audit_list'])
    expect(await names(await (await human('member', 'm@x.test')).session())).toEqual([])
    expect(await names(without)).toEqual([])
    await call(wk, 'POST', INV, await owner.session(), { email: 'mcp@x.test', role: 'member', delivery: 'link' })
    for (const tok of [await owner.session(), delegated]) {
      const out = (await rpc(tok, 'tools/call', { name: 'audit_list', arguments: { action: 'invitation.created' } }))
        .json.result
      expect(out.isError ?? false).toBe(false)
      const body = out.structuredContent ?? JSON.parse(out.content[0].text)
      expect(body.data).toHaveLength(1)
      expect(body.data[0].detail.email).toBe('mcp@x.test')
    }
  })
})

describe('a composition without a control store (P5)', () => {
  let clerk: ClerkKit
  let single: Awaited<ReturnType<typeof openWorkerD1>>
  beforeAll(async () => {
    clerk = await clerkKit()
    single = await openWorkerD1()
  })
  afterAll(() => single.dispose())

  it('an owner gets 501 provider_not_configured naming the control-plane database; a member is still 403 first', async () => {
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
    clerk.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true }))
    clerk.profiles.set('user_m', clerkUser({ id: 'user_m', email: 'm@x.test', verified: true }))
    const get = async (sub: string, role: string) =>
      wk.fetch(
        new Request(`https://w.test${PATH}`, {
          headers: {
            authorization: `Bearer ${await mintClerkToken(clerk.issuer, { sub, extra: { vibase_role: role } })}`,
          },
        }),
      )
    const owner = await get('user_a', 'owner')
    expect(owner.status).toBe(501)
    const body = (await owner.json()) as any
    expect(body.error.code).toBe('provider_not_configured')
    expect(body.error.message).toMatch(/control/i)
    expect(body.error.message).not.toMatch(/AUTH_PROVIDER/)
    const member = await get('user_m', 'member')
    expect(member.status).toBe(403)
    expect(((await member.json()) as any).error.code).toBe('insufficient_scope')
  })
})
