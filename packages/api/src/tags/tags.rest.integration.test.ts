import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// CORE129 over REST on the D1 app: the scopes the tag_id filter declares (D12) and a repeated tag_id (D10).
const FULL = ['tags:read', 'tags:write', 'associations:read', 'associations:write', 'companies:read', 'companies:write']
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVaultRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown, actor: 'user' | 'agent' = 'agent') => {
  const res = await s.call(t, actor, scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}

describe('tags over REST', () => {
  it('create, tag, list by tag_id, untag-by-delete', async () => {
    const tag = (await call(FULL, 'POST', '/api/v1/tags', { name: 'Prospects' })).body
    const co = (await call(FULL, 'POST', '/api/v1/companies', { name: 'Acme' })).body
    await call(FULL, 'POST', '/api/v1/companies', { name: 'Other' })
    expect((await call(FULL, 'POST', '/api/v1/associations', { a_type: 'companies', a_id: co.id, b_type: 'tags', b_id: tag.id })).status).toBe(201)
    const list = await call(FULL, 'GET', `/api/v1/companies?tag_id=${tag.id}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((c: any) => c.id)).toEqual([co.id])
    expect((await call(FULL, 'POST', '/api/v1/tags', { name: 'prospects' })).body.error.code).toBe('tag_exists')
    expect((await call(FULL, 'POST', '/api/v1/tags', { name: 'x', color: 'red' })).body.error.code).toBe('validation_error')
  })

  it('tag_id without tags:read or associations:read is 403 insufficient_scope naming the scope; without tag_id the list works', async () => {
    const tag = (await call(FULL, 'POST', '/api/v1/tags', { name: 'T' })).body
    for (const missing of ['tags:read', 'associations:read']) {
      const res = await call(FULL.filter((x) => x !== missing), 'GET', `/api/v1/companies?tag_id=${tag.id}`)
      expect([res.status, res.body.error.code]).toEqual([403, 'insufficient_scope'])
      expect(res.body.error.message).toContain(missing)
    }
    expect((await call(['companies:read'], 'GET', '/api/v1/companies')).status).toBe(200)
  })

  it('a repeated tag_id is 400 validation_error, never one value silently winning (D10)', async () => {
    const a = (await call(FULL, 'POST', '/api/v1/tags', { name: 'A' })).body
    const b = (await call(FULL, 'POST', '/api/v1/tags', { name: 'B' })).body
    const res = await call(FULL, 'GET', `/api/v1/companies?tag_id=${a.id}&tag_id=${b.id}`)
    expect([res.status, res.body.error.code]).toEqual([400, 'validation_error'])
    expect(res.body.error.message).toContain('tag_id')
    expect((await call(FULL, 'GET', `/api/v1/companies?tag_id=${a.id}`)).status).toBe(200)
  })
})
