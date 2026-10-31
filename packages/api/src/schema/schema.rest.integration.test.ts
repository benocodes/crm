import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'
import { schemaDocument } from './document.js'

// API63 through the real router on D1: scope, the response schema, a caller-independent document, the two OpenAPI documents.
const registry = createVaultRegistry()
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(registry)
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], path: string, actor: 'user' | 'agent' = 'agent') => {
  const res = await s.call(t, actor, scopes, 'GET', path)
  return { status: res.status, body: (await res.json()) as any }
}

describe('GET /meta/v1/schema', () => {
  it('200 with schema:read, and the body parses with the response schema', async () => {
    const r = await call(['schema:read'], '/meta/v1/schema')
    expect(r.status).toBe(200)
    const doc = schemaDocument.parse(r.body)
    expect(doc.engine).toBe('d1')
    expect(doc.tables.map((x) => x.name)).toEqual(expect.arrayContaining(['notes', 'associations', 'events', 'principals']))
    expect(Object.keys(r.body)).toEqual(['engine', 'kinds', 'tables', 'associations'])
  })
  it('associations.associable equals the definitions flagged associable, sorted, and includes notes', async () => {
    const r = await call(['schema:read'], '/meta/v1/schema')
    const flagged = registry
      .resources()
      .filter((d) => d.associable)
      .map((d) => d.table)
      .sort()
    expect(r.body.associations.associable).toEqual(flagged)
    expect(r.body.associations.associable).toEqual(expect.arrayContaining(['notes', 'tasks', 'contacts']))
  })
  it('403 insufficient_scope without schema:read, even with every other read scope', async () => {
    const r = await call(['tasks:read', 'contacts:read', 'notes:read', 'agents:read'], '/meta/v1/schema')
    expect([r.status, r.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(r.body.error.message).toContain('schema:read')
  })
  it('is the same document for every caller', async () => {
    const narrow = await call(['schema:read'], '/meta/v1/schema')
    const wide = await call(['schema:read', 'tasks:read', 'tasks:write', 'contacts:read', 'agents:read'], '/meta/v1/schema', 'user')
    expect(narrow.status).toBe(200)
    expect(wide.body).toEqual(narrow.body)
  })
  it('is not served under /api/v1', async () => {
    expect((await call(['schema:read'], '/api/v1/schema')).status).toBe(404)
  })
})

describe('OpenAPI documents (D8)', () => {
  it('the meta document lists /meta/v1/schema with the schema.get operation; the records document does not', async () => {
    const meta = (await (await s.app.request('/meta/v1/openapi.json')).json()) as any
    const api = (await (await s.app.request('/api/v1/openapi.json')).json()) as any
    expect(meta.paths['/meta/v1/schema'].get.operationId).toBe('schema.get')
    expect(api.paths['/meta/v1/schema']).toBeUndefined()
    expect(api.paths['/api/v1/schema']).toBeUndefined()
    expect(meta.paths['/meta/v1/schema'].get.responses['200']).toBeDefined()
  })
})
