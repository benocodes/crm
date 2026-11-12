import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../rest/app.js'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { AGENT_SCOPES, NO_SUCH, NOW, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'
import { scopesForRole } from '../auth/roles.js'

// API219 (D14, D20): `webhooks.deliveries` reads a subscription's delivery rows (keyset by id, oldest first like webhooks.list, filterable by status), with the ownership of
// `webhooks.get`; the table is in `schema.get` and its rows are exactly the delivery read schema.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const TASKS = ['tasks:read', 'events:read']
const KEYS = ['attempts', 'created_at', 'delivered_at', 'event_id', 'event_type', 'id', 'last_attempt_at', 'last_error', 'last_status_code', 'next_attempt_at', 'status', 'subscription_id']
const AT = NOW.toISOString()

/** A subscription with `n` pending rows (through the dispatcher), the last of them marked delivered and the one before dead. */
async function seeded(agent: string, n = 4) {
  const sub = await k.create(agent)
  for (let i = 0; i < n; i++) await k.task(`t${i}`)
  await k.dispatch()
  const rows = await k.deliveries(sub.id)
  expect(rows).toHaveLength(n)
  await k.e.d1!.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = 1, last_attempt_at = ?, last_status_code = 204, delivered_at = ? WHERE id = ?").bind(AT, AT, rows[n - 1]!.id).run()
  await k.e.d1!.prepare("UPDATE webhook_deliveries SET status = 'dead', attempts = 8, last_attempt_at = ?, last_status_code = 500, last_error = 'http_status' WHERE id = ?").bind(AT, rows[n - 2]!.id).run()
  return { sub, rows: await k.deliveries(sub.id) }
}

