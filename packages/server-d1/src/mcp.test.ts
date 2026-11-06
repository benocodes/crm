import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError, ListResourcesResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { execute, uuidv7 } from '@vault/storage'
import { d1Binding } from '@vault/storage-d1'
import { closeScopes, createVaultRegistry, grantableScopes, toolName } from '@vault/api'
import { mintClerkToken, mintOAuthToken } from '@vault/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { initDeploymentOperation } from './init-deployment.js'
import { MIGRATIONS } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { NOW, clerkKit, clerkUser, meterD1, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[API106]] cycle 1: the MCP endpoint through the real D1 composition (local Miniflare, a fake Clerk Backend API, locally minted tokens).

let w: WorkerD1
let kit: ClerkKit
let clock: Date
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  kit.fetch.reset()
  kit.profiles.clear()
  kit.clients.clear()
  clock = new Date()
})

const BASE = 'https://w.test'
const CLI = 'client_cli'
const DCR = 'client_dcr'
const registry = createVaultRegistry()
const grantable = grantableScopes(registry.declaredScopes())

async function initWorkspace() {
  const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
  await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
  const at = NOW.toISOString()
  await w.d1.prepare('insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)').bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId).run()
  return link
}
const worker = (extra: Partial<D1WorkerEnv> = {}, db = w.d1) =>
  composeD1Worker({ DB: db, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI, VERSION: 'test-sha', ...extra }, { fetch: kit.fetch, clock: () => clock })
type Wk = ReturnType<typeof worker>
const session = (sub: string, role?: unknown) => mintClerkToken(kit.issuer, { sub, extra: role === undefined ? {} : { vibase_role: role }, now: clock })
const oauth = (sub: string, clientId: string, scope: string) => mintOAuthToken(kit.issuer, { sub, clientId, scope, now: clock })
const profile = (sub: string, role: unknown) => kit.profiles.set(sub, clerkUser({ id: sub, email: `${sub}@x.test`, verified: true, role }))
const rows = async (sqlText: string, ...binds: unknown[]) => (await w.d1.prepare(sqlText).bind(...binds).all()).results as Array<Record<string, any>>

async function rest(wk: Wk, method: string, path: string, token: string, body?: unknown) {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
/** An agent made by the owner, with an API key: the way a second and third agent exist on a real instance. */
async function agentKey(wk: Wk, name: string, scopes: readonly string[] = grantable): Promise<{ id: string; key: string }> {
  profile('user_owner', 'owner')
  const owner = await session('user_owner', 'owner')
  const agent = await rest(wk, 'POST', '/meta/v1/agents', owner, { name, scopes })
  expect(agent.status).toBe(201)
  const key = await rest(wk, 'POST', '/meta/v1/api-keys', owner, { agent_id: agent.json.id })
  expect(key.status).toBe(201)
  return { id: agent.json.id, key: key.json.key }
}

type Rpc = { status: number; headers: Headers; json: any }
async function post(wk: Wk, token: string | undefined, message: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Rpc> {
  const res = await wk.fetch(
    new Request(BASE + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? JSON.stringify(message),
    }),
  )
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}
const rpc = (method: string, params?: unknown, id: number = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const callTool = (wk: Wk, token: string, name: string, args: unknown = {}) => post(wk, token, rpc('tools/call', { name, arguments: args }))
const listNames = async (wk: Wk, token: string) => ((await post(wk, token, rpc('tools/list'))).json.result.tools as Array<{ name: string }>).map((t) => t.name)

describe('interop with the reference client (D4)', () => {
  it('connect (initialize), listTools and callTool through the SDK Streamable HTTP client', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'sdk')
    const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (input, init) => wk.fetch(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    expect(client.getServerVersion()).toMatchObject({ name: 'vibase', version: 'test-sha' })
    expect(client.getInstructions()).toContain('schema_get')
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['schema_get', 'contacts_create', 'tasks_update']))
    const created = await client.callTool({ name: 'companies_create', arguments: { name: 'Acme Inc' } })
    expect(created.isError).toBeFalsy()
    expect(created.structuredContent).toMatchObject({ name: 'Acme Inc' })
    const listCompanies = await client.callTool({ name: 'companies_list', arguments: { limit: 10 } })
    expect((listCompanies.structuredContent as any).data).toHaveLength(1)
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(McpError)
    await client.close()
  })

  it('a method the server lacks rejects with McpError -32601, never a transport error: the 200 is what the client depends on', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'sdk')
    const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (input, init) => wk.fetch(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    const err = await client.request({ method: 'resources/list' }, ListResourcesResultSchema).catch((e) => e)
    expect(err).toBeInstanceOf(McpError)
    expect(err).not.toBeInstanceOf(StreamableHTTPError)
    expect((err as McpError).code).toBe(-32601)
    await client.close()
  })
})

