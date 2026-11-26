import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import type { D1Like } from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVibaseRegistry } from '@vibase/api'
import { CLI_CLIENT_ID, seedFirstPartyClient } from '@vibase/auth'
import { mintClerkToken, mintOAuthToken } from '@vibase/api/test/clerk'
import { d1Binding } from '@vibase/storage-d1'
import { execute } from '@vibase/storage'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { initDeploymentOperation } from './init-deployment.js'
import type { D1WorkerEnv } from './compose.js'
import {
  NOW,
  bootstrapD1,
  clerkKit,
  clerkUser,
  composeD1Worker,
  faultD1,
  openWorkerD1,
  openWorkerPair,
  type ClerkKit,
  type WorkerD1,
  type WorkerPair,
} from './test/kit.js'

// [[CORE666]] cycle 1 (D1, D2, D3, D4, D7, D8): a delegated agent's record is its latest sign-in's scopes, on both providers. One body, two drivers: the built-in provider (the REAL Better Auth mints the tokens) and Clerk
// (locally minted tokens, a fake Backend API). Every case runs through the composed Worker over HTTP.
const declared = createVibaseRegistry().declaredScopes()
const grantable = declared.filter(
  (s) =>
    !/^(agents|members|invitations|oauth_clients):/.test(s) &&
    s !== 'connections:write' &&
    !/^(blocked_senders|forms):write$/.test(s),
)
type Wk = ReturnType<typeof composeD1Worker>
type Res = { status: number; json: any }
interface Person {
  /** The subject's CRM `users.id` once the person exists (built-in: seeded at once; Clerk: after the first request). */
  userId(): Promise<string>
  token(client: string, scopes: readonly string[]): Promise<string>
  session(): Promise<string>
}
interface Driver {
  readonly name: 'better-auth' | 'clerk'
  readonly d1: D1Like
  worker(db?: D1Like): Wk
  newClient(name: string): Promise<string>
  person(role: 'owner' | 'member', tag: string): Promise<Person>
  /** An agent account holding `scopes`, and a token of its own listing `list` for `client`. */
  agentAccount(
    scopes: string[],
  ): Promise<{ id: string; token(client: string, list: readonly string[]): Promise<string> }>
  /** The key of the bootstrap (API-key) agent. */
  readonly apiKey: string
  /** The first-party CLI client id of the deployment. */
  readonly cliClient: string
}

const send = async (wk: Wk, method: string, path: string, tok: string, body?: unknown): Promise<Res> => {
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

// ---- the built-in provider ----------------------------------------------------------------------------------------
async function builtInDriver(): Promise<{ driver: Driver; reset(): Promise<void>; dispose(): Promise<void> }> {
  const w: WorkerPair = await openWorkerPair()
  let kit: AuthKit
  let orgId = ''
  let bootUser = ''
  const state = { apiKey: '' }
  let n = 0
  const driver: Driver = {
    name: 'better-auth',
    cliClient: CLI_CLIENT_ID,
    d1: w.d1,
    get apiKey() {
      return state.apiKey
    },
    worker: (db) =>
      composeD1Worker({
        DB: db ?? w.d1,
        CONTROL_DB: w.control,
        AUTH_PROVIDER: 'better-auth',
        AUTH_SECRET,
        PUBLIC_BASE_URL: AUTH_BASE,
      } as D1WorkerEnv),
    newClient: (name) => kit.registerClient(name),
    async person(role, tag) {
      const email = `${tag}-${++n}@x.test`
      const { userId, cookie } = await kit.signUp(email)
      const id = uuidv7(NOW)
      await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
      await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
      return {
        userId: async () => id,
        token: async (client, scopes) =>
          (await kit.deviceTokens(cookie, client, ['openid', 'offline_access', ...scopes].join(' '))).access_token,
        session: () => kit.sessionJwt(cookie),
      }
    },
    async agentAccount(scopes) {
      const email = `acct-${++n}@x.test`
      const { userId, cookie } = await kit.signUp(email)
      const id = uuidv7(NOW)
      await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes })
      await w.d1
        .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
        .bind('better-auth', userId, id)
        .run()
      return {
        id,
        token: async (client, list) =>
          (await kit.deviceTokens(cookie, client, ['openid', 'offline_access', ...list].join(' '))).access_token,
      }
    },
  }
  return {
    driver,
    reset: async () => {
      await w.reset()
      await w.d1.prepare('drop table if exists d1_migrations').run()
      await createMigrationTracker(w.d1)
      await recordMigrations(
        w.d1,
        MIGRATIONS.map((m) => m.name),
      )
      const r = await bootstrapD1(
        w.d1,
        {
          organizationName: 'Acme',
          email: 'boot@x.test',
          agentName: 'bot',
          authProvider: 'none',
          authOrgId: 'org_acme',
        },
        { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
      )
      orgId = r.organizationId
      bootUser = r.userId!
      state.apiKey = r.key
      await seedFirstPartyClient(w.control, { baseURL: AUTH_BASE })
      kit = authKit(w.control, { scopes: declared })
    },
    dispose: () => w.dispose(),
  }
}

