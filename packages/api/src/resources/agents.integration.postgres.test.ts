import { describe, expect, it } from 'vitest'
import { useAdminKit } from '../test/admin-kit.js'

const k = useAdminKit()
const O = (org: string, path: string, init: { method?: string; body?: unknown } = {}) => k.call(path, 'o', { ...init, org })
const count = async (table: 'principals' | 'agents') =>
  Number((await k.owner.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)
const errorOf = async (res: Response) => (await res.json()).error as { code: string; message: string }

describe('agents', () => {
  it('creates an agent with a principal, normalised scopes and an event', async () => {
    const t = await k.seedOrg()
    const res = await O(t.organizationId, '/meta/v1/agents', { method: 'POST', body: { name: 'Bot', scopes: ['tasks:write', 'tasks:read', 'tasks:read'] } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ name: 'Bot', scopes: ['tasks:read', 'tasks:write'], disabled_at: null, created_by: t.ownerId })
    const p = await k.owner.selectFrom('principals').select('kind').where('id', '=', body.id).executeTakeFirstOrThrow()
    expect(p.kind).toBe('agent')
    const ev = (await k.events()).filter((e) => e.type === 'agent.created')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor_id: t.ownerId, resource_id: body.id })
  })

  it('defaults to no scopes', async () => {
    const t = await k.seedOrg()
    const res = await O(t.organizationId, '/meta/v1/agents', { method: 'POST', body: { name: 'Bare' } })
    expect(res.status).toBe(201)
    expect((await res.json()).scopes).toEqual([])
  })

  it('refuses an unknown scope and writes nothing', async () => {
    const t = await k.seedOrg()
    const [p, a, e] = [await count('principals'), await count('agents'), (await k.events()).length]
    const res = await O(t.organizationId, '/meta/v1/agents', { method: 'POST', body: { name: 'X', scopes: ['nope:read'] } })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toEqual({ code: 'unknown_scope', message: 'unknown scope: nope:read' })
    expect([await count('principals'), await count('agents'), (await k.events()).length]).toEqual([p, a, e])
  })

  it.each(['members:read', 'agents:read', 'agents:write'])('refuses the human-only scope %s', async (scope) => {
    const t = await k.seedOrg()
    const [p, a] = [await count('principals'), await count('agents')]
    const res = await O(t.organizationId, '/meta/v1/agents', { method: 'POST', body: { name: 'X', scopes: [scope] } })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('scope_not_grantable')
    expect([await count('principals'), await count('agents')]).toEqual([p, a])
  })

  async function agentOf(t: { organizationId: string }, scopes = ['tasks:read']) {
    return (await (await O(t.organizationId, '/meta/v1/agents', { method: 'POST', body: { name: 'Bot', scopes } })).json()) as { id: string }
  }
  async function keyOf(org: string, agentId: string) {
    const res = await O(org, '/meta/v1/api-keys', { method: 'POST', body: { agent_id: agentId } })
    expect(res.status).toBe(201)
    return (await res.json()).key as string
  }

  it('updates scopes', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    const res = await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { scopes: ['contacts:read'] } })
    expect(res.status).toBe(200)
    const ev = (await k.events()).filter((e) => e.type === 'agent.updated')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.before.scopes).toEqual(['tasks:read'])
    expect(ev[0]!.after.scopes).toEqual(['contacts:read'])
  })

  it('refuses a human-only scope on update', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    const res = await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { scopes: ['agents:write'] } })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('scope_not_grantable')
    const row = await k.owner.selectFrom('agents').select('scopes').where('id', '=', ag.id).executeTakeFirstOrThrow()
    expect(row.scopes).toEqual(['tasks:read'])
  })

  it('applies a scope change at once', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    const key = await keyOf(t.organizationId, ag.id)
    expect((await k.keyCall('/api/v1/tasks', key)).status).toBe(200)
    await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { scopes: [] } })
    const res = await k.keyCall('/api/v1/tasks', key)
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('insufficient_scope')
  })

  it('disables and enables', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    const key = await keyOf(t.organizationId, ag.id)
    const off = await (await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { disabled: true } })).json()
    expect(off.disabled_at).not.toBeNull()
    const denied = await k.keyCall('/api/v1/tasks', key)
    expect(denied.status).toBe(401)
    expect((await errorOf(denied)).code).toBe('unauthenticated')
    const on = await (await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { disabled: false } })).json()
    expect(on.disabled_at).toBeNull()
    expect((await k.keyCall('/api/v1/tasks', key)).status).toBe(200)
  })

  it('keeps the first timestamp when disabled twice', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    const first = await (await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { disabled: true } })).json()
    const second = await (await O(t.organizationId, `/meta/v1/agents/${ag.id}`, { method: 'PATCH', body: { disabled: true } })).json()
    expect(second.disabled_at).toBe(first.disabled_at)
  })

  it('members read but cannot write', async () => {
    const t = await k.seedOrg()
    const ag = await agentOf(t)
    expect((await k.call('/meta/v1/agents', 'm', { org: t.organizationId })).status).toBe(200)
    for (const [path, method, body] of [['/meta/v1/agents', 'POST', { name: 'X' }], [`/meta/v1/agents/${ag.id}`, 'PATCH', { name: 'Y' }]] as const) {
      const res = await k.call(path, 'm', { method, org: t.organizationId, body })
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toEqual({ code: 'insufficient_scope', message: 'requires agents:write' })
    }
  })

  it('agents cannot administer', async () => {
    const t = await k.seedOrg()
    const bot = await k.seedKeyedAgent(t.organizationId, t.ownerId, ['tasks:read', 'tasks:write'])
    const res = await k.keyCall('/meta/v1/agents', bot.key)
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('insufficient_scope')
  })
})
