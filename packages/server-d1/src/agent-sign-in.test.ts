import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, openControlDb } from '@vibase/storage-d1'
import type { D1Like, D1PreparedLike } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { CLI_CLIENT_ID, resourcesFor, seedFirstPartyClient } from '@vibase/auth'
import { VibaseError, createClient } from '@vibase/sdk'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, DEVICE_GRANT, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, inheritPairing, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE662]] (CORE630 D8, D10, D11) through the Node composition: the REAL Better Auth device and consent flows run on the composed Worker's own `/auth` (the approval-time narrowing lives there), the
// accounts are signed up through a second handler on the same control database (same secret, so the cookies are the Worker's), and every token the assertions use comes out of the real flow.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let bootKey: string
const declared = createVibaseRegistry().declaredScopes()
const REDIRECT = 'https://app.test/cb'
const verifier = 'v'.repeat(60)
const MCP = `${AUTH_BASE}/mcp`
const hintCli = (s: string) =>
  `this sign-in does not include ${s}, which your role holds: run \`vibase login\` to sign in again`
const hintAgent = (s: string) =>
  `this sign-in was made before ${s} was granted to this agent: sign in again as the agent with \`vibase login\``
const hintDelegated = (s: string) =>
  `this connection was approved before ${s} was granted: reconnect the connector to approve it`

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
  bootKey = r.key
  await seedFirstPartyClient(w.control, { baseURL: AUTH_BASE })
  kit = authKit(w.control, { scopes: declared })
})

/** A D1 whose reads of the `agents` table throw while `state.failing` (the record lookup behind the approval). */
function breakable(real: D1Like) {
  const state = { failing: false }
  const d1: D1Like = {
    prepare: (q: string) => {
      if (state.failing && /\bagents\b/.test(q)) throw new Error('CRM database unavailable')
      return real.prepare(q)
    },
    batch: (b: D1PreparedLike[]) => real.batch(b),
  }
  return { d1: inheritPairing(real, d1), state }
}

const env = (db: D1Like = w.d1): D1WorkerEnv => ({
  DB: db,
  CONTROL_DB: w.control,
  AUTH_PROVIDER: 'better-auth',
  AUTH_SECRET,
  PUBLIC_BASE_URL: AUTH_BASE,
})
const worker = (db?: D1Like) => composeD1Worker(env(db))
type Wk = ReturnType<typeof worker>

let ip = 0
/** A call on the Worker's `/auth`, as the pages and the CLI make it. */
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

/** The device flow in its steps: the code, the page's claim read, the approval, the token exchange. */
async function device(wk: Wk, cookie: string, clientId: string, scope: string) {
  const call = authCall(wk)
  const codes = (await (
    await call('/auth/device/code', { body: { client_id: clientId, scope, resource: AUTH_BASE } })
  ).json()) as { device_code: string; user_code: string }
  return {
    claim: () => call(`/auth/device?user_code=${encodeURIComponent(codes.user_code)}`, { cookie }),
    approve: () => call('/auth/device/approve', { cookie, body: { userCode: codes.user_code } }),
    token: () =>
      call('/auth/oauth2/token', {
        form: true,
        body: { grant_type: DEVICE_GRANT, device_code: codes.device_code, client_id: clientId, resource: AUTH_BASE },
      }),
  }
}
/** A whole device login: what the page read after the claim, and the access token. */
async function login(wk: Wk, cookie: string, clientId: string, scope: string) {
  const d = await device(wk, cookie, clientId, scope)
  const claimed = (await (await d.claim()).json()) as { scope: string }
  expect((await d.approve()).status).toBe(200)
  const tok = await d.token()
  const body = (await tok.json()) as { access_token: string }
  expect(tok.status, JSON.stringify(body)).toBe(200)
  return { page: claimed.scope.split(' '), token: body.access_token, claims: claimsOf(body.access_token) }
}
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
const vault = (scopeClaim: string | string[]) =>
  (typeof scopeClaim === 'string' ? scopeClaim.split(' ') : scopeClaim).filter((s) => s.includes(':')).sort()

