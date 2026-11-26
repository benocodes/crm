import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import type { D1Like } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { createCustomTables, projectsDefinition } from '@vibase/api/test/custom-objects'
import { CLI_CLIENT_ID, registrationScopes, seedFirstPartyClient } from '@vibase/auth'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, DEVICE_GRANT, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, inheritPairing, NOW, openWorkerPair, spyD1, type WorkerPair } from './test/kit.js'

// [[CORE661]] ([[CORE630]] D9): a connector that registered itself before an object was declared reconnects with the SAME client. Two Worker compositions run over the same control and CRM databases: A declares no
// custom object, B declares `projects__c`, which is what a `redeploy --schema` does to a live instance. Every flow runs through the real Better Auth authorize, consent and token endpoints on the composed Worker's `/auth`.
let w: WorkerPair
let kit: AuthKit
let orgId: string
const REDIRECT = 'https://client.test/callback'
const MCP = `${AUTH_BASE}/mcp`
const verifier = 'v'.repeat(60)
const declaredA = createVibaseRegistry().declaredScopes()
const declaredB = createVibaseRegistry({ definitions: [projectsDefinition()] }).declaredScopes()
const grantableA = grantableScopes(declaredA)
const grantableB = grantableScopes(declaredB)
const ALLOWED_B = registrationScopes(declaredB, grantableB, defaultGrantScopes(declaredB)).allowed
const DEFAULTS_B = registrationScopes(declaredB, grantableB, defaultGrantScopes(declaredB)).defaults
const ALLOWED_A = registrationScopes(declaredA, grantableA, defaultGrantScopes(declaredA)).allowed
const NEW = ['projects__c:read', 'projects__c:write', 'projects__c:request_approval']
const set = (s: string | null | undefined) => (s ?? '').split(' ').filter(Boolean).sort()
const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

beforeAll(async () => {
  w = await openWorkerPair()
  await createCustomTables(w.d1)
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
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control), definitions: [projectsDefinition()] },
  )
  orgId = r.organizationId
  await seedFirstPartyClient(w.control, { baseURL: AUTH_BASE })
  kit = authKit(w.control, { scopes: declaredB })
})

const env = (control: D1Like = w.control): D1WorkerEnv => ({
  DB: w.d1,
  CONTROL_DB: control,
  AUTH_PROVIDER: 'better-auth',
  AUTH_SECRET,
  PUBLIC_BASE_URL: AUTH_BASE,
})
/** The Worker before the object was declared, and after. */
const workerA = (control?: D1Like) => composeD1Worker(env(control))
const workerB = (control?: D1Like) => composeD1Worker(env(control), { definitions: [projectsDefinition()] })
type Wk = ReturnType<typeof workerA>

let ip = 0
const authCall =
  (wk: Wk) =>
  (path: string, init: { body?: unknown; form?: boolean; cookie?: string; method?: string } = {}) =>
    wk.fetch(
      new Request(AUTH_BASE + path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
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

async function owner(email = 'owner@x.test') {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role: 'owner' })
  return { id, userId, cookie, session: () => kit.sessionJwt(cookie) }
}

/** A client registers itself as Claude web does: every scope listed, no session. */
async function register(wk: Wk, scopes: readonly string[], name = 'Claude Web'): Promise<string> {
  const res = await authCall(wk)('/auth/oauth2/register', {
    body: {
      client_name: name,
      token_endpoint_auth_method: 'none',
      resources: [AUTH_BASE, MCP],
      grant_types: ['authorization_code', DEVICE_GRANT, 'refresh_token'],
      response_types: ['code'],
      scope: ['openid', 'offline_access', ...scopes].join(' '),
      redirect_uris: [REDIRECT],
    },
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

const challenge = createHash('sha256').update(verifier).digest('base64url')
const authorizeParams = (clientId: string, scope?: string) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  ...(scope === undefined ? {} : { scope }),
  state: 'st',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: MCP,
})

/** The authorize request as the library answered it: where it sent the browser (a redirect or the JSON form of one). */
async function authorize(wk: Wk, clientId: string, scope: string | undefined, cookie?: string, method = 'GET') {
  const params = authorizeParams(clientId, scope)
  const res =
    method === 'GET'
      ? await authCall(wk)(`/auth/oauth2/authorize?${new URLSearchParams(params)}`, { cookie })
      : await authCall(wk)('/auth/oauth2/authorize', { body: params, form: true, cookie })
  const text = await res.clone().text()
  let raw = res.headers.get('location')
  if (!raw) {
    try {
      raw = (JSON.parse(text) as { url?: string }).url ?? null
    } catch {
      raw = null
    }
  }
  return { status: res.status, text: `${res.status} ${raw ?? ''} ${text}`, url: raw ? new URL(raw, AUTH_BASE) : null }
}

/** Consent and the code exchange for a consent URL; the access token. */
async function consentToToken(wk: Wk, clientId: string, consent: URL, cookie: string): Promise<string> {
  expect(consent.pathname).toBe('/app/consent')
  const accepted = await authCall(wk)('/auth/oauth2/consent', {
    cookie,
    body: { accept: true, oauth_query: consent.search.slice(1) },
  })
  expect(accepted.status, await accepted.clone().text()).toBe(200)
  const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
  const tok = await authCall(wk)('/auth/oauth2/token', {
    form: true,
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: MCP,
    },
  })
  expect(tok.status, await tok.clone().text()).toBe(200)
  return ((await tok.json()) as { access_token: string }).access_token
}

