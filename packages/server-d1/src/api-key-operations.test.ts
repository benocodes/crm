import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding } from '@vibase/storage-d1'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { initDeploymentOperation } from './init-deployment.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, composeD1Worker, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[CORE351]] group 5: the key operations through the composed Worker with both databases (Miniflare, a fake Clerk): a key made by `api_keys.create` authenticates, is listed, and after `revoke` is refused on the same warm Worker.
let w: WorkerD1
let kit: ClerkKit
let agentId: string
let clock = new Date()
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
  clock = new Date()
})

const BASE = 'https://w.test'
const worker = (extra: Record<string, unknown> = {}) =>
  composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ...extra } as never, {
    fetch: kit.fetch,
    clock: () => clock,
  })
async function initWorkspace() {
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
}
const owner = () => {
  kit.profiles.set('user_owner', clerkUser({ id: 'user_owner', email: 'o@x.test', verified: true, role: 'owner' }))
  return mintClerkToken(kit.issuer, { sub: 'user_owner', extra: { vibase_role: 'owner' }, now: clock })
}
async function rest(wk: ReturnType<typeof worker>, method: string, path: string, token: string, body?: unknown) {
  const res = await wk.fetch(
    new Request(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const count = async (db: { prepare: (q: string) => any }, table: string) =>
  (await db.prepare(`select count(*) as n from ${table}`).first()).n as number

describe('API key operations through the composed Worker (CORE351)', () => {
  it('create, authenticate, list, revoke: refused on the same warm Worker, all in control', async () => {
    await initWorkspace()
    const wk = worker()
    const tok = await owner()
    const agent = await rest(wk, 'POST', '/meta/v1/agents', tok, { name: 'bot', scopes: ['tasks:read'] })
    agentId = agent.json.id
    const events = await count(w.d1, 'events')
    const made = await rest(wk, 'POST', '/meta/v1/api-keys', tok, { agent_id: agentId })
    expect(made.status).toBe(201)
    expect(await count(w.d1, 'events')).toBe(events)
    expect(await count(w.control, 'api_keys')).toBe(1)
    expect((await rest(wk, 'GET', '/meta/v1/me', made.json.key)).status).toBe(200)
    const list = await rest(wk, 'GET', '/meta/v1/api-keys', tok)
    expect(list.json.data.map((k: any) => k.id)).toEqual([made.json.id])
    expect((await rest(wk, 'POST', `/meta/v1/api-keys/${made.json.id}/revoke`, tok)).status).toBe(200)
    expect((await rest(wk, 'GET', '/meta/v1/me', made.json.key)).status).toBe(401)
    expect(await count(w.control, 'control_audit')).toBeGreaterThanOrEqual(2)
  })
})
