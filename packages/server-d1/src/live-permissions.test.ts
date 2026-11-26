import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, createOAuthClient, openControlDb } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '@vibase/api/test/custom-objects'
import { createVibaseRegistry, scopesForRole } from '@vibase/api'
import { resourcesFor } from '@vibase/auth'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE630]] cycle 1 (D2 to D4, D10) through the Node composition: the REAL Better Auth mints the tokens (device grant for the CLI and the other clients, authorization code for a first-party app), and the composed
// Worker (`composeD1Worker`, `better-auth`) resolves them against the vault's own rows. A token carries the marker `limited_login` only when the login asked for it.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let cliClient: string
let otherClient: string
const declared = createVibaseRegistry().declaredScopes()
const LIMITED = 'limited_login'
const CUSTOM = `${PROJECTS_KEY}:write`
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
  kit = authKit(w.control, { scopes: declared })
  cliClient = await kit.registerClient('Vibase CLI', [LIMITED])
  otherClient = await kit.registerClient('Claude Desktop', [LIMITED])
})

const env = (): D1WorkerEnv => ({
  DB: w.d1,
  CONTROL_DB: w.control,
  AUTH_PROVIDER: 'better-auth',
  AUTH_SECRET,
  PUBLIC_BASE_URL: AUTH_BASE,
  AUTH_CLI_CLIENT_ID: cliClient,
})
/** The Worker as deployed before an object was declared, or after (the custom definitions are one dependency of the composition). */
const worker = (withProjects = false) =>
  composeD1Worker(env(), withProjects ? { definitions: [projectsDefinition()] } : {})
type Wk = ReturnType<typeof worker>
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
const scopesOf = async (wk: Wk, tok: string) => {
  const res = await call(wk, 'GET', '/meta/v1/me', tok)
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return res.json.active_organization.scopes as string[]
}
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

const OWNER_SCOPES = () => scopesForRole('owner', declared).toStrings()
const MEMBER_SCOPES = () => scopesForRole('member', declared).toStrings()
const READ_CONTACTS = ['contacts:read']
const WRITE_CONTACTS = ['contacts:read', 'contacts:request_approval', 'contacts:write']