const storedScopes = async (clientId: string) => {
  const row = (await w.control
    .prepare('select scopes from auth_oauth_clients where client_id = ?')
    .bind(clientId)
    .first()) as { scopes: string | null } | null
  return row ? (row.scopes === null ? null : (JSON.parse(row.scopes) as string[])) : undefined
}
const setStored = (clientId: string, scopes: string[] | null) =>
  w.control
    .prepare('update auth_oauth_clients set scopes = ? where client_id = ?')
    .bind(scopes === null ? null : JSON.stringify(scopes), clientId)
    .run()

describe('1. a connector reconnects with its own client after an object is declared (D9)', () => {
  it('a scope-less authorize, the same client and delegated agent, the wider consent reaches the record, so the new scope is usable on the same token', async () => {
    const o = await owner()
    const ownerTok = await o.session()
    const a = workerA()
    const b = workerB()
    const client = await register(a, grantableA)
    expect(new Set((await storedScopes(client))!)).not.toContain('projects__c:read')

    // The first connection, on the Worker before the object existed.
    const first = await authorize(a, client, undefined, o.cookie)
    expect(first.url?.pathname, first.text).toBe('/app/consent')
    const firstTok = await consentToToken(a, client, first.url!, o.cookie)
    const agentId = (await api(a, 'GET', '/meta/v1/me', firstTok)).json.principal.id as string

    // The object is declared; the same client authorizes again with no scope.
    const second = await authorize(b, client, undefined, o.cookie)
    expect(second.url?.pathname, second.text).toBe('/app/consent')
    expect(set(second.url!.searchParams.get('scope'))).toEqual([...DEFAULTS_B].sort())
    expect(second.url!.searchParams.get('scope')).toContain('projects__c:read')
    const secondTok = await consentToToken(b, client, second.url!, o.cookie)
    expect(set(claims(secondTok).scope)).toEqual(expect.arrayContaining(NEW))
    expect((await api(b, 'GET', '/meta/v1/me', secondTok)).json.principal.id).toBe(agentId)

    // [[CORE666]] D1, D10: the wider consent reaches the record by itself, so the new scope is usable on the same token with no owner grant.
    const used = await api(b, 'GET', '/api/v1/projects__c', secondTok)
    expect(used.status, JSON.stringify(used.json)).toBe(200)
    expect(ownerTok).toBeTruthy()
  })

  it('the same authorize with the scopes named (the protected-resource list) passes too', async () => {
    const o = await owner()
    const client = await register(workerA(), grantableA)
    const named = ['openid', 'offline_access', ...grantableB].join(' ')
    const res = await authorize(workerB(), client, named, o.cookie)
    expect(res.url?.pathname, res.text).toBe('/app/consent')
    expect(set(res.url!.searchParams.get('scope'))).toEqual(set(named))
  })

  it('a POST authorize converges the same way', async () => {
    const o = await owner()
    const client = await register(workerA(), grantableA)
    const res = await authorize(workerB(), client, undefined, o.cookie, 'POST')
    expect(res.url?.pathname, res.text).toBe('/app/consent')
    expect(set(res.url!.searchParams.get('scope'))).toContain('projects__c:read')
  })
})