describe('protocol faults (D1-D3, D10)', () => {
  it('initialize echoes a supported version and answers 2025-11-25 otherwise; carries capabilities, serverInfo and instructions', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const r = await post(wk, key, rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'x', version: '1' } }))
      expect(r.status).toBe(200)
      expect(r.json.result.protocolVersion).toBe(v)
    }
    const r = await post(wk, key, rpc('initialize', { protocolVersion: '1999-01-01' }))
    expect(r.json.result.protocolVersion).toBe('2025-11-25')
    expect(r.json.result.capabilities).toEqual({ tools: { listChanged: false } })
    expect(r.json.result.serverInfo).toEqual({ name: 'vibase', version: 'test-sha' })
    expect(r.json.result.instructions.length).toBeGreaterThan(100)
  })

  it('every method works without a prior initialize: ping, tools/list, tools/call', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    expect((await post(wk, key, rpc('ping'))).json).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect((await post(wk, key, rpc('tools/list'))).json.result.tools.length).toBeGreaterThan(10)
    const call = await callTool(wk, key, 'schema_get')
    expect(call.json.result.isError).toBeUndefined()
  })

  it('envelope faults are HTTP 400 with id null: unparseable JSON -32700; a batch, a non-object, a wrong jsonrpc, a bad id and a missing method -32600', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const faults: Array<[string, Rpc, number]> = [
      ['unparseable', await post(wk, key, null, {}, '{nope'), -32700],
      ['batch', await post(wk, key, [rpc('ping')]), -32600],
      ['non-object', await post(wk, key, 42), -32600],
      ['wrong jsonrpc', await post(wk, key, { jsonrpc: '1.0', id: 1, method: 'ping' }), -32600],
      ['no jsonrpc', await post(wk, key, { id: 1, method: 'ping' }), -32600],
      ['object id', await post(wk, key, { jsonrpc: '2.0', id: {}, method: 'ping' }), -32600],
      ['null id', await post(wk, key, { jsonrpc: '2.0', id: null, method: 'ping' }), -32600],
      ['missing method, valid id', await post(wk, key, { jsonrpc: '2.0', id: 7 }), -32600],
      ['missing method, no id', await post(wk, key, { jsonrpc: '2.0' }), -32600],
    ]
    for (const [name, r, code] of faults) {
      expect({ name, status: r.status }).toEqual({ name, status: 400 })
      expect(r.headers.get('content-type')).toContain('application/json')
      expect({ name, id: r.json.id, code: r.json.error.code }).toEqual({ name, id: null, code })
    }
  })

  it('a message with a valid id but no method answers id null, not the id', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const r = await post(wk, key, { jsonrpc: '2.0', id: 7 })
    expect(r.json.id).toBeNull()
    expect(r.json.error.code).toBe(-32600)
  })

  it('request errors stay HTTP 200 with the request id echoed: -32601 unknown method, -32602 unknown tool, no name, bad arguments, a binary operation', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const cases: Array<[Rpc, number]> = [
      [await post(wk, key, rpc('resources/list', undefined, 11)), -32601],
      [await post(wk, key, rpc('tools/call', { name: 'no_such_tool', arguments: {} }, 12)), -32602],
      [await post(wk, key, rpc('tools/call', { name: 'contacts_list', arguments: [1] }, 13)), -32602],
      [await post(wk, key, rpc('tools/call', { name: 'contacts_list', arguments: 'x' }, 14)), -32602],
      [await post(wk, key, rpc('tools/call', {}, 15)), -32602],
      [await post(wk, key, rpc('tools/call', { name: 'files_content', arguments: { id: uuidv7(NOW) } }, 16)), -32602],
    ]
    cases.forEach(([r, code], i) => {
      expect(r.status).toBe(200)
      expect(r.json.id).toBe(11 + i)
      expect(r.json.error.code).toBe(code)
    })
  })

  it('a notification and a client response are 202 with no body', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    for (const m of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { jsonrpc: '2.0', id: 9, result: {} }]) {
      const res = await wk.fetch(new Request(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(m) }))
      expect(res.status).toBe(202)
      expect(await res.text()).toBe('')
    }
  })

  it('GET and DELETE are 405 with Allow: POST, with or without a credential', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    for (const method of ['GET', 'DELETE']) {
      for (const headers of [{} as Record<string, string>, { authorization: `Bearer ${key}` }]) {
        const res = await wk.fetch(new Request(BASE + '/mcp', { method, headers }))
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('POST')
      }
    }
  })

  it('a non-JSON Content-Type is 415; parameters on application/json are fine; Accept is not checked', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const text = await post(wk, key, rpc('ping'), { 'content-type': 'text/plain' })
    expect(text.status).toBe(415)
    expect((await post(wk, key, rpc('ping'), { 'content-type': 'application/json; charset=utf-8', accept: 'text/html' })).json.result).toEqual({})
  })

  it('MCP-Protocol-Version: a supported value passes, an unknown one is 400, an absent one is accepted', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    expect((await post(wk, key, rpc('ping'), { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200)
    expect((await post(wk, key, rpc('ping'))).status).toBe(200)
    const bad = await post(wk, key, rpc('ping'), { 'mcp-protocol-version': '1999-01-01' })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('unsupported_protocol_version')
  })

  it('no credential is 401, a wrong key is 401', async () => {
    await initWorkspace()
    const wk = worker()
    expect((await post(wk, undefined, rpc('ping'))).status).toBe(401)
    expect((await post(wk, 'vk_not_a_key', rpc('ping'))).status).toBe(401)
  })
})

