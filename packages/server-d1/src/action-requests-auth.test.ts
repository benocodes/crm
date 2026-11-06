import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { d1Binding } from '@vault/storage-d1'
import { generateApiKey } from '@vault/api'
import { mintClerkToken, mintOAuthToken } from '@vault/api/test/clerk'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { initDeploymentOperation } from './init-deployment.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// AGT8 D31: containment is closure, then intersection, in EVERY authentication path. For each credential path an effective set holding
// request_approval but not write proposes (201) and is refused the direct write (403 insufficient_scope), and a write grant narrowed by, or
// narrowing, a request_approval grant keeps request_approval only. Real tokens, the real Worker, a fake Backend API, no network.
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
  kit.fetch.reset()
  kit.profiles.clear()
  kit.clients.clear()
  clock = new Date()
})

const BASE = 'https://w.test'
const CLI = 'client_cli'
const DCR = 'client_dcr'
type Res = { status: number; json: any }

async function initWorkspace(): Promise<{ organizationId: string }> {
  const link = { organizationId: uuidv7(NOW), authProvider: 'clerk', authOrgId: kit.issuer.issuer }
  await execute(d1Binding(w.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
  const at = NOW.toISOString()
  await w.d1.prepare('insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)').bind(link.organizationId, at, at, 'Acme', link.authProvider, link.authOrgId).run()
  return link
}
const worker = () => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI }, { fetch: kit.fetch, clock: () => clock })
const session = (sub: string, role: unknown) => mintClerkToken(kit.issuer, { sub, extra: { vibase_role: role }, now: clock })
const oauth = (sub: string, clientId: string, scope: string) => mintOAuthToken(kit.issuer, { sub, clientId, scope, now: clock })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, tok: string, body?: unknown): Promise<Res> => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const profile = (sub: string, role: unknown) => kit.profiles.set(sub, clerkUser({ id: sub, email: `${sub}@x.test`, verified: true, role }))
const setScopes = (agentId: string, scopes: string[]) => w.d1.prepare('update agents set scopes = ? where id = ?').bind(JSON.stringify(scopes), agentId).run()
const rows = async (sqlText: string, ...binds: unknown[]) => (await w.d1.prepare(sqlText).bind(...binds).all()).results as Array<Record<string, any>>

async function seedKey(org: string, scopes: string[]): Promise<string> {
  const at = NOW.toISOString()
  const found = (await rows("select id from principals where kind = 'system'"))[0]
  const system = found ? (found.id as string) : uuidv7(NOW)
  if (!found) await w.d1.prepare("insert into principals (id, kind, created_at) values (?, 'system', ?)").bind(system, at).run()
  const agentId = uuidv7(NOW)
  await w.d1.prepare("insert into principals (id, kind, created_at) values (?, 'agent', ?)").bind(agentId, at).run()
  await w.d1.prepare('insert into agents (id, created_at, updated_at, organization_id, name, scopes, created_by) values (?, ?, ?, ?, ?, ?, ?)').bind(agentId, at, at, org, 'keyed', JSON.stringify(scopes), system).run()
  const secret = await generateApiKey((n) => crypto.getRandomValues(new Uint8Array(n)))
  await w.d1.prepare('insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)').bind(uuidv7(NOW), at, at, org, agentId, secret.hash, secret.prefix, system).run()
  return secret.key
}

const makeTask = async (wk: ReturnType<typeof worker>) => {
  profile('user_owner', 'owner')
  const created = await call(wk, 'POST', '/api/v1/tasks', await session('user_owner', 'owner'), { title: 'start' })
  expect(created.status).toBe(201)
  return created.json.id as string
}
/** The case every path must show: the proposal is accepted, the direct write refused with the hint, the task untouched. */
async function proposalOnly(wk: ReturnType<typeof worker>, tok: () => Promise<string> | string, taskId: string) {
  const propose = await call(wk, 'POST', '/api/v1/action-requests', await tok(), { operation: 'tasks.update', arguments: { id: taskId, title: 'proposed' }, reason: 'because' })
  expect(propose.status, JSON.stringify(propose.json)).toBe(201)
  expect(propose.json.status).toBe('pending')
  const direct = await call(wk, 'PATCH', `/api/v1/tasks/${taskId}`, await tok(), { title: 'direct' })
  expect([direct.status, direct.json.error.code]).toEqual([403, 'insufficient_scope'])
  expect(direct.json.error.message).toContain('call action_requests.create with operation=tasks.update')
  expect((await rows('select title from tasks where id = ?', taskId))[0]!.title).toBe('start')
}

