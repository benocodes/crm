import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openApiKeyKit, type ApiKeyKit } from '../test/api-key-kit.js'
import { SEED_AT } from '../test/insert.js'

// [[CORE573]] D13 and D14: an API key is never issued for a delegated agent (`delegated_by` set), and a key already held for one stops working,
// with exactly the answer a revoked key gets. The refusal is read with the agent on every request, never cached.
let k: ApiKeyKit
beforeAll(async () => {
  k = await openApiKeyKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const KEYS = '/meta/v1/api-keys'
const delegate = (agentId: string, by: string | null) =>
  k.e
    .d1!.prepare('update agents set delegated_by = ?, auth_client_id = ?, auth_provider = ? where id = ?')
    .bind(by, by === null ? null : 'client-x', by === null ? null : 'better-auth', agentId)
    .run()

const mcp = async (key: string) => {
  const res = await k.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  return { status: res.status, text: await res.text() }
}

describe('D13: api_keys.create refuses a delegated agent', () => {
  for (const disabled of [false, true])
    it(`a ${disabled ? 'disabled' : 'live'} delegated agent: 409 delegated_agent, no api_keys row, no control_audit row`, async () => {
      const id = await k.seedAgent()
      await delegate(id, k.e.userId)
      if (disabled) await k.e.update('agents', id, { disabled_at: SEED_AT })
      const before = await k.counts()
      const r = await k.owner('POST', KEYS, { agent_id: id })
      expect([r.status, r.body.error.code]).toEqual([409, 'delegated_agent'])
      expect(r.body.error.message).toContain('OAuth grant')
      expect(await k.counts()).toEqual(before)
      expect(await k.ctl('select * from api_keys')).toEqual([])
    })

  it('a non-delegated agent is still issued a key', async () => {
    const id = await k.seedAgent()
    expect((await k.owner('POST', KEYS, { agent_id: id })).status).toBe(201)
  })
})

describe('D14: a key held for a delegated agent authenticates nowhere', () => {
  it('REST and MCP answer exactly what a revoked key gets; clearing delegated_by restores the key (not cached)', async () => {
    const id = await k.seedAgent()
    await k.e
      .d1!.prepare('update agents set scopes = ? where id = ?')
      .bind(JSON.stringify(['tasks:read']), id)
      .run()
    const live = await k.ctlKey({ agent_id: id })
    const revoked = await k.ctlKey({ agent_id: id, revoked_at: SEED_AT })

    const okRest = await k.keyCall(live.key, '/api/v1/tasks')
    expect(okRest.status).toBe(200)
    const revokedRest = await k.keyCall(revoked.key, '/api/v1/tasks')
    const revokedMcp = await mcp(revoked.key)
    expect(revokedRest.status).toBe(401)

    await delegate(id, k.e.userId)
    const rest = await k.keyCall(live.key, '/api/v1/tasks')
    expect(rest.status).toBe(revokedRest.status)
    expect(rest.text).toBe(revokedRest.text)
    expect(await mcp(live.key)).toEqual(revokedMcp)
    // the key row is untouched
    expect((await k.ctl('select revoked_at from api_keys where id = ?', live.id))[0]!.revoked_at).toBeNull()

    await delegate(id, null)
    expect((await k.keyCall(live.key, '/api/v1/tasks')).status).toBe(200)
  })
})