describe('Origin and CORS (D20)', () => {
  const ALLOWED = 'https://app.example'
  it('a disallowed Origin is 403 origin_forbidden; an allowed one gets CORS headers; none passes', async () => {
    await initWorkspace()
    const wk = worker({ CORS_ALLOWED_ORIGINS: ALLOWED })
    const { key } = await agentKey(wk, 'a')
    const evil = await post(wk, key, rpc('ping'), { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect(evil.json.error.code).toBe('origin_forbidden')
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    const ok = await post(wk, key, rpc('ping'), { origin: ALLOWED })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect((await post(wk, key, rpc('ping'))).status).toBe(200)
    const pre = await wk.fetch(new Request(BASE + '/mcp', { method: 'OPTIONS', headers: { origin: ALLOWED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'mcp-protocol-version,content-type,authorization' } }))
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('mcp-protocol-version')
    const preEvil = await wk.fetch(new Request(BASE + '/mcp', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }))
    expect(preEvil.status).toBe(403)
  })

  it('with CORS_ALLOWED_ORIGINS empty, any request carrying Origin is 403', async () => {
    await initWorkspace()
    const wk = worker({ CORS_ALLOWED_ORIGINS: '' })
    const { key } = await agentKey(wk, 'a')
    const r = await post(wk, key, rpc('ping'), { origin: 'https://app.example' })
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe('origin_forbidden')
    expect((await post(wk, key, rpc('ping'))).status).toBe(200)
  })
})

describe('gates and limits (D21)', () => {
  it('503 migrations_pending while the database is behind, 503 not_initialised without the marker', async () => {
    const wk0 = worker()
    const pending = await post(wk0, 'vk_x', rpc('ping'))
    expect(pending.status).toBe(503)
    expect(pending.json.error.code).toBe('not_initialised')
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, MIGRATIONS.slice(0, -1).map((m) => m.name))
    const behind = await post(worker(), 'vk_x', rpc('ping'))
    expect(behind.status).toBe(503)
    expect(behind.json.error.code).toBe('migrations_pending')
  })

  it('a bad configuration is 500 on /mcp', async () => {
    await initWorkspace()
    const r = await post(worker({ CORS_ALLOWED_ORIGINS: 'not an origin' }), 'vk_x', rpc('ping'))
    expect(r.status).toBe(500)
  })

  it('a body over 1 MiB is 413, declared or streamed; just under it is read', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const big = JSON.stringify(rpc('ping', { pad: 'x'.repeat(1024 * 1024) }))
    const over = await post(wk, key, null, {}, big)
    expect(over.status).toBe(413)
    const declared = await post(wk, key, rpc('ping'), { 'content-length': String(2 * 1024 * 1024) })
    expect(declared.status).toBe(413)
    const under = await post(wk, key, null, {}, JSON.stringify(rpc('ping', { pad: 'x'.repeat(1024 * 1024 - 200) })))
    expect(under.status).toBe(200)
  })

  it('tools/list, initialize and ping run no unit beyond authentication; tools/call costs what REST costs', async () => {
    await initWorkspace()
    const meter = meterD1(w.d1)
    const wk = worker({}, meter.d1)
    const { key } = await agentKey(wk, 'a')
    await post(wk, key, rpc('ping')) // warms the isolate and stamps the key
    const q = async (run: () => Promise<unknown>) => {
      meter.start()
      await run()
      return meter.take().queries
    }
    expect(await q(() => post(wk, key, rpc('tools/list')))).toBe(1)
    expect(await q(() => post(wk, key, rpc('initialize', { protocolVersion: '2025-11-25' })))).toBe(1)
    expect(await q(() => post(wk, key, rpc('ping')))).toBe(1)
    const viaRest = await q(() => rest(wk, 'GET', '/api/v1/tasks', key))
    const viaTool = await q(() => callTool(wk, key, 'tasks_list'))
    expect(viaRest).toBe(2)
    expect(viaTool).toBe(viaRest)
  })
})

