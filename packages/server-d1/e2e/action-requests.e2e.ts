import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clerk } from '@clerk/testing/playwright'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// AGT8 cycle 1 PLAN, E2E Part 1 (real auth on a local Worker): the owner signs in with a Clerk session token; two API-key agents, P (proposal-only)
// and W (write), and the owner act on a task through REST, the CLI and MCP; the events are read from the Worker's LOCAL D1.
//
// Prerequisite, as for the other E2E specs (`e2e:connect`, `e2e:mcp-oauth`): a local Worker on E2E_BASE_URL (default http://localhost:8787) from this
// worktree (`pnpm -C packages/server-d1 dev`), a fresh local D1 migrated through 0011 (`wrangler d1 migrations apply DB --local`) and bootstrapped on the
// Clerk path (`bootstrap -- --org <n> --issuer <CLERK_ISSUER>`), with the full Clerk configuration of `.dev.vars.example` from `.env.dev` and
// CLERK_AUTHORIZED_PARTIES=<base URL>. The CLI must be built (`pnpm -C packages/cli build`): step 5 runs `packages/cli/dist/vibase.js`.
// Keys: `.env.dev` only (playwright.config.ts). Run with:  pnpm -C packages/server-d1 e2e:action-requests

const SECRET = process.env.CLERK_SECRET_KEY!
const BAPI = 'https://api.clerk.com/v1'
const stamp = Date.now()
const OWNER = { email: `agt8-o-${stamp}+clerk_test@example.com`, id: '' }
const CLI = fileURLToPath(new URL('../../cli/dist/vibase.js', import.meta.url))

