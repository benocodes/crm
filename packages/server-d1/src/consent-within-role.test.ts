import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import type { D1Like, D1PreparedLike } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry, grantableScopes as grantableOf, scopesForRole } from '@vibase/api'
import { CLI_CLIENT_ID, seedFirstPartyClient } from '@vibase/auth'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, DEVICE_GRANT, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, inheritPairing, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE673]] (CORE666 D11): on the built-in provider a person approves for a connector only what their live role holds. The REAL Better Auth runs on the composed Worker's `/auth`: the hook narrows an accepting
// `/oauth2/consent` to requested ∩ the approving account's bound (person: live role; agent account: its record), the page reads the same bound at `GET /auth/consent-bound`, and the device flow is not narrowed for a person.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableOf(declared)
const REDIRECT = 'https://app.test/cb'
const MCP = `${AUTH_BASE}/mcp`
const verifier = 'v'.repeat(60)
const MEMBER_ROLE = scopesForRole('member', declared)
  .toStrings()
  .filter((s) => grantable.includes(s))

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
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
  orgId = r.organizationId
  bootUser = r.userId!
  await seedFirstPartyClient(w.control, { baseURL: AUTH_BASE })
  kit = authKit(w.control, { scopes: declared })
})

/** A D1 whose reads of `agents` and `memberships` throw while `state.failing` (the read behind the bound). */
function breakable(real: D1Like) {
  const state = { failing: false }
  const d1: D1Like = {
    prepare: (q: string) => {
      if (state.failing && /\b(agents|memberships)\b/.test(q)) throw new Error('CRM database unavailable')
      return real.prepare(q)
    },
    batch: (b: D1PreparedLike[]) => real.batch(b),
  }
  return { d1: inheritPairing(real, d1), state }
}
const worker = (db: D1Like = w.d1) =>
  composeD1Worker({
    DB: db,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  } as D1WorkerEnv)
type Wk = ReturnType<typeof worker>

let ip = 0
const authCall =
  (wk: Wk) =>
  (path: string, init: { body?: unknown; form?: boolean; cookie?: string } = {}) =>
    wk.fetch(
      new Request(AUTH_BASE + path, {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: {
          origin: AUTH_BASE,
          'cf-connecting-ip': `198.51.100.${(ip++ % 200) + 1}`,
          ...(init.body === undefined
            ? {}
            : { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body:
          init.body === undefined
            ? undefined
            : init.form
              ? new URLSearchParams(init.body as Record<string, string>).toString()
              : JSON.stringify(init.body),
      }),
    )
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
const vault = (scopeClaim: string | string[]) =>
  (typeof scopeClaim === 'string' ? scopeClaim.split(' ') : scopeClaim).filter((s) => s.includes(':')).sort()

async function person(role: 'owner' | 'member' | 'none', email: string) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  if (role !== 'none') {
    await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
    await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  }
  return { id, userId, cookie }
}
async function agentAccount(scopes: string[], email: string) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, id)
    .run()
  return { id, userId, cookie }
}
async function registerClient(wk: Wk, name: string) {
  const res = await authCall(wk)('/auth/oauth2/register', {
    body: {
      client_name: name,
      token_endpoint_auth_method: 'none',
      resources: [AUTH_BASE, MCP],
      grant_types: ['authorization_code', DEVICE_GRANT, 'refresh_token'],
      response_types: ['code'],
      scope: ['openid', 'offline_access', ...grantable].join(' '),
      redirect_uris: [REDIRECT],
    },
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

/** A connector's authorize: where the library sent the browser (`page` is true on the consent page, false when a stored consent already covers the request), and the signed query. */
async function authorize(wk: Wk, cookie: string, client: string, scope: string) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: REDIRECT,
    scope,
    state: 's1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: MCP,
  })
  const res = await authCall(wk)(`/auth/oauth2/authorize?${q}`, { cookie })
  const loc = new URL(res.headers.get('location') ?? ((await res.json()) as { url: string }).url, AUTH_BASE)
  return { page: loc.pathname === '/app/consent', loc }
}
async function exchange(wk: Wk, client: string, redirect: URL) {
  const code = redirect.searchParams.get('code')!
  const t = await authCall(wk)('/auth/oauth2/token', {
    form: true,
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client,
      resource: MCP,
    },
  })
  return (await t.json()) as { access_token: string; scope?: string }
}
/** A connector consent end to end: authorize, accept with `accept` (or the page's default: the whole request), exchange. */
async function connect(wk: Wk, cookie: string, client: string, scope: string, accept?: string) {
  const a = await authorize(wk, cookie, client, scope)
  expect(a.page, 'the consent page is shown').toBe(true)
  const res = await authCall(wk)('/auth/oauth2/consent', {
    cookie,
    body: { accept: true, oauth_query: a.loc.search.slice(1), ...(accept !== undefined ? { scope: accept } : {}) },
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const redirect = new URL(((await res.json()) as { url: string }).url)
  const tok = await exchange(wk, client, redirect)
  return { token: tok.access_token, scopes: vault(claimsOf(tok.access_token).scope) }
}
const bound = async (wk: Wk, cookie?: string) => {
  const res = await authCall(wk)('/auth/consent-bound', cookie ? { cookie } : {})
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as { kind: string; scopes: string[] }) : null }
}

