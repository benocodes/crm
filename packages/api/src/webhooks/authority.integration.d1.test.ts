import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { scopesForRole, isAgentGrantable, SCOPE_DESCRIPTIONS, SCOPE_POLICY } from '../auth/roles.js'
import { createApp } from '../rest/app.js'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { AGENT_SCOPES, NO_SUCH, URL_OK, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'

// API7 cycle 1 (D1, D2, D22, D23): who may do what to a webhook subscription. The matrix is caller kind x operation, through the real router on D1.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const OPS = ['webhooks.list', 'webhooks.get', 'webhooks.create', 'webhooks.update', 'webhooks.delete', 'webhooks.rotate_secret']
const TASKS = ['tasks:read']
const BASE = '/meta/v1/webhooks'
const body = (over: Record<string, unknown> = {}) => ({ url: URL_OK, event_types: ['task.created'], ...over })

describe('an agent for itself (D1)', () => {
  it('creates for itself with agent_id omitted, and with its own id; the answer names it and carries the secret once', async () => {
    await k.grant(k.e.agentId, TASKS)
    const a = await k.agent('POST', BASE, body())
    expect([a.status, a.body.agent_id, a.body.status]).toEqual([201, k.e.agentId, 'active'])
    expect(a.body.secret).toMatch(/^whsec_/)
    const b = await k.agent('POST', BASE, body({ agent_id: k.e.agentId }))
    expect([b.status, b.body.agent_id]).toEqual([201, k.e.agentId])
  })

  it('reads, updates, rotates and deletes its own', async () => {
    await k.grant(k.e.agentId, TASKS)
    const made = (await k.agent('POST', BASE, body())).body
    expect((await k.agent('GET', `${BASE}/${made.id}`)).status).toBe(200)
    expect((await k.agent('GET', BASE)).body.data.map((s: any) => s.id)).toEqual([made.id])
    expect((await k.agent('PATCH', `${BASE}/${made.id}`, { status: 'paused' })).body.status).toBe('paused')
    expect((await k.agent('POST', `${BASE}/${made.id}/rotate-secret`)).status).toBe(200)
    expect((await k.agent('DELETE', `${BASE}/${made.id}`)).status).toBe(204)
  })

  it("another agent's subscription is 404 on get, update, delete and rotate, and absent from the list", async () => {
    const other = await k.seedAgent(TASKS)
    const theirs = await k.create(other)
    for (const [method, path, payload] of [
      ['GET', `${BASE}/${theirs.id}`, undefined],
      ['PATCH', `${BASE}/${theirs.id}`, { status: 'paused' }],
      ['DELETE', `${BASE}/${theirs.id}`, undefined],
      ['POST', `${BASE}/${theirs.id}/rotate-secret`, undefined],
    ] as const) {
      const r = await k.agent(method, path, payload)
      expect([method, r.status, r.body.error.code]).toEqual([method, 404, 'not_found'])
    }
    expect((await k.agent('GET', BASE)).body.data).toEqual([])
    // and the owner still sees it untouched
    expect((await k.owner('GET', `${BASE}/${theirs.id}`)).body.status).toBe('active')
  })

  it('naming another agent, an unknown one: 400 invalid_reference (the same answer for both)', async () => {
    const other = await k.seedAgent(TASKS)
    for (const agent_id of [other, NO_SUCH]) {
      const r = await k.agent('POST', BASE, body({ agent_id }))
      expect([r.status, r.body.error.code], agent_id).toEqual([400, 'invalid_reference'])
    }
    expect(await k.all('select id from webhook_subscriptions')).toEqual([])
  })

  it('a delegated agent for itself: 400 agent_not_eligible', async () => {
    const delegated = await k.seedAgent(TASKS, { delegated: true })
    const r = await k.agent('POST', BASE, body(), { id: delegated })
    expect([r.status, r.body.error.code]).toEqual([400, 'agent_not_eligible'])
    expect(await k.all('select id from webhook_subscriptions')).toEqual([])
  })
})

describe('the owner (D1)', () => {
  it('names any live, non-delegated agent, and gets, lists, updates, rotates and deletes any subscription', async () => {
    const a = await k.seedAgent(TASKS)
    const b = await k.seedAgent(TASKS)
    const sa = await k.create(a)
    const sb = await k.create(b)
    expect([sa.agent_id, sb.agent_id]).toEqual([a, b])
    expect((await k.owner('GET', BASE)).body.data.map((s: any) => s.id).sort()).toEqual([sa.id, sb.id].sort())
    expect((await k.owner('GET', `${BASE}/${sb.id}`)).status).toBe(200)
    expect((await k.owner('PATCH', `${BASE}/${sa.id}`, { status: 'paused' })).status).toBe(200)
    expect((await k.owner('POST', `${BASE}/${sb.id}/rotate-secret`)).status).toBe(200)
    expect((await k.owner('DELETE', `${BASE}/${sa.id}`)).status).toBe(204)
  })

  it('an owner naming a disabled agent or an unknown one: 400 invalid_reference; naming a delegated agent: 400 agent_not_eligible', async () => {
    const disabled = await k.seedAgent(TASKS, { disabled: true })
    const delegated = await k.seedAgent(TASKS, { delegated: true })
    const expectCode = async (agent_id: string, status: number, code: string) => {
      const r = await k.owner('POST', BASE, body({ agent_id }))
      expect([r.status, r.body.error.code], agent_id).toEqual([status, code])
    }
    await expectCode(disabled, 400, 'invalid_reference')
    await expectCode(NO_SUCH, 400, 'invalid_reference')
    await expectCode(delegated, 400, 'agent_not_eligible')
    expect(await k.all('select id from webhook_subscriptions')).toEqual([])
  })

  it('an owner who omits agent_id: 400 validation_error (a subscription belongs to an agent)', async () => {
    const r = await k.owner('POST', BASE, body())
    expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
  })

  it('the list takes an agent_id filter and pages by keyset (limit, next_cursor)', async () => {
    const a = await k.seedAgent(TASKS)
    const b = await k.seedAgent(TASKS)
    const made = [await k.create(a), await k.create(a), await k.create(b)]
    const onlyA = await k.owner('GET', `${BASE}?agent_id=${a}`)
    expect(onlyA.body.data.map((s: any) => s.id).sort()).toEqual([made[0].id, made[1].id].sort())
    const first = await k.owner('GET', `${BASE}?limit=2`)
    expect(first.body.data).toHaveLength(2)
    expect(first.body.next_cursor).toBe(first.body.data[1].id)
    const second = await k.owner('GET', `${BASE}?limit=2&after=${first.body.next_cursor}`)
    expect([second.body.data.length, second.body.next_cursor]).toEqual([1, null])
  })
})

describe('scopes (D2)', () => {
  it('a member lacks every webhook scope: 403 insufficient_scope on all six', async () => {
    const memberScopes = scopesForRole('member', k.registry.declaredScopes()).toStrings()
    expect(memberScopes.filter((s) => s.startsWith('webhooks:'))).toEqual([])
    const sub = await k.create(await k.seedAgent(TASKS))
    const calls: [string, string, unknown?][] = [
      ['GET', BASE],
      ['GET', `${BASE}/${sub.id}`],
      ['POST', BASE, body({ agent_id: k.e.agentId })],
      ['PATCH', `${BASE}/${sub.id}`, { status: 'paused' }],
      ['DELETE', `${BASE}/${sub.id}`],
      ['POST', `${BASE}/${sub.id}/rotate-secret`],
    ]
    for (const [method, path, payload] of calls) {
      const r = await k.call({ as: 'user', scopes: memberScopes }, method, path, payload)
      expect([method, path, r.status, r.body.error.code]).toEqual([method, path, 403, 'insufficient_scope'])
    }
  })

  it('an agent without the scope: 403 insufficient_scope naming it (read-only cannot write, write-only cannot read)', async () => {
    await k.grant(k.e.agentId, TASKS)
    const mine = (await k.agent('POST', BASE, body())).body
    const readOnly = { scopes: ['webhooks:read'] }
    const writeOnly = { scopes: ['webhooks:write'] }
    const denied = async (r: Awaited<ReturnType<typeof k.agent>>, scope: string) => {
      expect([r.status, r.body.error.code]).toEqual([403, 'insufficient_scope'])
      expect(r.body.error.message).toContain(scope)
    }
    await denied(await k.agent('POST', BASE, body(), readOnly), 'webhooks:write')
    await denied(await k.agent('PATCH', `${BASE}/${mine.id}`, { status: 'paused' }, readOnly), 'webhooks:write')
    await denied(await k.agent('DELETE', `${BASE}/${mine.id}`, undefined, readOnly), 'webhooks:write')
    await denied(await k.agent('POST', `${BASE}/${mine.id}/rotate-secret`, undefined, readOnly), 'webhooks:write')
    await denied(await k.agent('GET', BASE, undefined, writeOnly), 'webhooks:read')
    await denied(await k.agent('GET', `${BASE}/${mine.id}`, undefined, writeOnly), 'webhooks:read')
  })

  it('both scopes are declared, owner-held, not member-held, agent-grantable, described; no request_approval scope exists', () => {
    const declared = k.registry.declaredScopes()
    expect(declared).toEqual(expect.arrayContaining(['webhooks:read', 'webhooks:write']))
    expect(declared).not.toContain('webhooks:request_approval')
    for (const s of ['webhooks:read', 'webhooks:write']) {
      expect(SCOPE_POLICY[s], s).toEqual({ member: false, agentGrantable: true })
      expect(isAgentGrantable(s), s).toBe(true)
      expect(scopesForRole('owner', declared).toStrings(), s).toContain(s)
      expect(SCOPE_DESCRIPTIONS[s]?.length ?? 0, s).toBeGreaterThan(10)
    }
  })
})

describe('proposals (D2)', () => {
  it('every webhook write is registered proposal-ineligible with a reason, and an action request naming one is refused', async () => {
    for (const name of ['webhooks.create', 'webhooks.update', 'webhooks.delete', 'webhooks.rotate_secret']) {
      const op = k.registry.get(name)
      expect(op?.kind === 'tenant' && op.proposal && !op.proposal.eligible && op.proposal.reason.length > 0, name).toBe(true)
    }
    const r = await k.owner('POST', '/api/v1/action-requests', { operation: 'webhooks.create', arguments: { url: URL_OK, agent_id: k.e.agentId }, reason: 'because' })
    expect([r.status, r.body.error.code]).toEqual([400, 'operation_not_proposable'])
    expect(await k.all('select id from action_requests')).toEqual([])
  })
})

describe('surfaces (D22, D23)', () => {
  it('all six are on the meta OpenAPI document and none on the api one', async () => {
    const meta = (await (await k.app.request('/meta/v1/openapi.json')).json()) as any
    const api = (await (await k.app.request('/api/v1/openapi.json')).json()) as any
    const found = Object.fromEntries(Object.entries<any>(meta.paths).flatMap(([p, ms]) => Object.entries<any>(ms).map(([m, op]) => [op.operationId, `${m.toUpperCase()} ${p}`])))
    for (const name of OPS) expect(found[name], name).toBeDefined()
    expect(OPS.map((n) => found[n])).toEqual(['GET /meta/v1/webhooks', 'GET /meta/v1/webhooks/{id}', 'POST /meta/v1/webhooks', 'PATCH /meta/v1/webhooks/{id}', 'DELETE /meta/v1/webhooks/{id}', 'POST /meta/v1/webhooks/{id}/rotate-secret'])
    expect(JSON.stringify(api.paths)).not.toContain('webhooks')
  })

  it('all six are MCP tools for an agent holding both scopes, and none for one holding neither', async () => {
    const rpc = async (scopes: string[], method: string, params: unknown) => {
      const token = mintTestUserToken({ userId: k.e.agentId, organizationId: k.e.organizationId, scopes, kind: 'agent' })
      return (await (await k.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any
    }
    const names = (await rpc(AGENT_SCOPES, 'tools/list', {})).result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(OPS.map((n) => n.replaceAll('.', '_'))))
    const none = (await rpc(['tasks:read'], 'tools/list', {})).result.tools.map((t: any) => t.name)
    expect(none.filter((n: string) => n.startsWith('webhooks_'))).toEqual([])
    await k.grant(k.e.agentId, TASKS)
    const out = await rpc(AGENT_SCOPES, 'tools/call', { name: 'webhooks_create', arguments: { url: URL_OK, event_types: ['task.created'] } })
    expect(out.result.isError, JSON.stringify(out)).not.toBe(true)
    expect(JSON.stringify(out)).toContain('whsec_')
  })

  it('a binding that is not D1 answers 501 not_implemented for all six, after the scope check', async () => {
    const cold = createApp({ storage: coldStorage(), registry: k.registry, userAuthenticator: fakeUserAuthenticator() })
    const token = (scopes: string[]) => mintTestUserToken({ userId: k.e.userId, organizationId: k.e.organizationId, scopes, kind: 'user' })
    const calls: [string, string, unknown?][] = [
      ['GET', BASE],
      ['GET', `${BASE}/${NO_SUCH}`],
      ['POST', BASE, body({ agent_id: k.e.agentId })],
      ['PATCH', `${BASE}/${NO_SUCH}`, { status: 'paused' }],
      ['DELETE', `${BASE}/${NO_SUCH}`],
      ['POST', `${BASE}/${NO_SUCH}/rotate-secret`],
    ]
    for (const [method, path, payload] of calls) {
      const init = (scopes: string[]) => ({ method, headers: { authorization: `Bearer ${token(scopes)}`, 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) })
      const res = await cold.request(path, init(['webhooks:read', 'webhooks:write']))
      expect([method, res.status, ((await res.json()) as any).error.code]).toEqual([method, 501, 'not_implemented'])
      expect((await cold.request(path, init(['tasks:read']))).status, method).toBe(403)
    }
  })
})