const api = async (wk: Wk, method: string, path: string, tok: string, body?: unknown) => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const meScopes = async (wk: Wk, tok: string) =>
  ((await api(wk, 'GET', '/meta/v1/me', tok)).json.active_organization.scopes as string[]).slice().sort()

async function person(role: 'owner' | 'member', email: string) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return { id, userId, cookie, session: () => kit.sessionJwt(cookie) }
}
async function agentAccount(scopes: string[], email = `agent-${++ip}@x.test`) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, id)
    .run()
  return { id, userId, cookie }
}
const setRecord = (id: string, scopes: string[]) =>
  w.d1.prepare('update agents set scopes = ? where id = ?').bind(JSON.stringify(scopes), id).run()
const grantable = declared.filter(
  (s) =>
    !/^(agents|members|invitations|oauth_clients):/.test(s) &&
    s !== 'connections:write' &&
    !/^(blocked_senders|forms):write$/.test(s),
)
const DEFAULT_LOGIN = ['openid', 'offline_access', ...grantable].join(' ')

describe('1. an agent account signs in with what its record holds (D11)', () => {
  it('a default login: the token and the page list record ∩ request, OIDC scopes pass', async () => {
    const wk = worker()
    const a = await agentAccount(['contacts:read', 'deals:read'])
    const r = await login(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    expect(vault(r.claims.scope)).toEqual(['contacts:read', 'deals:read'])
    expect(vault(r.page)).toEqual(['contacts:read', 'deals:read'])
    expect(r.page).toContain('openid')
    expect(r.page).toContain('offline_access')
    expect(await meScopes(wk, r.token)).toEqual(['contacts:read', 'deals:read'])
  })

  it('a --scope login: record ∩ the listed scopes, never more than was asked', async () => {
    const wk = worker()
    const a = await agentAccount(['contacts:read', 'deals:read'])
    const r = await login(wk, a.cookie, CLI_CLIENT_ID, 'openid contacts:read contacts:write offline_access')
    expect(vault(r.claims.scope)).toEqual(['contacts:read'])
    expect(vault(r.page)).toEqual(['contacts:read'])
  })

  it('an agent with no grant gets no vault scope; me lists none', async () => {
    const wk = worker()
    const a = await agentAccount([])
    const r = await login(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    expect(vault(r.claims.scope)).toEqual([])
    expect(vault(r.page)).toEqual([])
    expect(await meScopes(wk, r.token)).toEqual([])
  })

  it('a person approving the same request is not narrowed', async () => {
    const wk = worker()
    const o = await person('owner', 'owner@x.test')
    const r = await login(wk, o.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    expect(vault(r.claims.scope)).toEqual([...grantable].sort())
    expect(vault(r.page)).toEqual([...grantable].sort())
  })

  it('a failing record lookup refuses the approval: no page, no approval, no token', async () => {
    const flaky = breakable(w.d1)
    const wk = worker(flaky.d1)
    const a = await agentAccount(['contacts:read'])
    const d = await device(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    flaky.state.failing = true
    expect((await d.claim()).status).toBeGreaterThanOrEqual(400)
    expect((await d.approve()).status).toBeGreaterThanOrEqual(400)
    flaky.state.failing = false
    const tok = await d.token()
    expect(tok.status).not.toBe(200)
    expect(((await tok.json()) as { access_token?: string }).access_token).toBeUndefined()
  })

  it('the record is read again at approval: a grant removed after the claim is not carried', async () => {
    const wk = worker()
    const a = await agentAccount(['contacts:read', 'contacts:write'])
    const d = await device(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    const page = (await (await d.claim()).json()) as { scope: string }
    expect(vault(page.scope)).toEqual(['contacts:read', 'contacts:write'])
    await setRecord(a.id, ['contacts:read'])
    expect((await d.approve()).status).toBe(200)
    const tok = (await (await d.token()).json()) as { access_token: string }
    expect(vault(claimsOf(tok.access_token).scope)).toEqual(['contacts:read'])
  })

  it('an agent account signing in through a connector (the consent page) is narrowed the same way; a person is not', async () => {
    const wk = worker()
    const call = authCall(wk)
    const client = await authKitOverWorker(wk).registerClient('Claude Desktop')
    const ask = [...vault(DEFAULT_LOGIN)].slice(0, 6)
    const consent = async (cookie: string) => {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: client,
        redirect_uri: REDIRECT,
        scope: ['openid', ...ask].join(' '),
        state: 's1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: MCP,
      })
      const authorize = await call(`/auth/oauth2/authorize?${q}`, { cookie })
      const loc = new URL(
        authorize.headers.get('location') ?? ((await authorize.json()) as { url: string }).url,
        AUTH_BASE,
      )
      expect(loc.pathname).toBe('/app/consent')
      const accepted = await call('/auth/oauth2/consent', {
        cookie,
        body: { accept: true, oauth_query: loc.search.slice(1) },
      })
      expect(accepted.status, await accepted.clone().text()).toBe(200)
      const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
      const t = await call('/auth/oauth2/token', {
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
      return vault(claimsOf(((await t.json()) as { access_token: string }).access_token).scope)
    }
    const a = await agentAccount([ask[0]!])
    expect(await consent(a.cookie)).toEqual([ask[0]])
    const o = await person('owner', 'conn-owner@x.test')
    expect(await consent(o.cookie)).toEqual([...ask].sort())
  })
})

/** The kit's registration helper over the Worker's `/auth` (the registered client lands in the shared control database). */
function authKitOverWorker(wk: Wk) {
  const call = authCall(wk)
  return {
    async registerClient(name: string) {
      const res = await call('/auth/oauth2/register', {
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
    },
  }
}

describe('2. the agent story, end to end (D4, D8, D10, D11)', () => {
  it('granted after it signed in: notice to the owner, refused with the hint, signs in again with the same id, a removal applies at once', async () => {
    const wk = worker()
    const o = await person('owner', 'story-owner@x.test')
    const ownerTok = await o.session()
    const a = await agentAccount(['contacts:read'])
    const first = await login(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    const who = (await api(wk, 'GET', '/meta/v1/me', first.token)).json.principal.id as string
    expect(who).toBe(a.id)

    const grant = await api(wk, 'PATCH', `/meta/v1/agents/${a.id}`, ownerTok, { add_scopes: ['contacts:write'] })
    expect(grant.status, JSON.stringify(grant.json)).toBe(200)
    expect(typeof grant.json.sign_in_notice).toBe('string')

    const refused = await api(wk, 'POST', '/api/v1/contacts', first.token, { name: 'Ada' })
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe('insufficient_scope')
    expect(refused.json.error.message).toBe(`requires contacts:write; ${hintAgent('contacts:write')}`)

    const second = await login(wk, a.cookie, CLI_CLIENT_ID, DEFAULT_LOGIN)
    expect(vault(second.claims.scope)).toEqual(['contacts:read', 'contacts:write'])
    expect((await api(wk, 'GET', '/meta/v1/me', second.token)).json.principal.id).toBe(a.id)
    expect((await api(wk, 'POST', '/api/v1/contacts', second.token, { name: 'Ada' })).status).toBe(201)

    const removal = await api(wk, 'PATCH', `/meta/v1/agents/${a.id}`, ownerTok, { remove_scopes: ['contacts:write'] })
    expect(removal.json.sign_in_notice).toBeNull()
    const gone = await api(wk, 'POST', '/api/v1/contacts', second.token, { name: 'Bob' })
    expect(gone.status).toBe(403)
    expect(gone.json.error.message).toBe('requires contacts:write')
  })
})

describe('3. when the refusal hint shows (D8)', () => {
  const TENANT = { method: 'POST', path: '/api/v1/contacts', body: { name: 'Ada' }, scope: 'contacts:write' }
  const CONTROL = { method: 'GET', path: '/meta/v1/audit', body: undefined, scope: 'audit:read' }
  const ops = [
    ['a tenant operation', TENANT],
    ['a control operation', CONTROL],
  ] as const
  const msg = (r: { json: any }) => r.json.error.message as string

  describe.each(ops)('on %s', (_n, op) => {
    const tryOp = (wk: Wk, tok: string) => api(wk, op.method, op.path, tok, op.body)
    const listLogin = (hold: boolean) =>
      hold ? `openid offline_access ${op.scope}` : 'openid offline_access tags:read'

    it('a CLI person: the hint when the role holds the scope and the token lacks it; none when the token has it or the role lacks it', async () => {
      const wk = worker()
      const o = await person('owner', 'cli-owner@x.test')
      const missing = await tryOp(wk, (await login(wk, o.cookie, CLI_CLIENT_ID, listLogin(false))).token)
      expect(missing.status).toBe(403)
      expect(msg(missing)).toBe(`requires ${op.scope}; ${hintCli(op.scope)}`)
      const held = await tryOp(wk, (await login(wk, o.cookie, CLI_CLIENT_ID, listLogin(true))).token)
      expect(held.status).toBeLessThan(300)
      if (op.scope === 'audit:read') {
        const m = await person('member', 'cli-member@x.test')
        const notHeld = await tryOp(wk, (await login(wk, m.cookie, CLI_CLIENT_ID, listLogin(true))).token)
        expect(notHeld.status).toBe(403)
        expect(msg(notHeld)).toBe(`requires ${op.scope}`)
      } else {
        const m = await person('member', 'cli-member2@x.test')
        const notHeld = await api(
          wk,
          'POST',
          '/meta/v1/agents',
          (await login(wk, m.cookie, CLI_CLIENT_ID, 'openid agents:write')).token,
          { name: 'x' },
        )
        expect(notHeld.status).toBe(403)
        expect(msg(notHeld)).toBe('requires agents:write')
      }
    })

    it('an agent account: the hint when the record holds it and the token lacks it; none when the token has it or the record lacks it', async () => {
      const wk = worker()
      const a = await agentAccount([op.scope, 'tags:read'])
      const missing = await tryOp(wk, (await login(wk, a.cookie, CLI_CLIENT_ID, listLogin(false))).token)
      expect(msg(missing)).toBe(`requires ${op.scope}; ${hintAgent(op.scope)}`)
      const held = await tryOp(wk, (await login(wk, a.cookie, CLI_CLIENT_ID, listLogin(true))).token)
      expect(held.status).toBeLessThan(300)
      await setRecord(a.id, ['tags:read'])
      const notHeld = await tryOp(wk, (await login(wk, a.cookie, CLI_CLIENT_ID, listLogin(true))).token)
      expect(notHeld.status).toBe(403)
      expect(msg(notHeld)).toBe(`requires ${op.scope}`)
    })

    it('a delegated agent: the hint when its record and the role hold it and the token lacks it; none otherwise', async () => {
      const wk = worker()
      const o = await person('owner', 'del-owner@x.test')
      const client = await authKitOverWorker(wk).registerClient('Claude Desktop')
      const first = (await login(wk, o.cookie, client, listLogin(false))).token
      const missing = await tryOp(wk, first)
      expect(msg(missing)).toBe(`requires ${op.scope}; ${hintDelegated(op.scope)}`)
      const held = await tryOp(wk, (await login(wk, o.cookie, client, listLogin(true))).token)
      expect(held.status).toBeLessThan(300)
      await w.d1.prepare('update agents set scopes = \'["tags:read"]\' where auth_client_id = ?').bind(client).run()
      const notHeld = await tryOp(wk, first)
      expect(msg(notHeld)).toBe(`requires ${op.scope}`)
    })

    it('never for an API key, a session, or a first-party app', async () => {
      const wk = worker()
      await w.d1.prepare("update agents set scopes = '[]' where auth_subject is null and auth_client_id is null").run()
      const key = await tryOp(wk, bootKey)
      expect(key.status).toBe(403)
      expect(msg(key)).toBe(`requires ${op.scope}`)
      const m = await person('member', 'sess-member@x.test')
      const session = await tryOp(wk, await m.session())
      if (op.scope === 'audit:read') expect(msg(session)).toBe(`requires ${op.scope}`)
      const o = await person('owner', 'fp-owner@x.test')
      const app = (await createOAuthClient(openControlDb(w.control), {
        organizationId: orgId,
        clientId: `app_${uuidv7(NOW).slice(-20)}`,
        name: 'Deals board',
        redirectUris: [REDIRECT],
        scopes: ['openid', 'tags:read'],
        skipConsent: true,
        resources: resourcesFor(AUTH_BASE),
        actorId: bootUser,
        now: new Date().toISOString(),
        newId: () => uuidv7(NOW),
      })) as { clientId: string }
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: app.clientId,
        redirect_uri: REDIRECT,
        scope: 'openid tags:read',
        state: 's1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: AUTH_BASE,
      })
      const a = await authCall(wk)(`/auth/oauth2/authorize?${q}`, { cookie: o.cookie })
      const aloc = a.headers.get('location') ?? ((await a.clone().json()) as { url: string }).url
      const code = new URL(aloc, AUTH_BASE).searchParams.get('code')!
      expect(code, `authorize answered ${a.status} ${aloc}`).toBeTruthy()
      const t = await authCall(wk)('/auth/oauth2/token', {
        form: true,
        body: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: app.clientId,
          resource: AUTH_BASE,
        },
      })
      const tb = (await t.json()) as { access_token: string }
      expect(t.status, JSON.stringify(tb)).toBe(200)
      const appRes = await tryOp(wk, tb.access_token)
      expect(appRes.status).toBe(403)
      expect(msg(appRes)).toBe(`requires ${op.scope}`)
    })
  })
})

describe('4. the hint reaches whoever was refused (D8 delivery)', () => {
  async function refusedAgent() {
    const wk = worker()
    const a = await agentAccount(['tags:read', 'contacts:write', 'audit:read'])
    const t = await login(wk, a.cookie, CLI_CLIENT_ID, 'openid offline_access tags:read')
    return { wk, a, token: t.token }
  }

  it("the SDK's VibaseError carries the hint in message", async () => {
    const { wk, token } = await refusedAgent()
    const client = createClient({
      url: AUTH_BASE,
      auth: token,
      fetch: ((i: RequestInfo | URL, init?: RequestInit) => wk.fetch(new Request(i, init))) as typeof fetch,
    })
    const err = await client.contacts.create({ name: 'Ada' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VibaseError)
    expect((err as VibaseError).code).toBe('insufficient_scope')
    expect((err as VibaseError).message).toContain(hintAgent('contacts:write'))
  })

  it('MCP lists a tool held live and missing from the token with the hint first, calling it returns the hint, and a tool not held live stays hidden', async () => {
    const { wk, a, token } = await refusedAgent()
    const rpc = async (method: string, params?: unknown) =>
      (
        (await (
          await wk.fetch(
            new Request(MCP, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            }),
          )
        ).json()) as any
      ).result
    await setRecord(a.id, ['tags:read', 'contacts:write'])
    const tools = (await rpc('tools/list')).tools as Array<{ name: string; description: string }>
    const create = tools.find((t) => t.name === 'contacts_create')
    expect(create, 'a tool held live and missing from the token is listed').toBeTruthy()
    expect(create!.description.startsWith(hintAgent('contacts:write'))).toBe(true)
    expect(tools.find((t) => t.name === 'audit_list')).toBeUndefined()
    expect(tools.find((t) => t.name === 'tags_list')).toBeTruthy()
    const called = await rpc('tools/call', { name: 'contacts_create', arguments: { name: 'Ada' } })
    expect(called.isError).toBe(true)
    expect(called.structuredContent.error.code).toBe('insufficient_scope')
    expect(called.structuredContent.error.message).toContain(hintAgent('contacts:write'))
  })
})

describe('5. the owner is told (D10)', () => {
  async function owner() {
    const o = await person('owner', 'notice-owner@x.test')
    return o.session()
  }
  const patch = (wk: Wk, tok: string, id: string, body: unknown) => api(wk, 'PATCH', `/meta/v1/agents/${id}`, tok, body)

  it('an agent account: an unconditional notice when a scope is added; null when it only removes or renames', async () => {
    const wk = worker()
    const tok = await owner()
    const a = await agentAccount(['contacts:read'])
    const added = await patch(wk, tok, a.id, { add_scopes: ['contacts:write'] })
    expect(typeof added.json.sign_in_notice).toBe('string')
    expect(added.json.sign_in_notice.length).toBeGreaterThan(0)
    // a whole-list replacement that adds a scope is an addition too
    const replaced = await patch(wk, tok, a.id, { scopes: ['contacts:read', 'contacts:write', 'deals:read'] })
    expect(typeof replaced.json.sign_in_notice).toBe('string')
    expect((await patch(wk, tok, a.id, { remove_scopes: ['deals:read'] })).json.sign_in_notice).toBeNull()
    expect((await patch(wk, tok, a.id, { name: 'renamed' })).json.sign_in_notice).toBeNull()
  })

  it('a delegated agent: a conditional reconnect notice, different from the agent account one; an API-key agent: null', async () => {
    const wk = worker()
    const tok = await owner()
    const a = await agentAccount(['contacts:read'])
    const accountNotice = (await patch(wk, tok, a.id, { add_scopes: ['contacts:write'] })).json.sign_in_notice
    const d = uuidv7(NOW)
    await seedAgent(w.d1, { id: d, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read'] })
    const human = (await w.d1.prepare('select id from users where auth_subject is null limit 1').first()) as {
      id: string
    }
    await w.d1
      .prepare('update agents set auth_provider = ?, auth_client_id = ?, delegated_by = ? where id = ?')
      .bind('better-auth', 'client_x', human.id, d)
      .run()
    const delegated = await patch(wk, tok, d, { add_scopes: ['contacts:write'] })
    expect(delegated.status, JSON.stringify(delegated.json)).toBe(200)
    expect(typeof delegated.json.sign_in_notice).toBe('string')
    expect(delegated.json.sign_in_notice).not.toEqual(accountNotice)
    expect((await patch(wk, tok, d, { remove_scopes: ['contacts:write'] })).json.sign_in_notice).toBeNull()
    const key = (await w.d1
      .prepare('select id from agents where auth_subject is null and auth_client_id is null limit 1')
      .first()) as { id: string }
    const keyAgent = await patch(wk, tok, key.id, { add_scopes: ['contacts:write'] })
    expect(keyAgent.status).toBe(200)
    expect(keyAgent.json.sign_in_notice).toBeNull()
  })

  it('get and list do not carry the field', async () => {
    const wk = worker()
    const tok = await owner()
    const a = await agentAccount(['contacts:read'])
    const got = await api(wk, 'GET', `/meta/v1/agents/${a.id}`, tok)
    expect(got.json).not.toHaveProperty('sign_in_notice')
    const list = await api(wk, 'GET', '/meta/v1/agents', tok)
    for (const row of list.json.data) expect(row).not.toHaveProperty('sign_in_notice')
  })
})
