import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { useAdminKit } from '../test/admin-kit.js'
import { clerkMembership, clerkWebhook } from '../test/clerk.js'

const k = useAdminKit()
const errorOf = async (res: Response) => (await res.json()).error as { code: string; message: string }

/** Orgs A (owner o, member m, agent G with tasks:read) and B (owner q, agent H). */
async function setup() {
  const a = await k.seedOrg('A')
  const b = await k.seedOrg('B', { owner: 'q', member: 'q2' })
  const g = await k.seedKeyedAgent(a.organizationId, a.ownerId, ['tasks:read'])
  const h = await k.seedKeyedAgent(b.organizationId, b.ownerId, ['tasks:read'])
  return { a, b, g, h }
}
const mint = (org: string, agentId: string, body: Record<string, unknown> = {}, sub = 'o') =>
  k.call('/meta/v1/api-keys', sub, { method: 'POST', org, body: { agent_id: agentId, ...body } })

describe('api keys', () => {
  it('creates a key, once visible, never in events', async () => {
    const { a, g } = await setup()
    const res = await mint(a.organizationId, g.agentId)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key).toMatch(/^vk_/)
    expect(body.prefix).toBe(body.key.slice(0, 11))
    expect('key_hash' in body).toBe(false)
    const ev = (await k.events()).filter((e) => e.type === 'api_key.created')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor_id: a.ownerId, resource_id: body.id })
    const { key, ...record } = body
    expect(ev[0]!.after).toEqual(record)
    const stored = await k.owner.selectFrom('api_keys').select('key_hash').where('id', '=', body.id).executeTakeFirstOrThrow()
    const json = JSON.stringify(ev[0])
    expect(json).not.toContain(key)
    expect(json).not.toContain(stored.key_hash)
    expect((await k.keyCall('/api/v1/tasks', key)).status).toBe(200)
  })

  it('validates expires_at', async () => {
    const { a, g } = await setup()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const ok = await mint(a.organizationId, g.agentId, { expires_at: future })
    expect(ok.status).toBe(201)
    expect((await ok.json()).expires_at).toBe(future)
    const past = await mint(a.organizationId, g.agentId, { expires_at: new Date(Date.now() - 1000).toISOString() })
    expect(past.status).toBe(400)
    expect(await errorOf(past)).toEqual({ code: 'validation_error', message: 'expires_at must be in the future' })
  })

  it("refuses another organisation's agent and an unknown agent", async () => {
    const { a, h } = await setup()
    for (const id of [h.agentId, '0190b2c4-0000-7000-8000-00000000dead']) {
      const res = await mint(a.organizationId, id)
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('invalid_reference')
    }
    expect(await k.owner.selectFrom('api_keys').selectAll().execute()).toHaveLength(2)
    expect((await k.events()).filter((e) => e.type === 'api_key.created')).toHaveLength(0)
  })

  it('gives a disabled agent a key that works once it is enabled', async () => {
    const { a, g } = await setup()
    await k.call(`/meta/v1/agents/${g.agentId}`, 'o', { method: 'PATCH', org: a.organizationId, body: { disabled: true } })
    const res = await mint(a.organizationId, g.agentId)
    expect(res.status).toBe(201)
    const { key } = await res.json()
    expect((await k.keyCall('/api/v1/tasks', key)).status).toBe(401)
    await k.call(`/meta/v1/agents/${g.agentId}`, 'o', { method: 'PATCH', org: a.organizationId, body: { disabled: false } })
    expect((await k.keyCall('/api/v1/tasks', key)).status).toBe(200)
  })

  it('lists and gets without secrets', async () => {
    const { a, g } = await setup()
    await k.seedKeyedAgent(a.organizationId, a.ownerId, ['tasks:read'])
    await mint(a.organizationId, g.agentId)
    await mint(a.organizationId, g.agentId)
    const res = await k.call(`/meta/v1/api-keys?agent_id=${g.agentId}`, 'o', { org: a.organizationId })
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text)
    // G's seeded key plus the two minted; the other agent's key is filtered out
    expect(body.data).toHaveLength(3)
    expect(body.data.every((r: { agent_id: string }) => r.agent_id === g.agentId)).toBe(true)
    expect(text).not.toMatch(/"key"|key_hash/)
    const one = await k.call(`/meta/v1/api-keys/${body.data[0].id}`, 'o', { org: a.organizationId })
    expect(one.status).toBe(200)
    expect(await one.text()).not.toMatch(/"key"|key_hash/)
  })

  it('revokes, idempotently', async () => {
    const { a, g } = await setup()
    const made = await (await mint(a.organizationId, g.agentId)).json()
    const res = await k.call(`/meta/v1/api-keys/${made.id}/revoke`, 'o', { method: 'POST', org: a.organizationId })
    expect(res.status).toBe(200)
    const revoked = await res.json()
    expect(revoked.revoked_at).not.toBeNull()
    const ev = (await k.events()).filter((e) => e.type === 'api_key.revoked')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.before.revoked_at).toBeNull()
    expect((await k.keyCall('/api/v1/tasks', made.key)).status).toBe(401)
    const again = await k.call(`/meta/v1/api-keys/${made.id}/revoke`, 'o', { method: 'POST', org: a.organizationId })
    expect(again.status).toBe(200)
    expect((await again.json()).revoked_at).toBe(revoked.revoked_at)
    expect((await k.events()).filter((e) => e.type === 'api_key.revoked')).toHaveLength(1)
  })

  it("cannot revoke another organisation's key", async () => {
    const { a, b, h } = await setup()
    const theirs = await (await mint(b.organizationId, h.agentId, {}, 'q')).json()
    const res = await k.call(`/meta/v1/api-keys/${theirs.id}/revoke`, 'o', { method: 'POST', org: a.organizationId })
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('not_found')
    const row = await k.owner.selectFrom('api_keys').select('revoked_at').where('id', '=', theirs.id).executeTakeFirstOrThrow()
    expect(row.revoked_at).toBeNull()
  })

  it('refuses members writes but lets them read', async () => {
    const { a, g } = await setup()
    const made = await (await mint(a.organizationId, g.agentId)).json()
    const create = await mint(a.organizationId, g.agentId, {}, 'm')
    expect(create.status).toBe(403)
    expect((await errorOf(create)).code).toBe('insufficient_scope')
    const revoke = await k.call(`/meta/v1/api-keys/${made.id}/revoke`, 'm', { method: 'POST', org: a.organizationId })
    expect(revoke.status).toBe(403)
    expect((await k.call('/meta/v1/api-keys', 'm', { org: a.organizationId })).status).toBe(200)
  })
})