// ---- Clerk ---------------------------------------------------------------------------------------------------------
async function clerkDriver(): Promise<{ driver: Driver; reset(): Promise<void>; dispose(): Promise<void> }> {
  const w: WorkerD1 = await openWorkerD1()
  const kit: ClerkKit = await clerkKit()
  const state = { clock: new Date(), apiKey: '' }
  let n = 0
  const worker = (db: D1Like = w.d1) =>
    composeD1Worker(
      { DB: db, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: 'client_cli' },
      { fetch: kit.fetch, clock: () => state.clock },
    )
  const profile = (sub: string, role: unknown) =>
    kit.profiles.set(sub, clerkUser({ id: sub, email: `${sub}@x.test`, verified: true, role }))
  const driver: Driver = {
    name: 'clerk',
    cliClient: 'client_cli',
    d1: w.d1,
    get apiKey() {
      return state.apiKey
    },
    worker,
    newClient: async (name) => {
      const id = `client_${++n}`
      kit.clients.set(id, name)
      return id
    },
    async person(role, tag) {
      const sub = `user_${tag}${++n}`
      profile(sub, role)
      return {
        userId: async () =>
          ((await w.d1.prepare('select id from users where auth_subject = ?').bind(sub).first()) as { id: string }).id,
        token: (client, scopes) =>
          mintOAuthToken(kit.issuer, { sub, clientId: client, scope: [...scopes], now: state.clock }),
        session: () => mintClerkToken(kit.issuer, { sub, extra: { vibase_role: role }, now: state.clock }),
      }
    },
    async agentAccount(scopes) {
      const sub = `user_acct${++n}`
      profile(sub, 'agent')
      const wk = worker()
      // First sight of an agent account creates its row (no scopes); the grant is then set the way an owner would.
      await send(
        wk,
        'GET',
        '/meta/v1/me',
        await mintOAuthToken(kit.issuer, { sub, clientId: 'client_cli', scope: ['contacts:read'], now: state.clock }),
      )
      const row = (await w.d1.prepare('select id from agents where auth_subject = ?').bind(sub).first()) as {
        id: string
      }
      await w.d1.prepare('update agents set scopes = ? where id = ?').bind(JSON.stringify(scopes), row.id).run()
      await w.d1.prepare('delete from events').run()
      return {
        id: row.id,
        token: (client, list) =>
          mintOAuthToken(kit.issuer, { sub, clientId: client, scope: [...list], now: state.clock }),
      }
    },
  }
  return {
    driver,
    reset: async () => {
      await w.reset()
      kit.fetch.reset()
      kit.profiles.clear()
      kit.clients.clear()
      state.clock = new Date()
      const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
      await execute(
        d1Binding(w.d1, link),
        { kind: 'internal', organizationId: link.organizationId },
        initDeploymentOperation(link),
      )
      const at = NOW.toISOString()
      await w.d1
        .prepare(
          'insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)',
        )
        .bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId)
        .run()
    },
    dispose: () => w.dispose(),
  }
}

