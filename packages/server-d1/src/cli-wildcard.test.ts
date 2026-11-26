import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, openControlDb } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '@vibase/api/test/custom-objects'
import * as api from '@vibase/api'
import { createVibaseRegistry, grantableScopes, scopesForRole } from '@vibase/api'
import { CLI_CLIENT_ID, FULL_ACCESS_SCOPE, registrationScopes, resourcesFor, seedFirstPartyClient } from '@vibase/auth'
import { AUTH_SCOPES } from '@vibase/auth/static-metadata'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, DEVICE_GRANT, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE660]] ([[CORE630]] D1 to D6, D11's wildcard case) through the Node composition: the REAL Better Auth device and authorization flows mint every token the assertions use (a second handler on the same control database, with no
// narrowing hook, stands in for "a token that somehow carries the wildcard"), and the composed Worker resolves them against the vault's own rows.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
const declared = createVibaseRegistry().declaredScopes()
const declaredLater = createVibaseRegistry({ definitions: [projectsDefinition()] }).declaredScopes()
const READ = `${PROJECTS_KEY}:read`
const WRITE = `${PROJECTS_KEY}:write`
const REDIRECT = 'https://app.test/cb'
const verifier = 'v'.repeat(60)
const WILDCARD_LOGIN = `openid offline_access ${FULL_ACCESS_SCOPE}`
const grantableBefore = grantableScopes(declared)
const LIST_BEFORE = ['openid', 'offline_access', ...grantableBefore].join(' ')

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

const env = (): D1WorkerEnv => ({
  DB: w.d1,
  CONTROL_DB: w.control,
  AUTH_PROVIDER: 'better-auth',
  AUTH_SECRET,
  PUBLIC_BASE_URL: AUTH_BASE,
})
/** The Worker as deployed before an object was declared, or after (the custom definitions are one dependency of the composition). */
const worker = (withProjects = false) =>
  composeD1Worker(env(), withProjects ? { definitions: [projectsDefinition()] } : {})
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

/** A whole device login on the Worker's own `/auth` (the approval-time narrowing lives there): what the page read after the claim, and the tokens. */
async function login(wk: Wk, cookie: string, scope: string, clientId = CLI_CLIENT_ID) {
  const call = authCall(wk)
  const created = await call('/auth/device/code', { body: { client_id: clientId, scope, resource: AUTH_BASE } })
  const codes = (await created.json()) as { device_code: string; user_code: string }
  const claimed = (await (
    await call(`/auth/device?user_code=${encodeURIComponent(codes.user_code)}`, { cookie })
  ).json()) as { scope: string }
  expect((await call('/auth/device/approve', { cookie, body: { userCode: codes.user_code } })).status).toBe(200)
  const tok = await call('/auth/oauth2/token', {
    form: true,
    body: { grant_type: DEVICE_GRANT, device_code: codes.device_code, client_id: clientId, resource: AUTH_BASE },
  })
  const body = (await tok.json()) as { access_token: string; refresh_token?: string }
  expect(tok.status, JSON.stringify(body)).toBe(200)
  return {
    page: claimed.scope.split(' '),
    token: body.access_token,
    refresh: body.refresh_token,
    claims: claimsOf(body.access_token),
  }
}
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
const claimScopes = (t: string) => (claimsOf(t).scope as string).split(' ')
const vault = (scopes: string[]) => scopes.filter((s) => s.includes(':')).sort()

const call = async (wk: Wk, method: string, path: string, tok: string, body?: unknown) => {
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
const meScopes = async (wk: Wk, tok: string) => {
  const res = await call(wk, 'GET', '/meta/v1/me', tok)
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return (res.json.active_organization.scopes as string[]).slice().sort()
}
const roleScopes = (role: 'owner' | 'member', list = declared) => scopesForRole(role, list).toStrings().sort()

async function person(role: 'owner' | 'member', email: string) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return { id, userId, cookie }
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

describe('1. the report, end to end: an object declared after both signed in (D2 to D4, D6, D11)', () => {
  it('the owner holds it at once on the same token and grants it; the agent needs to sign in again, with the same agent id', async () => {
    const wk = worker()
    const owner = await person('owner', 'owner@x.test')
    const agent = await agentAccount(['contacts:read'])
    const ownerLogin = await login(wk, owner.cookie, WILDCARD_LOGIN)
    const agentLogin = await login(wk, agent.cookie, WILDCARD_LOGIN)
    // the person's token says what the person approved; the agent's says its record, never the wildcard
    expect(claimScopes(ownerLogin.token)).toContain(FULL_ACCESS_SCOPE)
    expect(vault(claimScopes(agentLogin.token))).toEqual(['contacts:read'])
    expect(claimScopes(agentLogin.token)).not.toContain(FULL_ACCESS_SCOPE)
    expect(agentLogin.page).not.toContain(FULL_ACCESS_SCOPE)
    expect(vault(agentLogin.page)).toEqual(['contacts:read'])
    expect(await meScopes(wk, ownerLogin.token)).toEqual(roleScopes('owner'))

    // an object is declared after both logins
    await createCustomTables(w.d1)
    const later = worker(true)
    const ownerNow = await meScopes(later, ownerLogin.token)
    expect(ownerNow).toEqual(expect.arrayContaining([READ, WRITE]))
    expect(ownerNow).toEqual(roleScopes('owner', declaredLater))
    const made = await call(later, 'POST', `/api/v1/${PROJECTS_KEY}`, ownerLogin.token, { name: 'Site rebuild' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)

    // the owner grants the object's read and write to the agent
    const grant = await call(later, 'PATCH', `/meta/v1/agents/${agent.id}`, ownerLogin.token, {
      add_scopes: [READ, WRITE],
    })
    expect(grant.status, JSON.stringify(grant.json)).toBe(200)

    // the agent's old token does not reach it
    const old = await call(later, 'GET', `/api/v1/${PROJECTS_KEY}`, agentLogin.token)
    expect(old.status).toBe(403)
    expect(old.json.error.code).toBe('insufficient_scope')

    // it signs in again: the same agent, now holding the object
    const again = await login(later, agent.cookie, WILDCARD_LOGIN)
    expect(vault(claimScopes(again.token))).toEqual(expect.arrayContaining([READ, WRITE, 'contacts:read']))
    expect(claimScopes(again.token)).not.toContain(FULL_ACCESS_SCOPE)
    expect((await call(later, 'GET', '/meta/v1/me', again.token)).json.principal.id).toBe(agent.id)
    expect((await call(later, 'GET', `/api/v1/${PROJECTS_KEY}`, again.token)).status).toBe(200)
    const wrote = await call(later, 'POST', `/api/v1/${PROJECTS_KEY}`, again.token, { name: 'By the agent' })
    expect(wrote.status, JSON.stringify(wrote.json)).toBe(201)
  })
})

describe('2. who holds what (D3 to D5, D1)', () => {
  /** Tokens issued before the object exists, read after it is declared. */
  async function later() {
    await createCustomTables(w.d1)
    return worker(true)
  }

  describe.each(['owner', 'member'] as const)('a CLI person, %s', (role) => {
    it('a wildcard token holds the live role, a later scope included, and a refresh keeps it', async () => {
      const p = await person(role, `${role}-w@x.test`)
      const t = await login(worker(), p.cookie, WILDCARD_LOGIN)
      const wk = await later()
      expect(await meScopes(wk, t.token)).toEqual(roleScopes(role, declaredLater))
      const refreshed = await authCall(wk)('/auth/oauth2/token', {
        form: true,
        body: { grant_type: 'refresh_token', refresh_token: t.refresh!, client_id: CLI_CLIENT_ID, resource: AUTH_BASE },
      })
      const body = (await refreshed.json()) as { access_token: string }
      expect(refreshed.status, JSON.stringify(body)).toBe(200)
      expect(await meScopes(wk, body.access_token)).toEqual(roleScopes(role, declaredLater))
    })

    it('a --scope list token holds only its list: the later scope is refused', async () => {
      const p = await person(role, `${role}-l@x.test`)
      const t = await login(worker(), p.cookie, 'openid offline_access contacts:read')
      const wk = await later()
      expect(await meScopes(wk, t.token)).toEqual(['contacts:read'])
      const refused = await call(wk, 'POST', `/api/v1/${PROJECTS_KEY}`, t.token, { name: 'x' })
      expect(refused.status).toBe(403)
    })

    it('a full list issued before the object holds role ∩ that list: the later scope is not gained', async () => {
      const p = await person(role, `${role}-f@x.test`)
      const t = await login(worker(), p.cookie, LIST_BEFORE)
      const wk = await later()
      const held = await meScopes(wk, t.token)
      expect(held).not.toContain(READ)
      expect(held).toEqual(roleScopes(role).filter((s) => grantableBefore.includes(s)))
    })
  })

  it('a role change takes away from a wildcard token on the next request', async () => {
    const p = await person('owner', 'demoted@x.test')
    const t = await login(worker(), p.cookie, WILDCARD_LOGIN)
    const wk = worker()
    expect(await meScopes(wk, t.token)).toEqual(roleScopes('owner'))
    await w.d1.prepare("update memberships set role = 'member' where user_id = ?").bind(p.id).run()
    expect(await meScopes(wk, t.token)).toEqual(roleScopes('member'))
  })

  it('a wildcard login never hears a sign-in hint: a refusal for a scope the role lacks reads plainly', async () => {
    const p = await person('member', 'plain@x.test')
    const t = await login(worker(), p.cookie, WILDCARD_LOGIN)
    const refused = await call(worker(), 'POST', '/meta/v1/agents', t.token, { name: 'x' })
    expect(refused.status).toBe(403)
    expect(refused.json.error.message).toBe('requires agents:write')
  })

  it('an agent account whose token somehow carries the wildcard holds record ∩ its token list, never every scope', async () => {
    // the kit's own handler has no narrowing hook, so it issues the token the Worker's flow never would
    const a = await agentAccount(['contacts:read', 'tasks:read'])
    const t = await kit.deviceTokens(
      a.cookie,
      CLI_CLIENT_ID,
      `openid offline_access ${FULL_ACCESS_SCOPE} contacts:read deals:read`,
    )
    expect(claimScopes(t.access_token)).toContain(FULL_ACCESS_SCOPE)
    expect(await meScopes(worker(), t.access_token)).toEqual(['contacts:read'])
  })

  it('a first-party app with no stored scopes that is issued the wildcard holds what it held before', async () => {
    const o = await person('owner', 'fp-owner@x.test')
    const app = (await createOAuthClient(openControlDb(w.control), {
      organizationId: orgId,
      clientId: `app_${uuidv7(NOW).slice(-20)}`,
      name: 'Deals board',
      redirectUris: [REDIRECT],
      scopes: null,
      skipConsent: true,
      resources: resourcesFor(AUTH_BASE),
      actorId: bootUser,
      now: new Date().toISOString(),
      newId: () => uuidv7(NOW),
    })) as { clientId: string }
    const tokenFor = async (scope: string) => {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: app.clientId,
        redirect_uri: REDIRECT,
        scope,
        state: 's1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: AUTH_BASE,
      })
      const a = await kit.call(`/auth/oauth2/authorize?${q}`, { cookie: o.cookie })
      const text = await a.text()
      const loc = a.headers.get('location') ?? (JSON.parse(text) as { url?: string }).url
      const code = new URL(loc!, AUTH_BASE).searchParams.get('code')
      expect(code, `authorize answered ${a.status} ${text}`).toBeTruthy()
      const t = await kit.call('/auth/oauth2/token', {
        form: true,
        body: {
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: app.clientId,
          resource: AUTH_BASE,
        },
      })
      return ((await t.json()) as { access_token: string }).access_token
    }
    const withWildcard = await tokenFor(`openid contacts:read ${FULL_ACCESS_SCOPE}`)
    expect(claimScopes(withWildcard)).toContain(FULL_ACCESS_SCOPE)
    const without = await tokenFor('openid contacts:read')
    const before = await meScopes(worker(), without)
    expect(await meScopes(worker(), withWildcard)).toEqual(before)
    expect(before).toEqual(roleScopes('owner').filter((s) => grantableBefore.includes(s)))
  })

  it('a connector whose client somehow holds the wildcard and is issued it stays token ∩ record ∩ role ∩ grantable', async () => {
    const o = await person('owner', 'conn-owner@x.test')
    const client = await kit.registerClient('Claude Desktop')
    const row = (await w.control
      .prepare('select scopes from auth_oauth_clients where client_id = ?')
      .bind(client)
      .first()) as { scopes: string }
    await w.control
      .prepare('update auth_oauth_clients set scopes = ? where client_id = ?')
      .bind(JSON.stringify([...JSON.parse(row.scopes), FULL_ACCESS_SCOPE]), client)
      .run()
    const t = await kit.deviceTokens(o.cookie, client, `openid offline_access contacts:read ${FULL_ACCESS_SCOPE}`)
    expect(claimScopes(t.access_token)).toContain(FULL_ACCESS_SCOPE)
    expect(await meScopes(worker(), t.access_token)).toEqual(['contacts:read'])
  })
})

describe('3. the grant check reads the registry (D6)', () => {
  it('an owner on a list login made before the object existed grants its scope; an undeclared custom scope and a human-only scope are still refused', async () => {
    const owner = await person('owner', 'grant-owner@x.test')
    const t = await login(worker(), owner.cookie, 'openid offline_access agents:write agents:read')
    expect(claimScopes(t.token)).not.toContain(READ)
    await createCustomTables(w.d1)
    const later = worker(true)
    const agent = await call(later, 'POST', '/meta/v1/agents', t.token, { name: 'bot2' })
    expect(agent.status, JSON.stringify(agent.json)).toBe(201)
    const patch = (body: unknown) => call(later, 'PATCH', `/meta/v1/agents/${agent.json.id}`, t.token, body)
    const granted = await patch({ add_scopes: [READ] })
    expect(granted.status, JSON.stringify(granted.json)).toBe(200)
    expect(granted.json.scopes).toContain(READ)
    const unknown = await patch({ add_scopes: ['nothing__c:read'] })
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.code).toBe('unknown_scope')
    const humanOnly = await patch({ add_scopes: ['agents:write'] })
    expect(humanOnly.status).toBe(400)
    expect(humanOnly.json.error.code).toBe('scope_not_grantable')
    // creating an agent with the custom scope, and replacing a whole list, read the registry the same way
    const created = await call(later, 'POST', '/meta/v1/agents', t.token, { name: 'bot3', scopes: [READ] })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const replaced = await patch({ scopes: ['contacts:read', WRITE] })
    expect(replaced.status, JSON.stringify(replaced.json)).toBe(200)
  })
})