describe('visibility (D6)', () => {
  const expected = (scopes: readonly string[]) =>
    registry
      .operations()
      .filter((o) => o.output !== 'binary' && (o.kind === 'account' ? o.agents === true : (o.scope ? scopes.includes(`${o.scope.resource}:${o.scope.action}`) : closeScopes(scopes).some((s) => s.endsWith(o.authority === 'write' ? ':write' : ':request_approval')))))
      .map((o) => toolName(o.name))
      .sort()

  it('an agent lists exactly the tools its scopes hold, plus me_get; never a human-only meta tool', async () => {
    await initWorkspace()
    const wk = worker()
    const scopes = ['contacts:read', 'schema:read', 'tasks:read', 'tasks:write']
    const { key } = await agentKey(wk, 'subset', scopes)
    const names = await listNames(wk, key)
    expect([...names].sort()).toEqual(expected(scopes))
    expect(names).toContain('me_get')
    expect(names).toContain('schema_get')
    expect(names).not.toContain('contacts_create')
  })

  it('a fully granted agent holds no agents_*, memberships_* or users_* tool; me_get is visible', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'full')
    const names = await listNames(wk, key)
    expect([...names].sort()).toEqual(expected(grantable))
    expect(names).toContain('me_get')
    expect(names.filter((n) => /^(agents|memberships|users|api_keys)_/.test(n))).toEqual([])
  })

  it('a user caller sees the configuration tools and the account operations', async () => {
    await initWorkspace()
    profile('user_owner', 'owner')
    const wk = worker()
    const owner = await session('user_owner', 'owner')
    const names = await listNames(wk, owner)
    expect(names).toContain('agents_list')
    expect(names).toContain('me_get')
  })

  it('calling a tool that is not visible returns insufficient_scope as a tool error, never a result', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'reader', ['contacts:read'])
    for (const [name, args] of [['contacts_create', { name: 'X' }], ['agents_list', {}]] as const) {
      const r = await callTool(wk, key, name, args)
      expect(r.status).toBe(200)
      expect(r.json.result.isError).toBe(true)
      expect(r.json.result.structuredContent.error.code).toBe('insufficient_scope')
      expect(JSON.parse(r.json.result.content[0].text)).toEqual(r.json.result.structuredContent)
    }
    expect(await rows('select count(*) n from contacts')).toEqual([{ n: 0 }])
  })

  it('a delegated agent from an OAuth token lists only its token scopes and no human-only tool', async () => {
    await initWorkspace()
    profile('user_b', 'member')
    kit.clients.set(DCR, 'Claude Desktop')
    const wk = worker()
    const token = await oauth('user_b', DCR, 'contacts:read tasks:read schema:read agents:write')
    const names = await listNames(wk, token)
    expect([...names].sort()).toEqual(expected(['contacts:read', 'tasks:read', 'schema:read']))
    expect(names.filter((n) => n.startsWith('agents_'))).toEqual([])
    const denied = await callTool(wk, token, 'contacts_create', { name: 'X' })
    expect(denied.json.result.structuredContent.error.code).toBe('insufficient_scope')
  })
})