/** A Better Auth account and the vault rows for it: a person with a role, or an agent account (record `contacts:read`, `contacts:write`). */
async function subject(kind: 'owner' | 'member' | 'agent account', email = `${kind.replace(/ /g, '-')}@x.test`) {
  const { userId, cookie } = await kit.signUp(email)
  let humanId: string | null = null
  let agentId: string | null = null
  if (kind === 'agent account') {
    agentId = uuidv7(NOW)
    await seedAgent(w.d1, {
      id: agentId,
      organizationId: orgId,
      createdBy: bootUser,
      scopes: ['contacts:read', 'contacts:write'],
    })
    await w.d1
      .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
      .bind('better-auth', userId, agentId)
      .run()
  } else {
    humanId = uuidv7(NOW)
    await seedPrincipal(w.d1, { id: humanId, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
    await seedMembership(w.d1, { organizationId: orgId, userId: humanId, role: kind })
  }
  return {
    cookie,
    humanId,
    agentId,
    /** A device-grant token: `scope` as the client asked, plus the marker when `limited`. */
    login: async (client: string, scope: string, limited: boolean) =>
      kit.deviceTokens(cookie, client, limited ? `${scope} ${LIMITED}` : scope),
  }
}

describe('group 1: the matrix, principal kind x marker (D2 to D4)', () => {
  // The token always asks for `openid contacts:read`; what differs is whether the login was marked.
  type Row = { cred: 'cli' | 'other'; who: 'owner' | 'member' | 'agent account'; unmarked: string[]; marked: string[] }
  const rows: Row[] = [
    { cred: 'cli', who: 'owner', unmarked: [], marked: READ_CONTACTS },
    { cred: 'cli', who: 'member', unmarked: [], marked: READ_CONTACTS },
    { cred: 'cli', who: 'agent account', unmarked: WRITE_CONTACTS, marked: READ_CONTACTS },
    { cred: 'other', who: 'agent account', unmarked: WRITE_CONTACTS, marked: READ_CONTACTS },
  ]
  for (const row of rows)
    for (const limited of [false, true])
      it(`${row.cred} client, ${row.who}, ${limited ? 'with' : 'without'} limited_login`, async () => {
        const s = await subject(row.who)
        const tok = (await s.login(row.cred === 'cli' ? cliClient : otherClient, 'openid contacts:read', limited))
          .access_token
        if (limited) expect(decode(tok).scope.split(' ')).toContain(LIMITED)
        else expect(decode(tok).scope.split(' ')).not.toContain(LIMITED)
        const expected = limited
          ? row.marked
          : row.unmarked.length > 0
            ? row.unmarked
            : row.who === 'owner'
              ? OWNER_SCOPES()
              : MEMBER_SCOPES()
        expect(await scopesOf(worker(), tok)).toEqual(expected)
      })

  for (const limited of [false, true])
    it(`delegated agent (a person on another client), ${limited ? 'with' : 'without'} limited_login: token ∩ record ∩ role ∩ grantable, the marker ignored`, async () => {
      const s = await subject('member')
      const tok = (await s.login(otherClient, 'openid contacts:read', limited)).access_token
      expect(await scopesOf(worker(), tok)).toEqual(READ_CONTACTS)
    })

  it("the marker is never a vault scope: not in a marked person's or agent's me.get scopes, and on no agent record", async () => {
    const m = await subject('member')
    const delegated = (await m.login(otherClient, 'openid contacts:read', true)).access_token
    const acct = await subject('agent account', 'acct-marker@x.test')
    const account = (await acct.login(cliClient, 'openid contacts:read', true)).access_token
    const person = (
      await (await subject('owner', 'owner-marker@x.test')).login(cliClient, 'openid contacts:read', true)
    ).access_token
    for (const tok of [delegated, account, person]) expect(await scopesOf(worker(), tok)).not.toContain(LIMITED)
    const stored = (await w.d1.prepare('select scopes from agents').all()).results as Array<{ scopes: string }>
    expect(stored.length).toBeGreaterThan(1)
    for (const row of stored) expect(JSON.parse(row.scopes)).not.toContain(LIMITED)
  })

  for (const limited of [false, true])
    it(`first-party app, ${limited ? 'with' : 'without'} limited_login: role ∩ the app's live bound, the marker ignored`, async () => {
      const o = await subject('owner')
      const app = (await createOAuthClient(openControlDb(w.control), {
        organizationId: orgId,
        clientId: `app_${uuidv7(NOW).slice(-20)}`,
        name: 'Deals board',
        redirectUris: ['https://app.test/cb'],
        scopes: ['contacts:read', 'deals:write'],
        skipConsent: true,
        resources: resourcesFor(AUTH_BASE),
        actorId: bootUser,
        now: new Date().toISOString(),
        newId: () => uuidv7(NOW),
      })) as { clientId: string }
      const verifier = 'v'.repeat(60)
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: app.clientId,
        redirect_uri: 'https://app.test/cb',
        scope: limited ? `openid contacts:read ${LIMITED}` : 'openid contacts:read',
        state: 's1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: AUTH_BASE,
      })
      const a = await kit.call(`/auth/oauth2/authorize?${q}`, { cookie: o.cookie })
      const text = await a.text()
      const location = a.headers.get('location') ?? (JSON.parse(text) as { url?: string }).url
      const code = new URL(location!, AUTH_BASE).searchParams.get('code')
      expect(code, `authorize answered ${a.status} ${text}`).toBeTruthy()
      const t = await kit.call('/auth/oauth2/token', {
        form: true,
        body: {
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: verifier,
          redirect_uri: 'https://app.test/cb',
          client_id: app.clientId,
          resource: AUTH_BASE,
        },
      })
      const tok = ((await t.json()) as { access_token: string }).access_token
      expect(await scopesOf(worker(), tok)).toEqual(
        ['contacts:read', 'contacts:request_approval', 'deals:read', 'deals:request_approval', 'deals:write'].sort(),
      )
    })
})