describe('4. no connector can ask for or hold the wildcard (D1)', () => {
  const register = (scope: string) =>
    authCall(worker())('/auth/oauth2/register', {
      body: {
        client_name: 'Claude Desktop',
        token_endpoint_auth_method: 'none',
        resources: [AUTH_BASE],
        grant_types: ['authorization_code', DEVICE_GRANT, 'refresh_token'],
        response_types: ['code'],
        scope,
        redirect_uris: [REDIRECT],
      },
    })

  it('a dynamic registration naming the wildcard is refused; one without it cannot be issued it at authorize', async () => {
    const refused = await register(`openid ${FULL_ACCESS_SCOPE} contacts:read`)
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_scope')
    const ok = await register('openid contacts:read')
    expect(ok.status).toBe(201)
    const client = ((await ok.json()) as { client_id: string }).client_id
    const o = await person('owner', 'dcr-owner@x.test')
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: REDIRECT,
      scope: `openid contacts:read ${FULL_ACCESS_SCOPE}`,
      state: 's1',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: AUTH_BASE,
    })
    const a = await authCall(worker())(`/auth/oauth2/authorize?${q}`, { cookie: o.cookie })
    const text = await a.text()
    expect(text + (a.headers.get('location') ?? '')).toContain('invalid_scope')
  })

  it('registration defaults and the grantable ceiling exclude it', () => {
    const { allowed, defaults } = registrationScopes(declared, grantableBefore)
    for (const list of [allowed, defaults, grantableBefore, [...AUTH_SCOPES]])
      expect(list).not.toContain(FULL_ACCESS_SCOPE)
  })

  it('no published scopes_supported names it, and the static authorization-server document still equals the library’s', async () => {
    const wk = worker()
    const get = async (path: string) => (await (await wk.fetch(new Request(AUTH_BASE + path))).json()) as any
    const docs = {
      api: await get('/.well-known/oauth-protected-resource'),
      mcp: await get('/.well-known/oauth-protected-resource/mcp'),
      static: await get('/.well-known/oauth-authorization-server/auth'),
      library: await get('/auth/.well-known/oauth-authorization-server'),
      openid: await get('/auth/.well-known/openid-configuration'),
    }
    for (const [name, doc] of Object.entries(docs)) {
      expect(Array.isArray(doc.scopes_supported), name).toBe(true)
      expect(doc.scopes_supported, name).not.toContain(FULL_ACCESS_SCOPE)
    }
    expect(docs.library.scopes_supported).toEqual(docs.static.scopes_supported)
  })

  it('the wildcard is no Vibase scope: not declared, in no role, on no agent record', () => {
    expect(declared).not.toContain(FULL_ACCESS_SCOPE)
    expect(roleScopes('owner')).not.toContain(FULL_ACCESS_SCOPE)
  })

  it('the Worker’s mirror of the name equals the provider package’s', () => {
    expect(api.FULL_ACCESS_SCOPE).toBe(FULL_ACCESS_SCOPE)
    expect(FULL_ACCESS_SCOPE).toBe('all_permissions')
  })
})