describe('webhooks.deliveries (D14)', () => {
  it("an agent reads its own subscription's rows oldest first, with exactly the delivery read schema", async () => {
    const a = await k.seedAgent(TASKS)
    const { sub, rows } = await seeded(a)
    const r = await k.call({ as: 'agent', id: a, scopes: AGENT_SCOPES }, 'GET', `${BASE}/${sub.id}/deliveries`)
    expect(r.status, r.text).toBe(200)
    expect(r.body.next_cursor).toBeNull()
    expect(r.body.data.map((d: any) => d.id)).toEqual(rows.map((d) => d.id))
    for (const d of r.body.data) expect(Object.keys(d).sort()).toEqual(KEYS)
    expect(r.body.data.map((d: any) => d.status)).toEqual(['pending', 'pending', 'dead', 'delivered'])
    expect(r.body.data[2]).toMatchObject({ subscription_id: sub.id, attempts: 8, last_status_code: 500, last_error: 'http_status', delivered_at: null })
    expect(r.body.data[3]).toMatchObject({ attempts: 1, last_status_code: 204, delivered_at: AT })
    expect(r.body.data[0]).toMatchObject({ event_type: 'task.created', next_attempt_at: AT, last_attempt_at: null, last_status_code: null, last_error: null })
    expect(r.text).not.toMatch(/lease_|organization_id|created_by/)
  })

  it('the status filter and after/limit paging', async () => {
    const a = await k.seedAgent(TASKS)
    const { sub, rows } = await seeded(a)
    const who = { as: 'agent' as const, id: a, scopes: AGENT_SCOPES }
    const pending = await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?status=pending`)
    expect(pending.body.data.map((d: any) => d.id)).toEqual([rows[0]!.id, rows[1]!.id])
    expect((await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?status=dead`)).body.data.map((d: any) => d.id)).toEqual([rows[2]!.id])
    expect((await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?status=cancelled`)).body.data).toEqual([])
    const first = await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?limit=3`)
    expect(first.body.data.map((d: any) => d.id)).toEqual(rows.slice(0, 3).map((d) => d.id))
    expect(first.body.next_cursor).toBe(rows[2]!.id)
    const second = await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?limit=3&after=${first.body.next_cursor}`)
    expect([second.body.data.map((d: any) => d.id), second.body.next_cursor]).toEqual([[rows[3]!.id], null])
    const filteredPage = await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?status=pending&limit=1`)
    expect([filteredPage.body.data.length, filteredPage.body.next_cursor]).toEqual([1, rows[0]!.id])
    expect((await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?status=bogus`)).status).toBe(400)
    expect((await k.call(who, 'GET', `${BASE}/${sub.id}/deliveries?limit=201`)).status).toBe(400)
  })

  it("another agent's subscription is 404; an owner reads any; a deleted subscription is 404 like webhooks.get; an unknown id is 404", async () => {
    const a = await k.seedAgent(TASKS)
    const b = await k.seedAgent(TASKS)
    const { sub } = await seeded(a)
    const stranger = await k.call({ as: 'agent', id: b, scopes: AGENT_SCOPES }, 'GET', `${BASE}/${sub.id}/deliveries`)
    expect([stranger.status, stranger.body.error.code]).toEqual([404, 'not_found'])
    expect((await k.owner('GET', `${BASE}/${sub.id}/deliveries`)).body.data).toHaveLength(4)
    expect((await k.owner('GET', `${BASE}/${NO_SUCH}/deliveries`)).status).toBe(404)
    await k.owner('DELETE', `${BASE}/${sub.id}`)
    expect((await k.owner('GET', `${BASE}/${sub.id}/deliveries`)).status).toBe(404)
    expect((await k.owner('GET', `${BASE}/${sub.id}`)).status).toBe(404)
  })

  it('a member: 403 insufficient_scope; an agent without webhooks:read: 403 naming it', async () => {
    const a = await k.seedAgent(TASKS)
    const sub = await k.create(a)
    const memberScopes = scopesForRole('member', k.registry.declaredScopes()).toStrings()
    const m = await k.call({ as: 'user', scopes: memberScopes }, 'GET', `${BASE}/${sub.id}/deliveries`)
    expect([m.status, m.body.error.code]).toEqual([403, 'insufficient_scope'])
    const w = await k.call({ as: 'agent', id: a, scopes: ['webhooks:write'] }, 'GET', `${BASE}/${sub.id}/deliveries`)
    expect([w.status, w.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(w.body.error.message).toContain('webhooks:read')
  })

  it('is on the meta OpenAPI document and not the api one, and is an MCP tool for an agent holding webhooks:read', async () => {
    const meta = (await (await k.app.request('/meta/v1/openapi.json')).json()) as any
    const api = (await (await k.app.request('/api/v1/openapi.json')).json()) as any
    expect(meta.paths['/meta/v1/webhooks/{id}/deliveries'].get.operationId).toBe('webhooks.deliveries')
    expect(JSON.stringify(api.paths)).not.toContain('deliveries')
    const token = mintTestUserToken({ userId: k.e.agentId, organizationId: k.e.organizationId, scopes: AGENT_SCOPES, kind: 'agent' })
    const res = (await (await k.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json()) as any
    expect(res.result.tools.map((t: any) => t.name)).toContain('webhooks_deliveries')
  })

  it('a binding that is not D1 answers 501 not_implemented after the scope check', async () => {
    const cold = createApp({ storage: coldStorage(), registry: k.registry, userAuthenticator: fakeUserAuthenticator() })
    const token = (scopes: string[]) => mintTestUserToken({ userId: k.e.userId, organizationId: k.e.organizationId, scopes, kind: 'user' })
    const init = (scopes: string[]) => ({ headers: { authorization: `Bearer ${token(scopes)}` } })
    const res = await cold.request(`${BASE}/${NO_SUCH}/deliveries`, init(['webhooks:read']))
    expect([res.status, ((await res.json()) as any).error.code]).toEqual([501, 'not_implemented'])
    expect((await cold.request(`${BASE}/${NO_SUCH}/deliveries`, init(['tasks:read']))).status).toBe(403)
  })
})

describe('the table in schema.get (API63)', () => {
  it('webhook_deliveries is listed with its columns and descriptions; the secret and cursor tables stay hidden', async () => {
    const r = await k.call({ as: 'user', scopes: ['schema:read'] }, 'GET', '/meta/v1/schema')
    expect(r.status, r.text).toBe(200)
    const tables = r.body.tables as { name: string; description?: string; columns: { name: string }[] }[]
    const t = tables.find((x) => x.name === 'webhook_deliveries')
    expect(t, 'webhook_deliveries is in schema.get').toBeDefined()
    expect(t!.description?.length ?? 0).toBeGreaterThan(20)
    expect(t!.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['subscription_id', 'event_id', 'event_type', 'status', 'attempts', 'next_attempt_at', 'last_error', 'delivered_at']))
    expect(tables.map((x) => x.name)).not.toContain('webhook_secrets')
    expect(tables.map((x) => x.name)).not.toContain('webhook_dispatch_state')
  })
})
