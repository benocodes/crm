import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[CORE133]] D5, D12 over MCP: `contacts_list` takes sort and order, the scope gate answers a tool error naming the scope
// (the same executor as REST), and a caller without the scope never receives a sorted cursor. An API-key agent, no auth provider.

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const BASE = 'https://w.test'
async function agent(scopes: string[]) {
  const b = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'e2e', email: 'e2e@example.com', agentName: 'sorter', scopes })
  const worker = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' })
  let n = 0
  const tool = async (name: string, args: unknown) => {
    const res = await worker.fetch(
      new Request(BASE + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${b.key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      }),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as any).result
  }
  return { tool }
}

describe('contacts_list over MCP', () => {
  it('without interactions:read, sorting by either field is a tool error 403 insufficient_scope naming the scope, with no cursor', async () => {
    const a = await agent(['contacts:read', 'contacts:write'])
    await a.tool('contacts_create', { name: 'Ada' })
    for (const sort of ['last_contacted_at', 'last_interacted_at']) {
      const r = await a.tool('contacts_list', { sort })
      expect(r.isError, sort).toBe(true)
      expect(r.structuredContent.error.code).toBe('insufficient_scope')
      expect(r.structuredContent.error.message).toContain('interactions:read')
      expect(JSON.stringify(r)).not.toContain('next_cursor')
    }
    const plain = await a.tool('contacts_list', { limit: 1 })
    expect(plain.isError).toBeFalsy()
  })

  it('with interactions:read it sorts and pages: order desc, an opaque string cursor, and the cursor is accepted back', async () => {
    const a = await agent(['contacts:read', 'contacts:write', 'interactions:read'])
    for (const name of ['A', 'B', 'C']) await a.tool('contacts_create', { name })
    const first = await a.tool('contacts_list', { sort: 'last_contacted_at', order: 'desc', limit: 2 })
    expect(first.isError).toBeFalsy()
    expect(first.structuredContent.data).toHaveLength(2)
    expect(typeof first.structuredContent.next_cursor).toBe('string')
    expect(first.structuredContent.next_cursor).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    const second = await a.tool('contacts_list', { sort: 'last_contacted_at', order: 'desc', limit: 2, after: first.structuredContent.next_cursor })
    expect(second.isError).toBeFalsy()
    expect(second.structuredContent.data).toHaveLength(1)
    expect(second.structuredContent.next_cursor).toBeNull()
    const mismatched = await a.tool('contacts_list', { sort: 'last_contacted_at', order: 'asc', limit: 2, after: first.structuredContent.next_cursor })
    expect(mismatched.isError).toBe(true)
    expect(mismatched.structuredContent.error.code).toBe('validation_error')
  })
})