const bapi = async (request: APIRequestContext, method: 'POST' | 'DELETE', path: string, data?: unknown) => {
  const res = await request.fetch(`${BAPI}${path}`, { method, headers: { authorization: `Bearer ${SECRET}` }, data })
  expect(res.ok(), `${method} ${path}`).toBe(true)
  return (await res.json()) as { id: string }
}
/** The local D1 of the running `wrangler dev` (the same persisted state as `wrangler d1 execute --local`), never a remote one. */
const sql = (query: string): Array<Record<string, any>> => {
  const out = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', query], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

test.beforeAll(async ({ request }) => {
  OWNER.id = (await bapi(request, 'POST', '/users', { email_address: [OWNER.email], skip_password_requirement: true, public_metadata: { vibase_role: 'owner' } })).id
})
test.afterAll(async ({ request }) => {
  if (OWNER.id) await request.fetch(`${BAPI}/users/${OWNER.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } })
})

type Res = { status: number; body: any }
let ownerToken = ''
const as = (request: APIRequestContext, token: string) => async (method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<Res> => {
  const res = await request.fetch(path, { method, headers: { authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) })
  const text = await res.text()
  return { status: res.status(), body: text ? JSON.parse(text) : null }
}
const P = { id: '', key: '' }
const W = { id: '', key: '' }
let taskId = ''
let firstRequest = ''
let secondRequest = ''
const sessionToken = async (page: Page) => {
  // Clerk loads after the navigation: wait for the session before reading it (the pattern of mcp-oauth.e2e.ts).
  await page.waitForFunction(() => (window as any).Clerk?.session, null, { timeout: 30000 })
  return page.evaluate(() => (window as unknown as { Clerk: { session: { getToken(): Promise<string> } } }).Clerk.session.getToken())
}
const cli = (key: string, ...args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, VIBASE_SERVER: process.env.E2E_BASE_URL ?? 'http://localhost:8787', VIBASE_API_KEY: key, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'vibase-cfg-')), XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'vibase-cache-')) } })
    return { status: 0, stdout, stderr: '' }
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

test('1. the owner signs in and makes agents P (proposal-only) and W (write), an API key each, and a task T', async ({ page, request }) => {
  await page.goto('/connect')
  await clerk.loaded({ page })
  await clerk.signIn({ page, emailAddress: OWNER.email })
  await page.goto('/connect')
  ownerToken = await sessionToken(page)
  const owner = as(request, ownerToken)
  for (const [who, name, scopes] of [
    [P, 'agt8-p', ['tasks:read', 'tasks:request_approval', 'action_requests:read']],
    [W, 'agt8-w', ['tasks:read', 'tasks:write', 'action_requests:read']],
  ] as const) {
    const agent = await owner('POST', '/meta/v1/agents', { name: `${name}-${stamp}`, scopes })
    expect(agent.status, JSON.stringify(agent.body)).toBe(201)
    who.id = agent.body.id
    const key = await owner('POST', '/meta/v1/api-keys', { agent_id: who.id })
    expect(key.status, JSON.stringify(key.body)).toBe(201)
    who.key = key.body.key
  }
  const task = await owner('POST', '/api/v1/tasks', { title: `T ${stamp}` })
  expect(task.status).toBe(201)
  taskId = task.body.id
})

test('2. P patches T directly: 403 insufficient_scope, and the message names the way to propose', async ({ request }) => {
  const res = await as(request, P.key)('PATCH', `/api/v1/tasks/${taskId}`, { title: 'x' })
  expect(res.status).toBe(403)
  expect(res.body.error.code).toBe('insufficient_scope')
  expect(res.body.error.message).toBe('requires tasks:write; this agent can propose this change but not run it: call action_requests.create with operation=tasks.update and the same arguments, plus a reason')
  expect((await as(request, P.key)('GET', `/api/v1/tasks/${taskId}`)).body.title).toBe(`T ${stamp}`)
})

test('3. P proposes tasks.update: 201 pending, T unchanged', async ({ request }) => {
  const res = await as(request, P.key)('POST', '/api/v1/action-requests', { operation: 'tasks.update', arguments: { id: taskId, title: 'x' }, reason: 'the title is wrong' })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  expect(res.body).toMatchObject({ status: 'pending', created_by: P.id, operation: 'tasks.update' })
  firstRequest = res.body.id
  expect((await as(request, P.key)('GET', `/api/v1/tasks/${taskId}`)).body.title).toBe(`T ${stamp}`)
})

test('4. P approves its own request: 403 insufficient_scope', async ({ request }) => {
  const res = await as(request, P.key)('POST', `/api/v1/action-requests/${firstRequest}/approve`)
  expect([res.status, res.body.error.code]).toEqual([403, 'insufficient_scope'])
  expect(res.body.error.message).toContain('tasks:write')
})

test('5. W approves through the CLI: executed, T retitled, decided_by W', async ({ request }) => {
  const out = cli(W.key, 'action-requests', 'approve', firstRequest)
  expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
  const body = JSON.parse(out.stdout)
  expect(body).toMatchObject({ status: 'executed', decided_by: W.id, created_by: P.id })
  expect((await as(request, W.key)('GET', `/api/v1/tasks/${taskId}`)).body.title).toBe('x')
})

test('6. P proposes again; the owner rejects with the session token: rejected, decided_by the owner principal', async ({ request }) => {
  const res = await as(request, P.key)('POST', '/api/v1/action-requests', { operation: 'tasks.update', arguments: { id: taskId, title: 'y' }, reason: 'second thoughts' })
  expect(res.status).toBe(201)
  secondRequest = res.body.id
  const rejected = await as(request, ownerToken)('POST', `/api/v1/action-requests/${secondRequest}/reject`, { decision_reason: 'not now' })
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(200)
  const ownerPrincipal = sql(`select id from users where auth_subject = '${OWNER.id}'`)[0]!.id
  expect(rejected.body).toMatchObject({ status: 'rejected', decided_by: ownerPrincipal, decision_reason: 'not now' })
  expect((await as(request, W.key)('GET', `/api/v1/tasks/${taskId}`)).body.title).toBe('x')
})

test('7. W lists the pending requests through MCP action_requests_list', async ({ request }) => {
  const pending = await as(request, P.key)('POST', '/api/v1/action-requests', { operation: 'tasks.update', arguments: { id: taskId, title: 'z' }, reason: 'third' })
  expect(pending.status).toBe(201)
  const res = await request.post('/mcp', { headers: { authorization: `Bearer ${W.key}`, 'content-type': 'application/json' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'action_requests_list', arguments: { status: 'pending' } } } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.result.isError).toBeFalsy()
  expect(body.result.structuredContent.data.map((r: any) => r.id)).toEqual([pending.body.id])
})

test('8. the events: task.updated attributed to W, action_request.* to P, W and the owner', async () => {
  const ownerPrincipal = sql(`select id from users where auth_subject = '${OWNER.id}'`)[0]!.id
  const events = sql(`select type, actor_id, resource_id from events where type like 'action_request.%' or (type = 'task.updated' and resource_id = '${taskId}') order by id`)
  const pick = (type: string, resource: string) => events.filter((e) => e.type === type && e.resource_id === resource).map((e) => e.actor_id)
  expect(pick('task.updated', taskId)).toEqual([W.id])
  expect(pick('action_request.created', firstRequest)).toEqual([P.id])
  expect(pick('action_request.approved', firstRequest)).toEqual([W.id])
  expect(pick('action_request.executed', firstRequest)).toEqual([W.id])
  expect(pick('action_request.created', secondRequest)).toEqual([P.id])
  expect(pick('action_request.rejected', secondRequest)).toEqual([ownerPrincipal])
})