const ASK = 'openid offline_access contacts:read webhooks:read audit:read'

describe('1. the hook: an accepting consent holds the approving account (matrix: account x accept body)', () => {
  it('an owner keeps every scope they ask for', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const o = await person('owner', 'owner@x.test')
    expect((await connect(wk, o.cookie, client, ASK)).scopes).toEqual(['audit:read', 'contacts:read', 'webhooks:read'])
  })

  it('a member loses the scopes their role lacks, whether the page sent them or a hand-made body did', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const m = await person('member', 'member@x.test')
    expect((await connect(wk, m.cookie, client, ASK)).scopes).toEqual(['contacts:read'])
    expect((await connect(wk, m.cookie, client, ASK, 'contacts:read webhooks:read audit:read')).scopes).toEqual([
      'contacts:read',
    ])
  })

  it('a scope switched off on the page stays off even when the role holds it', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const m = await person('member', 'member@x.test')
    const r = await connect(wk, m.cookie, client, 'openid contacts:read companies:read', 'openid contacts:read')
    expect(r.scopes).toEqual(['contacts:read'])
  })

  it('a person with no live membership gets no vault scope; OIDC scopes and offline_access pass', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const n = await person('none', 'nobody@x.test')
    const r = await connect(wk, n.cookie, client, ASK)
    expect(r.scopes).toEqual([])
    expect(claimsOf(r.token).scope).toContain('openid')
  })

  it('an agent account is narrowed to its record, as before', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const a = await agentAccount(['contacts:read'], 'agent@x.test')
    expect((await connect(wk, a.cookie, client, ASK)).scopes).toEqual(['contacts:read'])
  })

  it('a bound read that throws refuses the accept, for a person and for an agent account: no code, no token', async () => {
    const flaky = breakable(w.d1)
    const wk = worker(flaky.d1)
    const client = await registerClient(wk, 'Claude')
    const m = await person('member', 'member@x.test')
    const a = await agentAccount(['contacts:read'], 'agent@x.test')
    for (const cookie of [m.cookie, a.cookie]) {
      const page = await authorize(wk, cookie, client, ASK)
      flaky.state.failing = true
      const res = await authCall(wk)('/auth/oauth2/consent', {
        cookie,
        body: { accept: true, oauth_query: page.loc.search.slice(1) },
      })
      flaky.state.failing = false
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(await res.text()).not.toContain('code=')
    }
  })

  it("a person's device approval is not narrowed by this cycle: a member keeps an out-of-role scope on the CLI's token (P2)", async () => {
    const wk = worker()
    const m = await person('member', 'member@x.test')
    const tokens = await kit.deviceTokens(
      m.cookie,
      CLI_CLIENT_ID,
      ['openid', 'offline_access', 'webhooks:read', 'contacts:read'].join(' '),
    )
    expect(vault(claimsOf(tokens.access_token).scope)).toEqual(['contacts:read', 'webhooks:read'])
    void wk
  })
})