describe('2. which client rows D9 touches, and how', () => {
  const UPDATE = /update\s+"?auth_oauth_clients"?/i
  const FORBIDDEN = ['all_permissions', 'agents:write', 'members:write', 'oauth_clients:write']
  const missing = () => ALLOWED_A.filter((s) => !NEW.includes(s))
  const covering = () => [...ALLOWED_B]

  /** One authorize on B over a spied control database; what the stored list became, and the UPDATE statements on the clients table. */
  async function run(clientId: string, method = 'GET') {
    const spy = spyD1(w.control)
    const res = await authorize(workerB(spy.d1), clientId, undefined, undefined, method)
    return { res, after: await storedScopes(clientId), writes: spy.log.statements.filter((s) => UPDATE.test(s)) }
  }
  const dynamic = async (list: string[]) => {
    const client = await register(workerA(), grantableA)
    await setStored(client, list)
    return client
  }

  it('a dynamically registered client missing entries is converged: stored ∪ allowed, one write', async () => {
    const client = await dynamic(missing())
    const r = await run(client)
    expect(r.writes).toHaveLength(1)
    expect([...r.after!].sort()).toEqual([...new Set([...missing(), ...ALLOWED_B])].sort())
  })

  it('a covering list is not written', async () => {
    const client = await dynamic(covering())
    const before = await storedScopes(client)
    const r = await run(client)
    expect(r.writes).toEqual([])
    expect(r.after).toEqual(before)
  })

  it('an entry outside today’s allowed list stays, and the result never holds the wildcard or a human-only scope', async () => {
    const client = await dynamic([...missing(), 'retired__c:read'])
    const r = await run(client)
    expect(r.after).toContain('retired__c:read')
    expect(r.after).toEqual(expect.arrayContaining(NEW))
    for (const f of FORBIDDEN) expect(r.after, f).not.toContain(f)
  })

  it('a first-party app (reference_id set) is left as it is', async () => {
    const client = await dynamic(missing())
    await w.control
      .prepare('update auth_oauth_clients set reference_id = ? where client_id = ?')
      .bind(orgId, client)
      .run()
    const r = await run(client)
    expect(r.writes).toEqual([])
    expect(r.after).toEqual(missing())
  })

  it('a client with user_id set is left as it is', async () => {
    const o = await owner()
    const client = await dynamic(missing())
    await w.control
      .prepare('update auth_oauth_clients set user_id = ? where client_id = ?')
      .bind(o.userId, client)
      .run()
    const r = await run(client)
    expect(r.writes).toEqual([])
    expect(r.after).toEqual(missing())
  })

  it('a disabled client is left as it is', async () => {
    const client = await dynamic(missing())
    await w.control.prepare('update auth_oauth_clients set disabled = 1 where client_id = ?').bind(client).run()
    const r = await run(client)
    expect(r.writes).toEqual([])
    expect(r.after).toEqual(missing())
  })

  it('vibase-cli (a NULL list) is left NULL', async () => {
    const r = await run(CLI_CLIENT_ID)
    expect(r.writes).toEqual([])
    expect(r.after).toBeNull()
  })

  it('an unknown client id writes nothing and creates no row', async () => {
    const r = await run('no-such-client')
    expect(r.writes).toEqual([])
    expect(r.after).toBeUndefined()
    expect(r.res.text).toContain('invalid_client')
  })

  it('a failing write does not break the authorize: the library answers as it did before, the row is unchanged', async () => {
    const client = await dynamic(missing())
    const failing: D1Like = {
      prepare: (q: string) => {
        if (UPDATE.test(q)) throw new Error('control database unavailable')
        return w.control.prepare(q)
      },
      batch: (b) => w.control.batch(b),
    }
    const res = await authorize(workerB(inheritPairing(w.control, failing)), client, undefined)
    expect(res.status).toBe(302)
    expect(res.text).toContain('invalid_scope')
    expect(await storedScopes(client)).toEqual(missing())
  })

  it('a POST authorize converges a stored list too', async () => {
    const client = await dynamic(missing())
    const r = await run(client, 'POST')
    expect(r.writes).toHaveLength(1)
    expect(r.after).toEqual(expect.arrayContaining(NEW))
  })
})

describe('3. nothing else moves', () => {
  it('a covering client still gets the default fill, never its stored ceiling; its row is not written', async () => {
    const o = await owner()
    const client = await register(workerB(), grantableB)
    const before = await storedScopes(client)
    const spy = spyD1(w.control)
    const res = await authorize(workerB(spy.d1), client, undefined, o.cookie)
    expect(res.url?.pathname, res.text).toBe('/app/consent')
    expect(set(res.url!.searchParams.get('scope'))).toEqual([...DEFAULTS_B].sort())
    expect(DEFAULTS_B).not.toContain('audit:read')
    expect(before).toContain('audit:read')
    expect(await storedScopes(client)).toEqual(before)
    expect(spy.log.statements.filter((s) => /update\s+"?auth_oauth_clients"?/i.test(s))).toEqual([])
  })

  it('a registration stores allowed ∪ defaults as before, and the consent page shows the requested scopes', async () => {
    const o = await owner()
    const client = await register(workerB(), ['contacts:read'])
    expect(new Set(await storedScopes(client))).toEqual(new Set([...ALLOWED_B, ...DEFAULTS_B]))
    const res = await authorize(workerB(), client, 'openid contacts:read', o.cookie)
    expect(res.url?.pathname, res.text).toBe('/app/consent')
    expect(set(res.url!.searchParams.get('scope'))).toEqual(['contacts:read', 'openid'])
  })
})