describe('a proposal-only effective set proposes and is refused the direct write, on every credential path', () => {
  it('API key: stored request_approval; and a stored write closes to request_approval at authentication, never written back', async () => {
    const { organizationId } = await initWorkspace()
    const wk = worker()
    const taskId = await makeTask(wk)
    const proposalKey = await seedKey(organizationId, ['tasks:read', 'tasks:request_approval'])
    await proposalOnly(wk, () => proposalKey, taskId)
    const writeKey = await seedKey(organizationId, ['tasks:read', 'tasks:write'])
    const viaWrite = await call(wk, 'POST', '/api/v1/action-requests', writeKey, { operation: 'tasks.update', arguments: { id: taskId, title: 'asked' }, reason: 'review please' })
    expect(viaWrite.status, JSON.stringify(viaWrite.json)).toBe(201)
    expect((await rows('select scopes from agents where name = ?', 'keyed')).map((r) => JSON.parse(r.scopes).sort())).toEqual([['tasks:read', 'tasks:request_approval'], ['tasks:read', 'tasks:write']])
  })

  it('independent agent account: stored request_approval; a stored write closes to request_approval', async () => {
    await initWorkspace()
    const wk = worker()
    const taskId = await makeTask(wk)
    profile('agent_acct', 'agent')
    const tok = () => session('agent_acct', 'agent')
    expect((await call(wk, 'GET', '/meta/v1/me', await tok())).status).toBe(200)
    const [agent] = await rows("select id from agents where auth_subject = 'agent_acct'")
    await setScopes(agent!.id, ['tasks:read', 'tasks:request_approval'])
    await proposalOnly(wk, tok, taskId)
    await setScopes(agent!.id, ['tasks:read', 'tasks:write'])
    const viaWrite = await call(wk, 'POST', '/api/v1/action-requests', await tok(), { operation: 'tasks.update', arguments: { id: taskId, title: 'asked' }, reason: 'r' })
    expect(viaWrite.status).toBe(201)
  })

  it('delegated OAuth agent: a request_approval token over a write cap proposes only; a write token over a request_approval cap proposes only', async () => {
    await initWorkspace()
    const wk = worker()
    const taskId = await makeTask(wk)
    profile('user_b', 'owner')
    kit.clients.set(DCR, 'Claude Desktop')
    const first = await call(wk, 'GET', '/meta/v1/me', await oauth('user_b', DCR, 'tasks:read'))
    const agentId = first.json.principal.id as string
    // Owner-set cap: write only. The token asks for request_approval only.
    await setScopes(agentId, ['tasks:read', 'tasks:write'])
    await proposalOnly(wk, () => oauth('user_b', DCR, 'tasks:read tasks:request_approval'), taskId)
    // Owner-set cap: request_approval only. The token asks for write.
    await setScopes(agentId, ['tasks:read', 'tasks:request_approval'])
    await proposalOnly(wk, () => oauth('user_b', DCR, 'tasks:read tasks:write'), taskId)
    // A token narrowed to read holds neither.
    const readOnly = await call(wk, 'POST', '/api/v1/action-requests', await oauth('user_b', DCR, 'tasks:read'), { operation: 'tasks.update', arguments: { id: taskId, title: 'x' }, reason: 'r' })
    expect([readOnly.status, readOnly.json.error.code]).toEqual([403, 'insufficient_scope'])
  })

  it('CLI token (the person as themselves): a request_approval token under an owner role proposes only; a write token also proposes', async () => {
    await initWorkspace()
    const wk = worker()
    const taskId = await makeTask(wk)
    await proposalOnly(wk, () => oauth('user_owner', CLI, 'tasks:read tasks:request_approval'), taskId)
    const me = await call(wk, 'GET', '/meta/v1/me', await oauth('user_owner', CLI, 'tasks:write'))
    expect(me.json.active_organization.scopes).toEqual(['tasks:request_approval', 'tasks:write'])
  })

  it('human session: the role\'s write holds its request_approval (propose and write both work), and the closure is computed, not stored', async () => {
    await initWorkspace()
    const wk = worker()
    const taskId = await makeTask(wk)
    const tok = await session('user_owner', 'owner')
    expect((await call(wk, 'POST', '/api/v1/action-requests', tok, { operation: 'tasks.update', arguments: { id: taskId, title: 'asked' }, reason: 'r' })).status).toBe(201)
    expect((await call(wk, 'PATCH', `/api/v1/tasks/${taskId}`, tok, { title: 'direct' })).status).toBe(200)
    profile('user_member', 'member')
    const member = await session('user_member', 'member')
    expect((await call(wk, 'POST', '/api/v1/action-requests', member, { operation: 'tasks.update', arguments: { id: taskId, title: 'asked' }, reason: 'r' })).status).toBe(201)
    expect(await rows('select scopes from agents')).toEqual([])
  })
})