describe('executor parity with REST (D12)', () => {
  it('the same input gives the same body and the same error code: success, validation, 404, 409', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const viaTool = await callTool(wk, key, 'companies_create', { name: 'Acme', domain: 'acme.example' })
    const co = viaTool.json.result.structuredContent
    expect(viaTool.json.result.isError).toBeUndefined()
    const viaRest = await rest(wk, 'GET', `/api/v1/companies/${co.id}`, key)
    expect(viaRest.json).toMatchObject({ id: co.id, name: 'Acme', domain: 'acme.example' })
    const got = await callTool(wk, key, 'companies_get', { id: co.id })
    expect(got.json.result.structuredContent).toEqual(viaRest.json)
    expect(JSON.parse(got.json.result.content[0].text)).toEqual(viaRest.json)

    // validation (400)
    const badRest = await rest(wk, 'POST', '/api/v1/companies', key, { name: 123 })
    const badTool = await callTool(wk, key, 'companies_create', { name: 123 })
    expect(badTool.json.result.isError).toBe(true)
    expect(badTool.json.result.structuredContent.error.code).toBe(badRest.json.error.code)
    // 404
    const missing = uuidv7(NOW)
    const nfRest = await rest(wk, 'GET', `/api/v1/companies/${missing}`, key)
    const nfTool = await callTool(wk, key, 'companies_get', { id: missing })
    expect(nfRest.status).toBe(404)
    expect(nfTool.json.result.structuredContent).toEqual(nfRest.json)
    // 409: a unique domain
    const dupRest = await rest(wk, 'POST', '/api/v1/companies', key, { name: 'Other', domain: 'acme.example' })
    const dupTool = await callTool(wk, key, 'companies_create', { name: 'Other', domain: 'acme.example' })
    expect(dupRest.status).toBe(409)
    expect(dupTool.json.result.structuredContent.error.code).toBe(dupRest.json.error.code)
  })

  it('a 204 operation answers {"ok":true} with no structuredContent', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const co = (await callTool(wk, key, 'companies_create', { name: 'Gone' })).json.result.structuredContent
    const del = await callTool(wk, key, 'companies_delete', { id: co.id })
    expect(del.json.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] })
    expect((await rest(wk, 'GET', `/api/v1/companies/${co.id}`, key)).status).toBe(404)
  })

  it('params and query arrive as strings: a numeric limit is coerced as REST coerces it; a bad one is the REST refusal', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    for (const n of ['one', 'two', 'three']) await callTool(wk, key, 'companies_create', { name: n })
    const two = await callTool(wk, key, 'companies_list', { limit: 2 })
    expect(two.json.result.structuredContent.data).toHaveLength(2)
    expect(two.json.result.structuredContent.next_cursor).not.toBeNull()
    const bad = await callTool(wk, key, 'companies_list', { limit: 'lots' })
    const badRest = await rest(wk, 'GET', '/api/v1/companies?limit=lots', key)
    expect(bad.json.result.structuredContent.error.code).toBe(badRest.json.error.code)
  })

  it('an unknown argument reaches the body, where a strict body refuses it; with no body it is a validation error', async () => {
    await initWorkspace()
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const strict = await callTool(wk, key, 'agents_create', { name: 'x', nonsense: true })
    expect(strict.json.result.isError).toBe(true)
    const owner = await session('user_owner', 'owner')
    const viaOwner = await callTool(wk, owner, 'agents_create', { name: 'x', nonsense: true })
    expect(viaOwner.json.result.structuredContent.error.code).toBe('validation_error')
    const noBody = await callTool(wk, key, 'companies_list', { nonsense: 1 })
    expect(noBody.json.result.structuredContent.error.code).toBe('validation_error')
    expect(noBody.json.result.structuredContent.error.message).toContain('nonsense')
  })

  it('an unexpected error is isError with internal and the masked message', async () => {
    await initWorkspace()
    const broken = {
      ...w.d1,
      prepare: (q: string) => (/from "companies"/i.test(q) ? (() => { throw new Error('secret db detail') })() : w.d1.prepare(q)),
      batch: w.d1.batch.bind(w.d1),
    }
    const wk = worker()
    const { key } = await agentKey(wk, 'a')
    const wkBroken = worker({}, broken as typeof w.d1)
    const r = await callTool(wkBroken, key, 'companies_list')
    expect(r.json.result.isError).toBe(true)
    expect(r.json.result.structuredContent).toEqual({ error: { code: 'internal', message: 'internal error' } })
    expect(JSON.stringify(r.json)).not.toContain('secret db detail')
  })
})