describe('2. the shared bound and the page read (P3, P4)', () => {
  it('answers 401 with no session, and reads nothing', async () => {
    const wk = worker()
    expect((await bound(wk)).status).toBe(401)
  })

  it('an owner, a member, no membership and an agent account each get their kind and list', async () => {
    const wk = worker()
    const o = await person('owner', 'owner@x.test')
    const m = await person('member', 'member@x.test')
    const n = await person('none', 'nobody@x.test')
    const a = await agentAccount(['contacts:read', 'contacts:write'], 'agent@x.test')
    const owner = await bound(wk, o.cookie)
    expect(owner.json).toEqual({ kind: 'person', scopes: [...grantable].sort() })
    const member = await bound(wk, m.cookie)
    expect(member.json).toEqual({ kind: 'person', scopes: [...MEMBER_ROLE].sort() })
    expect(member.json!.scopes).not.toContain('webhooks:read')
    expect(member.json!.scopes).not.toContain('audit:read')
    expect((await bound(wk, n.cookie)).json).toEqual({ kind: 'person', scopes: [] })
    expect((await bound(wk, a.cookie)).json).toEqual({
      kind: 'agent',
      scopes: ['contacts:read', 'contacts:request_approval', 'contacts:write'],
    })
  })

  it('a member bound is closed: a held write holds its request_approval, a held read its read_metadata', async () => {
    const wk = worker()
    const m = await person('member', 'member@x.test')
    const list = (await bound(wk, m.cookie)).json!.scopes
    for (const s of list) {
      if (s.endsWith(':write')) expect(list, s).toContain(s.replace(/:write$/, ':request_approval'))
      if (s.endsWith(':read') && declared.includes(s.replace(/:read$/, ':read_metadata')))
        expect(list, s).toContain(s.replace(/:read$/, ':read_metadata'))
    }
  })

  it('the route and the hook use one list: asking for everything grantable yields exactly the route list on the token', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const m = await person('member', 'member@x.test')
    const listed = (await bound(wk, m.cookie)).json!.scopes
    const r = await connect(wk, m.cookie, client, ['openid', ...grantable].join(' '))
    expect(r.scopes).toEqual([...listed].sort())
  })

  it('a role raised after the bound was read is read live: the next read holds the new scopes', async () => {
    const wk = worker()
    const m = await person('member', 'member@x.test')
    expect((await bound(wk, m.cookie)).json!.scopes).not.toContain('webhooks:read')
    await w.d1.prepare("update memberships set role = 'owner' where user_id = ?").bind(m.id).run()
    expect((await bound(wk, m.cookie)).json!.scopes).toContain('webhooks:read')
  })
})

describe('3. a raised role reaches the record through a new consent (666.26, D1, D2)', () => {
  it('the stored consent is the narrowed list, so the same request shows the page again once the role is raised', async () => {
    const wk = worker()
    const client = await registerClient(wk, 'Claude')
    const m = await person('member', 'member@x.test')
    const ask = 'openid offline_access contacts:read webhooks:read'
    const first = await connect(wk, m.cookie, client, ask)
    expect(first.scopes).toEqual(['contacts:read'])
    const meOf = async (tok: string) =>
      wk.fetch(new Request(`${AUTH_BASE}/meta/v1/me`, { headers: { authorization: `Bearer ${tok}` } }))
    expect((await meOf(first.token)).status).toBe(200)
    const record = async () =>
      JSON.parse(
        (
          (await w.d1.prepare('select scopes from agents where auth_client_id = ?').bind(client).first()) as {
            scopes: string
          }
        ).scopes,
      ) as string[]
    expect(await record()).toEqual(['contacts:read'])
    // The stored consent is the narrowed list, so it does not cover this request: the page is shown (666.24's revisit: a member is shown it again on each reconnect that asks out-of-role scopes).
    expect((await authorize(wk, m.cookie, client, ask)).page).toBe(true)
    await w.d1.prepare("update memberships set role = 'owner' where user_id = ?").bind(m.id).run()
    const second = await connect(wk, m.cookie, client, ask)
    expect(second.scopes).toEqual(['contacts:read', 'webhooks:read'])
    expect((await meOf(second.token)).status).toBe(200)
    expect(await record()).toEqual(['contacts:read', 'webhooks:read'])
    const agent = (await w.d1.prepare('select id from agents where auth_client_id = ?').bind(client).first()) as {
      id: string
    }
    const updated = (await w.d1
      .prepare("select count(*) n from events where resource_id = ? and type = 'agent.updated'")
      .bind(agent.id)
      .first()) as { n: number }
    expect(updated.n).toBe(1)
  })
})