describe('users', () => {
  it('lists the live members with a bare record', async () => {
    const { a } = await setup()
    const res = await k.call('/meta/v1/users', 'o', { org: a.organizationId })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((u: { id: string }) => u.id).sort()).toEqual([a.ownerId, a.memberId].sort())
    for (const u of body.data) expect(Object.keys(u).sort()).toEqual(['created_at', 'email', 'id', 'name', 'updated_at'])
    expect(body.next_cursor).toBeNull()
  })

  it('drops a removed member from the list but still resolves them', async () => {
    const { a } = await setup()
    k.clerk.members.set(a.externalId, k.clerk.members.get(a.externalId)!.filter((m) => m.public_user_data.user_id !== 'm'))
    expect((await k.webhook(clerkWebhook('organizationMembership.deleted', { organization: { id: a.externalId } }))).status).toBe(200)
    const list = await (await k.call('/meta/v1/users', 'o', { org: a.organizationId })).json()
    expect(list.data.map((u: { id: string }) => u.id)).toEqual([a.ownerId])
    expect((await k.call(`/meta/v1/users/${a.memberId}`, 'o', { org: a.organizationId })).status).toBe(200)
  })

  it("does not show another organisation's users", async () => {
    const { a, b } = await setup()
    const res = await k.call(`/meta/v1/users/${b.ownerId}`, 'o', { org: a.organizationId })
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('not_found')
    const list = await (await k.call('/meta/v1/users', 'o', { org: a.organizationId })).json()
    expect(list.data.map((u: { id: string }) => u.id)).not.toContain(b.ownerId)
  })

  it('paginates', async () => {
    const a = await k.seedOrg('A')
    for (const sub of ['p1', 'p2']) {
      k.profile(sub)
      k.clerk.members.get(a.externalId)!.push(clerkMembership({ organizationId: a.externalId, userId: sub, role: 'org:member' }))
    }
    expect((await k.webhook(clerkWebhook('organization.updated', { id: a.externalId }))).status).toBe(200)
    const first = await (await k.call('/meta/v1/users?limit=2', 'o', { org: a.organizationId })).json()
    expect(first.data).toHaveLength(2)
    expect(first.next_cursor).toBe(first.data[1].id)
    const second = await (await k.call(`/meta/v1/users?limit=2&after=${first.next_cursor}`, 'o', { org: a.organizationId })).json()
    expect(second.data).toHaveLength(2)
    expect(second.next_cursor).toBeNull()
    const ids = [...first.data, ...second.data].map((u: { id: string }) => u.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(4)
  })

  it.each(['/meta/v1/users?limit=0', '/meta/v1/users?foo=1'])('rejects the query %s', async (path) => {
    const { a } = await setup()
    const res = await k.call(path, 'o', { org: a.organizationId })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('validation_error')
  })

  it('answers 404 for a non-UUID id', async () => {
    const { a } = await setup()
    expect((await k.call('/meta/v1/users/nope', 'o', { org: a.organizationId })).status).toBe(404)
  })

  it('lets a member read but not an agent', async () => {
    const { a, g } = await setup()
    expect((await k.call('/meta/v1/users', 'm', { org: a.organizationId })).status).toBe(200)
    const res = await k.keyCall('/meta/v1/users', g.key)
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('insufficient_scope')
  })
})

describe('documentation', () => {
  it('lists every administration operation and none of the removed ones', async () => {
    await setup()
    const doc = (await (await k.app.request('/meta/v1/openapi.json')).json()) as any
    const ids = new Set(Object.values<any>(doc.paths).flatMap((p) => Object.values<any>(p).map((o) => o.operationId)))
    for (const name of [
      'memberships.list', 'memberships.get',
      'users.list', 'users.get', 'agents.list', 'agents.get', 'agents.create', 'agents.update',
      'api_keys.list', 'api_keys.get', 'api_keys.create', 'api_keys.revoke',
    ]) {
      expect(ids, name).toContain(name)
      expect(createVaultRegistry().get(name), name).toBeDefined()
    }
    for (const gone of ['invitations.list', 'invitations.create', 'invitations.accept', 'memberships.update', 'memberships.delete', 'organizations.create']) {
      expect(ids, gone).not.toContain(gone)
    }
    expect(doc.paths['/meta/v1/api-keys/{id}/revoke'].post).toBeDefined()
  })
})