describe('5. an agent account approving a wildcard request (D11, the wildcard case)', () => {
  it('holds its record ∩ agent-grantable and no wildcard, on the page and in the token; a person keeps the wildcard', async () => {
    const wk = worker()
    const a = await agentAccount(['contacts:write', 'deals:read', 'agents:write'])
    const r = await login(wk, a.cookie, WILDCARD_LOGIN)
    // agents:write is human-only: the record may hold it, the agent may not
    expect(vault(r.page)).toEqual(['contacts:request_approval', 'contacts:write', 'deals:read'])
    expect(vault(claimScopes(r.token))).toEqual(['contacts:request_approval', 'contacts:write', 'deals:read'])
    expect(r.page).not.toContain(FULL_ACCESS_SCOPE)
    expect(claimScopes(r.token)).not.toContain(FULL_ACCESS_SCOPE)
    expect(r.page).toContain('offline_access')
    const o = await person('owner', 'o5@x.test')
    const pr = await login(wk, o.cookie, WILDCARD_LOGIN)
    expect(pr.page).toContain(FULL_ACCESS_SCOPE)
    expect(claimScopes(pr.token)).toContain(FULL_ACCESS_SCOPE)
  })

  it('an agent with no grant holds no resource scope, and a wildcard named beside a list expands to the record, never beyond it', async () => {
    const wk = worker()
    const none = await agentAccount([])
    expect(vault((await login(wk, none.cookie, WILDCARD_LOGIN)).page)).toEqual([])
    const some = await agentAccount(['contacts:read', 'tasks:read'])
    const r = await login(wk, some.cookie, `openid offline_access ${FULL_ACCESS_SCOPE} deals:read`)
    expect(vault(r.page)).toEqual(['contacts:read', 'tasks:read'])
  })
})