describe('writes through tools are events attributed to the calling agent (invariant 5, D19)', () => {
  it('two different agents each write with their own id as actor_id, in the same unit as the row', async () => {
    await initWorkspace()
    const wk = worker()
    const a = await agentKey(wk, 'agent-a')
    const b = await agentKey(wk, 'agent-b')
    const ca = (await callTool(wk, a.key, 'contacts_create', { name: 'Ada' })).json.result.structuredContent
    const cb = (await callTool(wk, b.key, 'companies_create', { name: 'Bee Co' })).json.result.structuredContent
    const events = await rows("select type, actor_id, resource_id from events where type in ('contact.created', 'company.created')")
    expect(events).toEqual(expect.arrayContaining([{ type: 'contact.created', actor_id: a.id, resource_id: ca.id }, { type: 'company.created', actor_id: b.id, resource_id: cb.id }]))
    expect(events).toHaveLength(2)
    await callTool(wk, b.key, 'contacts_update', { id: ca.id, name: 'Ada L' })
    const upd = await rows("select actor_id from events where type = 'contact.updated'")
    expect(upd).toEqual([{ actor_id: b.id }])
  })
})

describe('revocation (D19)', () => {
  it('after agents.update {disabled: true} that agent is 401 on /mcp, and only that one', async () => {
    await initWorkspace()
    const wk = worker()
    const a = await agentKey(wk, 'agent-a')
    const b = await agentKey(wk, 'agent-b')
    expect((await post(wk, a.key, rpc('ping'))).status).toBe(200)
    const owner = await session('user_owner', 'owner')
    expect((await rest(wk, 'PATCH', `/meta/v1/agents/${a.id}`, owner, { disabled: true })).status).toBe(200)
    expect((await post(wk, a.key, rpc('tools/list'))).status).toBe(401)
    expect((await callTool(wk, a.key, 'companies_create', { name: 'No' })).status).toBe(401)
    expect((await post(wk, b.key, rpc('ping'))).status).toBe(200)
    expect(await rows('select count(*) n from companies')).toEqual([{ n: 0 }])
  })
})

describe('the API-key-only deployment', () => {
  it('serves /mcp with no provider configured (bootstrap key)', async () => {
    const boot = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme', email: 'o@example.com' }, { now: NOW, newId: () => uuidv7(NOW) })
    const wk = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' })
    const names = await listNames(wk, boot.key)
    expect(names).toContain('contacts_create')
    expect((await callTool(wk, boot.key, 'companies_create', { name: 'Solo' })).json.result.structuredContent.name).toBe('Solo')
    const noAuth = await post(wk, undefined, rpc('ping'))
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('www-authenticate')).toBeNull()
  })
})