describe('group 2: a permission added later applies to the same token (D3, D4, D10)', () => {
  /** The owner's login on the CLI client, its token issued BEFORE `projects__c` is declared. */
  async function ownerLogin(limited: boolean) {
    const s = await subject('owner')
    await createCustomTables(w.d1)
    const tokens = await s.login(cliClient, 'openid offline_access contacts:read', limited)
    return { s, tokens }
  }
  const refresh = async (refreshToken: string) => {
    const res = await kit.call('/auth/oauth2/token', {
      form: true,
      body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cliClient, resource: AUTH_BASE },
    })
    const body = (await res.json()) as { access_token: string }
    expect(res.status, JSON.stringify(body)).toBe(200)
    return body.access_token
  }

  it('an unmarked owner login issued before the object existed reads and writes it, sees it in me.get, and grants it to an agent; a refresh keeps that', async () => {
    const { tokens } = await ownerLogin(false)
    expect(decode(tokens.access_token).scope).not.toContain(CUSTOM)
    const later = worker(true)
    for (const tok of [tokens.access_token, await refresh(tokens.refresh_token!)]) {
      expect(await scopesOf(later, tok)).toContain(CUSTOM)
      const made = await call(later, 'POST', `/api/v1/${PROJECTS_KEY}`, tok, { name: 'Site rebuild' })
      expect(made.status, JSON.stringify(made.json)).toBe(201)
      expect((await call(later, 'GET', `/api/v1/${PROJECTS_KEY}/${made.json.id}`, tok)).json.name).toBe('Site rebuild')
      const agent = await call(later, 'POST', '/meta/v1/agents', tok, { name: 'bot2' })
      expect(agent.status, JSON.stringify(agent.json)).toBe(201)
      const granted = await call(later, 'PATCH', `/meta/v1/agents/${agent.json.id}`, tok, { add_scopes: [CUSTOM] })
      expect(granted.status, JSON.stringify(granted.json)).toBe(200)
    }
  })

  it('a marked owner login stays limited, including for the object declared later, and after a refresh', async () => {
    const { tokens } = await ownerLogin(true)
    const later = worker(true)
    for (const tok of [tokens.access_token, await refresh(tokens.refresh_token!)]) {
      expect(await scopesOf(later, tok)).toEqual(READ_CONTACTS)
      expect((await call(later, 'POST', `/api/v1/${PROJECTS_KEY}`, tok, { name: 'x' })).status).toBe(403)
    }
  })

  it("an owner's grant to an agent account and a removal apply on its next request, same token and agent id", async () => {
    const owner = await subject('owner')
    const ownerTok = (await owner.login(cliClient, 'openid contacts:read', false)).access_token
    const acct = await subject('agent account', 'acct@x.test')
    const tok = (await acct.login(otherClient, 'openid contacts:read', false)).access_token
    const wk = worker()
    const patch = async (body: unknown) => {
      const r = await call(wk, 'PATCH', `/meta/v1/agents/${acct.agentId}`, ownerTok, body)
      expect(r.status, JSON.stringify(r.json)).toBe(200)
    }
    const me = () => call(wk, 'GET', '/meta/v1/me', tok)
    expect((await me()).json.active_organization.scopes).toEqual(WRITE_CONTACTS)
    await patch({ add_scopes: ['tasks:read'] })
    const granted = await me()
    expect(granted.json.principal.id).toBe(acct.agentId)
    expect(granted.json.active_organization.scopes).toEqual([...WRITE_CONTACTS, 'tasks:read'])
    await patch({ remove_scopes: ['contacts:write', 'tasks:read'] })
    expect((await me()).json.active_organization.scopes).toEqual(READ_CONTACTS)
  })

  it('a role change (owner to member) narrows an unmarked CLI login on the next request, and a marked one stays at its list', async () => {
    const s = await subject('owner')
    const unmarked = (await s.login(cliClient, 'openid contacts:read', false)).access_token
    const wk = worker()
    expect(await scopesOf(wk, unmarked)).toEqual(OWNER_SCOPES())
    await w.d1.prepare("update memberships set role = 'member' where user_id = ?").bind(s.humanId).run()
    expect(await scopesOf(wk, unmarked)).toEqual(MEMBER_SCOPES())
  })
})