describe.each([
  ['the built-in provider', builtInDriver],
  ['Clerk', clerkDriver],
] as const)("a connector's record follows its sign-in on %s", (_label, open) => {
  let driver: Driver
  let reset: () => Promise<void>
  let dispose: () => Promise<void>
  beforeAll(async () => {
    const o = await open()
    driver = o.driver
    reset = o.reset
    dispose = o.dispose
  })
  afterAll(() => dispose())
  beforeEach(() => reset())

  const rows = async (text: string, ...binds: unknown[]) =>
    ((
      await driver.d1
        .prepare(text)
        .bind(...binds)
        .all()
    ).results ?? []) as Array<Record<string, any>>
  const agentOf = async (client: string) => (await rows('select * from agents where auth_client_id = ?', client))[0]
  const listOf = (v: unknown) =>
    v === null || v === undefined ? null : (JSON.parse(v as string) as string[]).slice().sort()
  const events = async (agentId: string, type?: string) =>
    (
      await rows(
        `select type, actor_id, before, after from events where resource_id = ?${type ? ' and type = ?' : ''} order by seq`,
        ...[agentId, ...(type ? [type] : [])],
      )
    ).map((e): { type: string; actor_id: string; before: any; after: any } => ({
      type: e.type,
      actor_id: e.actor_id,
      before: e.before ? JSON.parse(e.before) : null,
      after: e.after ? JSON.parse(e.after) : null,
    }))
  /** The agent's stored record and the list last written. */
  const stored = async (client: string) => {
    const a = (await agentOf(client))!
    return { id: a.id as string, scopes: listOf(a.scopes)!, consented: listOf(a.consented_scopes) }
  }
  const me = (wk: Wk, tok: string) => send(wk, 'GET', '/meta/v1/me', tok)
  const held = (r: Res) => (r.json.active_organization.scopes as string[]).slice().sort()

  describe("D1, D2, D3: the record is the latest sign-in's list", () => {
    it('first sight with a narrowed list: record and consent are that list (closed), never every grantable scope', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      const r = await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      const s = await stored(client)
      expect(s.scopes).toEqual(['contacts:read', 'tags:read'])
      expect(s.consented).toEqual(['contacts:read', 'tags:read'])
      expect(s.scopes.length).toBeLessThan(grantable.length)
      expect(held(r)).toEqual(['contacts:read', 'tags:read'])
      expect((await events(s.id)).map((e) => e.type)).toEqual(['agent.created'])
    })

    it('a legacy agent (consented NULL, every grantable scope on its record) is corrected on its next request, with one agent.updated', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read']))
      const id = (await stored(client)).id
      await driver.d1
        .prepare('update agents set scopes = ?, consented_scopes = null where id = ?')
        .bind(JSON.stringify(grantable), id)
        .run()
      const before = (await events(id)).length
      expect(grantable.length).toBeGreaterThan(30)
      const r = await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      expect(r.status).toBe(200)
      const s = await stored(client)
      expect(s.scopes).toEqual(['contacts:read', 'tags:read'])
      expect(s.consented).toEqual(['contacts:read', 'tags:read'])
      const updated = (await events(id, 'agent.updated')).slice(0)
      expect(updated).toHaveLength(1)
      expect((await events(id)).length).toBe(before + 1)
      expect(updated[0]!.before.scopes.slice().sort()).toEqual(grantable.slice().sort())
      expect(updated[0]!.after.scopes).toEqual(['contacts:read', 'tags:read'])
    })

    it('a token with the same list after the owner removed a scope keeps the record narrowed and writes nothing', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      const id = (await stored(client)).id
      const removed = await send(wk, 'PATCH', `/meta/v1/agents/${id}`, await p.session(), {
        remove_scopes: ['tags:read'],
      })
      expect(removed.status, JSON.stringify(removed.json)).toBe(200)
      const eventsBefore = await events(id)
      const again = await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      expect(again.status).toBe(200)
      expect(held(again)).toEqual(['contacts:read'])
      const s = await stored(client)
      expect(s.scopes).toEqual(['contacts:read'])
      expect(s.consented).toEqual(['contacts:read', 'tags:read'])
      expect(await events(id)).toEqual(eventsBefore)
    })

    it('a narrower list narrows the record; a wider list widens it, each with one agent.updated', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read', 'tags:read', 'notes:read']))
      const id = (await stored(client)).id
      await me(wk, await p.token(client, ['contacts:read']))
      expect(await stored(client)).toEqual({ id, scopes: ['contacts:read'], consented: ['contacts:read'] })
      expect(await events(id, 'agent.updated')).toHaveLength(1)
      const wide = await me(wk, await p.token(client, ['contacts:read', 'deals:read']))
      expect(wide.status).toBe(200)
      expect(await stored(client)).toEqual({
        id,
        scopes: ['contacts:read', 'deals:read'],
        consented: ['contacts:read', 'deals:read'],
      })
      expect(held(wide)).toEqual(['contacts:read', 'deals:read'])
      expect(await events(id, 'agent.updated')).toHaveLength(2)
    })

    it('a scope that implies another puts the implied one in the list', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:write', 'messages:read']))
      const s = await stored(client)
      expect(s.consented).toEqual([
        'contacts:request_approval',
        'contacts:write',
        'messages:read',
        'messages:read_metadata',
      ])
      expect(s.scopes).toEqual(s.consented)
    })

    it('a scope that is not agent-grantable is dropped from both', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      let tok: string
      try {
        tok = await p.token(client, ['contacts:read', 'agents:write', 'members:read'])
      } catch {
        // The built-in provider refuses a client a scope its registration does not list: the case is the Clerk path's (a Clerk token lists whatever the client asked for).
        expect(driver.name).toBe('better-auth')
        return
      }
      const r = await me(wk, tok)
      expect(r.status).toBe(200)
      const s = await stored(client)
      expect(s.scopes).toEqual(['contacts:read'])
      expect(s.consented).toEqual(['contacts:read'])
    })

    it('a member whose role is narrower than the list: consented is the list, the record is the list met with the role, the implied pair stays together', async () => {
      const wk = driver.worker()
      const p = await driver.person('member', 'm')
      const client = await driver.newClient('Claude Desktop')
      const r = await me(wk, await p.token(client, ['contacts:write', 'audit:read', 'webhooks:read']))
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      const s = await stored(client)
      expect(s.consented).toEqual(['audit:read', 'contacts:request_approval', 'contacts:write', 'webhooks:read'])
      expect(s.scopes).toEqual(['contacts:request_approval', 'contacts:write'])
      expect(held(r)).toEqual(['contacts:request_approval', 'contacts:write'])
    })
  })

  describe('D8: one event, attributed, guarded', () => {
    it('each record change emits exactly one agent.updated in the record shape, attributed to the person; a same-list token emits none', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read']))
      const id = (await stored(client)).id
      const person = await p.userId()
      await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      const updated = await events(id, 'agent.updated')
      expect(updated).toHaveLength(1)
      expect(updated[0]!.actor_id).toBe(person)
      const keys = Object.keys((await events(id, 'agent.created'))[0]!.after).sort()
      expect(Object.keys(updated[0]!.before).sort()).toEqual(keys)
      expect(Object.keys(updated[0]!.after).sort()).toEqual(keys)
      expect(updated[0]!.before.scopes).toEqual(['contacts:read'])
      expect(updated[0]!.after.scopes).toEqual(['contacts:read', 'tags:read'])
    })

    it.each([
      ['NULL', null],
      ['a stored list', ['contacts:read']],
    ] as const)(
      'a request whose guard no longer holds (the list read was %s) writes nothing and emits no second event',
      async (_n, startedFrom) => {
        const p = await driver.person('owner', 'a')
        const client = await driver.newClient('Claude Desktop')
        await me(driver.worker(), await p.token(client, ['contacts:read']))
        const id = (await stored(client)).id
        await driver.d1
          .prepare('update agents set consented_scopes = ? where id = ?')
          .bind(startedFrom === null ? null : JSON.stringify(startedFrom), id)
          .run()
        const wide = ['contacts:read', 'tags:read']
        const rival = await p.token(client, wide)
        const fault = faultD1(driver.d1, {
          match: /update "agents" set[^]*"consented_scopes"/,
          // The rival request (a second request carrying the same list) commits between this request's read and its write.
          act: async () => void (await me(driver.worker(), rival)),
        })
        const r = await me(driver.worker(fault.d1), await p.token(client, wide))
        expect(fault.fired()).toBe(1)
        expect(r.status, JSON.stringify(r.json)).toBe(200)
        expect(held(r)).toEqual(wide)
        expect(await stored(client)).toEqual({ id, scopes: wide, consented: wide })
        expect(await events(id, 'agent.updated')).toHaveLength(1)
      },
    )

    it('two concurrent requests carrying one new list write once and emit one agent.updated', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read']))
      const id = (await stored(client)).id
      const wide = ['contacts:read', 'tags:read']
      const [one, two] = await Promise.all([
        p.token(client, wide).then((t) => me(wk, t)),
        p.token(client, wide).then((t) => me(wk, t)),
      ])
      expect([one.status, two.status]).toEqual([200, 200])
      expect(await stored(client)).toEqual({ id, scopes: wide, consented: wide })
      expect(await events(id, 'agent.updated')).toHaveLength(1)
    })
  })

  describe('what is held, and who is touched', () => {
    it('after a rewrite the request holds token ∩ record ∩ role ∩ grantable', async () => {
      const wk = driver.worker()
      const p = await driver.person('member', 'm')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read', 'tags:read', 'notes:read']))
      const id = (await stored(client)).id
      await send(wk, 'PATCH', `/meta/v1/agents/${id}`, await (await driver.person('owner', 'o')).session(), {
        remove_scopes: ['notes:read'],
      })
      // A wider list rewrites the record to list ∩ role; what is held is that list (the person is a member, who holds all three).
      const r = await me(wk, await p.token(client, ['contacts:read', 'tags:read', 'notes:read', 'audit:read']))
      expect(held(r)).toEqual(['contacts:read', 'notes:read', 'tags:read'])
    })

    it("an agent account's record is never rewritten from a token, and an API-key agent is untouched", async () => {
      const wk = driver.worker()
      const account = await driver.agentAccount(['contacts:read'])
      const client = await driver.newClient('Claude Desktop')
      const eventsBefore = await rows('select count(*) n from events')
      const r = await me(wk, await account.token(client, ['contacts:read', 'tags:read']))
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      expect(held(r)).toEqual(['contacts:read'])
      const row = (await rows('select scopes, consented_scopes from agents where id = ?', account.id))[0]!
      expect(listOf(row.scopes)).toEqual(['contacts:read'])
      expect(row.consented_scopes).toBeNull()
      expect(await rows('select count(*) n from events')).toEqual(eventsBefore)
      if (driver.apiKey) {
        const key = await send(wk, 'GET', '/meta/v1/me', driver.apiKey)
        expect(key.status).toBe(200)
        const keyRow = (
          await rows('select consented_scopes from agents where auth_subject is null and auth_client_id is null')
        )[0]!
        expect(keyRow.consented_scopes).toBeNull()
      }
    })

    it('a CLI person acts as themselves: no delegated agent is made or changed', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const r = await me(wk, await p.token(driver.cliClient, ['contacts:read']))
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      expect(r.json.principal.kind).toBe('user')
      expect(await rows('select count(*) n from agents where auth_client_id is not null')).toEqual([{ n: 0 }])
    })
  })

  describe('D4: the column is machinery', () => {
    it('is in no agent record, list row, event payload or schema.get answer', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      await me(wk, await p.token(client, ['contacts:read']))
      await me(wk, await p.token(client, ['contacts:read', 'tags:read']))
      const s = await stored(client)
      expect(s.consented).not.toBeNull()
      const session = await p.session()
      const got = await send(wk, 'GET', `/meta/v1/agents/${s.id}`, session)
      expect(got.status).toBe(200)
      expect(Object.keys(got.json)).not.toContain('consented_scopes')
      const list = await send(wk, 'GET', '/meta/v1/agents', session)
      for (const row of list.json.data) expect(Object.keys(row)).not.toContain('consented_scopes')
      for (const e of await events(s.id)) {
        expect(Object.keys(e.after ?? {})).not.toContain('consented_scopes')
        expect(Object.keys(e.before ?? {})).not.toContain('consented_scopes')
      }
      const schema = await send(wk, 'GET', '/meta/v1/schema', session)
      expect(schema.status).toBe(200)
      expect(JSON.stringify(schema.json)).not.toContain('consented_scopes')
    })
  })

  describe('D7: the delegated hint is gone', () => {
    it('a delegated agent refused an operation gets the plain 403 on REST, and MCP lists no hinted tool', async () => {
      const wk = driver.worker()
      const p = await driver.person('owner', 'a')
      const client = await driver.newClient('Claude Desktop')
      const tok = await p.token(client, ['tags:read'])
      const refused = await send(wk, 'POST', '/api/v1/contacts', tok, { name: 'Ada' })
      expect(refused.status).toBe(403)
      expect(refused.json.error.code).toBe('insufficient_scope')
      expect(refused.json.error.message).toBe('requires contacts:write')
      const rpc = await wk.fetch(
        new Request(`${AUTH_BASE}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      )
      const tools = ((await rpc.json()) as any).result.tools as Array<{ name: string; description: string }>
      expect(tools.find((t) => t.name === 'tags_list')).toBeTruthy()
      expect(tools.find((t) => t.name === 'contacts_create')).toBeUndefined()
      for (const t of tools) expect(t.description).not.toMatch(/approved before/)
    })
  })
})
