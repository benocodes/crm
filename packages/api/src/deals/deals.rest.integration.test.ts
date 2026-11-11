import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { SCOPE_DESCRIPTIONS, SCOPE_POLICY, isAgentGrantable } from '../auth/roles.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// CORE130 over REST on the D1 app: where the three resources are served (D1), the scopes (D16) and the move-stage route (D10).
const FULL = ['deals:read', 'deals:write', 'pipelines:read', 'pipelines:write']
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
const setup = async () => {
  const p = (await call(FULL, 'POST', '/meta/v1/pipelines', { name: 'Prospecting' })).body
  const open = (await call(FULL, 'POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Researched', kind: 'open', position: 10 })).body
  const won = (await call(FULL, 'POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Won', kind: 'won', position: 90 })).body
  return { p, open, won }
}

describe('surface placement (D1)', () => {
  it('pipelines and pipeline-stages answer on /meta/v1 and are 404 on /api/v1; deals answer on /api/v1 and are 404 on /meta/v1', async () => {
    const { p, open } = await setup()
    expect((await call(FULL, 'GET', '/meta/v1/pipelines')).status).toBe(200)
    expect((await call(FULL, 'GET', `/meta/v1/pipelines/${p.id}`)).status).toBe(200)
    expect((await call(FULL, 'GET', '/meta/v1/pipeline-stages')).status).toBe(200)
    expect((await call(FULL, 'GET', `/meta/v1/pipeline-stages/${open.id}`)).status).toBe(200)
    for (const path of ['/api/v1/pipelines', `/api/v1/pipelines/${p.id}`, '/api/v1/pipeline-stages', `/api/v1/pipeline-stages/${open.id}`, '/meta/v1/deals']) {
      expect((await call(FULL, 'GET', path)).status, path).toBe(404)
    }
    expect((await call(FULL, 'GET', '/api/v1/deals')).status).toBe(200)
    expect((await call(FULL, 'POST', '/api/v1/pipelines', { name: 'X' })).status).toBe(404)
    expect((await call(FULL, 'POST', '/meta/v1/deals', { name: 'X', stage_id: open.id })).status).toBe(404)
  })

  it('each surface\'s OpenAPI document lists its own resources only', async () => {
    const meta = (await (await s.call(t, 'agent', FULL, 'GET', '/meta/v1/openapi.json')).json()) as any
    const api = (await (await s.call(t, 'agent', FULL, 'GET', '/api/v1/openapi.json')).json()) as any
    expect(Object.keys(meta.paths).filter((p) => /pipeline|deals/.test(p)).sort()).toEqual(['/meta/v1/pipeline-stages', '/meta/v1/pipeline-stages/{id}', '/meta/v1/pipelines', '/meta/v1/pipelines/{id}'])
    expect(Object.keys(api.paths).filter((p) => /pipeline|deals/.test(p)).sort()).toEqual(['/api/v1/deals', '/api/v1/deals/aggregate', '/api/v1/deals/{id}', '/api/v1/deals/{id}/move-stage'])
  })
})

describe('deals over REST', () => {
  it('create, list by status, move-stage, get, delete: the status codes and bodies', async () => {
    const { p, open, won } = await setup()
    const created = await call(FULL, 'POST', '/api/v1/deals', { name: 'Acme - pilot', stage_id: open.id, amount_minor: 5000, currency: 'usd' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ pipeline_id: p.id, stage_id: open.id, status: 'open', currency: 'USD', closed_at: null })
    const moved = await call(FULL, 'POST', `/api/v1/deals/${created.body.id}/move-stage`, { stage_id: won.id })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ id: created.body.id, stage_id: won.id, status: 'won' })
    expect(moved.body.closed_at).toEqual(expect.any(String))
    expect((await call(FULL, 'GET', `/api/v1/deals?status=won&pipeline_id=${p.id}`)).body.data.map((d: any) => d.id)).toEqual([created.body.id])
    expect((await call(FULL, 'GET', '/api/v1/deals?status=open')).body.data).toEqual([])
    expect((await call(FULL, 'GET', '/api/v1/deals?status=weird')).body.error.code).toBe('validation_error')
    expect((await call(FULL, 'PATCH', `/api/v1/deals/${created.body.id}`, { stage_id: open.id })).body.error.message).toContain('deals.move_stage')
    expect((await call(FULL, 'DELETE', `/meta/v1/pipeline-stages/${won.id}`)).body.error.code).toBe('stage_in_use')
    expect((await call(FULL, 'DELETE', `/meta/v1/pipelines/${p.id}`)).body.error.code).toBe('pipeline_in_use')
    expect((await call(FULL, 'DELETE', `/api/v1/deals/${created.body.id}`)).status).toBe(204)
    expect((await call(FULL, 'DELETE', `/meta/v1/pipelines/${p.id}`)).status).toBe(204)
  })

  it('move-stage validates its body at the route: no stage_id, a non-UUID, another key and an unknown deal id', async () => {
    const { open } = await setup()
    const d = (await call(FULL, 'POST', '/api/v1/deals', { name: 'D', stage_id: open.id })).body
    for (const body of [{}, { stage_id: 'x' }, { stage_id: open.id, closed_at: '2026-01-01T00:00:00.000Z' }, { stage_id: open.id, pipeline_id: open.pipeline_id }]) {
      const res = await call(FULL, 'POST', `/api/v1/deals/${d.id}/move-stage`, body)
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'validation_error'])
    }
    const missing = await call(FULL, 'POST', '/api/v1/deals/00000000-0000-7000-8000-000000000000/move-stage', { stage_id: open.id })
    expect([missing.status, missing.body.error.code]).toEqual([404, 'not_found'])
    const unknown = await call(FULL, 'POST', `/api/v1/deals/${d.id}/move-stage`, { stage_id: '00000000-0000-7000-8000-000000000000' })
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'invalid_reference'])
  })

  it('the conflict and in-use refusals are 409 with the named codes', async () => {
    const { p, open } = await setup()
    expect((await call(FULL, 'POST', '/meta/v1/pipelines', { name: 'prospecting' })).body.error).toMatchObject({ code: 'pipeline_exists' })
    const dup = await call(FULL, 'POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'RESEARCHED', kind: 'open', position: 1 })
    expect([dup.status, dup.body.error.code]).toEqual([409, 'stage_exists'])
    await call(FULL, 'POST', '/api/v1/deals', { name: 'D', stage_id: open.id })
    const held = await call(FULL, 'DELETE', `/meta/v1/pipeline-stages/${open.id}`)
    expect([held.status, held.body.error.code]).toEqual([409, 'stage_in_use'])
  })
})

describe('deal links over REST (CORE136)', () => {
  it('links a deal to a company, filters by company_id, embeds the edges, and the filter needs contacts:read for contact_id', async () => {
    const { open } = await setup()
    const ALL = [...FULL, 'companies:read', 'companies:write', 'contacts:read', 'associations:read', 'associations:write']
    const d = (await call(ALL, 'POST', '/api/v1/deals', { name: 'D', stage_id: open.id })).body
    await call(ALL, 'POST', '/api/v1/deals', { name: 'Other', stage_id: open.id })
    const co = (await call(ALL, 'POST', '/api/v1/companies', { name: 'Acme' })).body
    expect((await call(ALL, 'POST', '/api/v1/associations', { a_type: 'companies', a_id: co.id, b_type: 'deals', b_id: d.id })).status).toBe(201)
    expect((await call(ALL, 'GET', `/api/v1/deals?company_id=${co.id}`)).body.data.map((x: any) => x.id)).toEqual([d.id])
    expect((await call(ALL, 'GET', `/api/v1/deals/${d.id}?include=associations`)).body.associations).toHaveLength(1)
    const noContacts = ALL.filter((x) => x !== 'contacts:read')
    const denied = await call(noContacts, 'GET', `/api/v1/deals?contact_id=${co.id}`)
    expect([denied.status, denied.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(denied.body.error.message).toContain('contacts:read')
    const noAssoc = await call(ALL.filter((x) => x !== 'associations:read'), 'GET', `/api/v1/deals?company_id=${co.id}`)
    expect([noAssoc.status, noAssoc.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(noAssoc.body.error.message).toContain('associations:read')
    expect((await call(ALL, 'POST', '/api/v1/associations', { a_type: 'deals', a_id: d.id, b_type: 'deals', b_id: d.id })).status).toBe(400)
  })
})

describe('scopes (D16)', () => {
  it('deals:write alone creates and moves a deal, with no pipelines:read; it cannot read deals or pipelines', async () => {
    const { open, won } = await setup()
    const created = await call(['deals:write'], 'POST', '/api/v1/deals', { name: 'D', stage_id: open.id })
    expect(created.status).toBe(201)
    const moved = await call(['deals:write'], 'POST', `/api/v1/deals/${created.body.id}/move-stage`, { stage_id: won.id })
    expect([moved.status, moved.body.stage_id]).toEqual([200, won.id])
    const read = await call(['deals:write'], 'GET', `/api/v1/deals/${created.body.id}`)
    expect([read.status, read.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(read.body.error.message).toContain('deals:read')
    expect((await call(['deals:write'], 'GET', '/meta/v1/pipelines')).status).toBe(403)
  })

  it('pipelines:read gives no deal access, and reads pipelines and stages', async () => {
    const { p, open } = await setup()
    const list = await call(['pipelines:read'], 'GET', '/api/v1/deals')
    expect([list.status, list.body.error.code]).toEqual([403, 'insufficient_scope'])
    expect(list.body.error.message).toContain('deals:read')
    const write = await call(['pipelines:read'], 'POST', '/api/v1/deals', { name: 'D', stage_id: open.id })
    expect([write.status, write.body.error.message.includes('deals:write')]).toEqual([403, true])
    expect((await call(['pipelines:read'], 'GET', '/meta/v1/pipelines')).status).toBe(200)
    expect((await call(['pipelines:read'], 'GET', `/meta/v1/pipeline-stages?pipeline_id=${p.id}`)).body.data).toHaveLength(2)
  })

  it('stage and pipeline writes need pipelines:write; each refusal is a 403 naming the scope', async () => {
    const { p, open } = await setup()
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/meta/v1/pipelines', { name: 'N' }],
      ['PATCH', `/meta/v1/pipelines/${p.id}`, { name: 'N' }],
      ['DELETE', `/meta/v1/pipelines/${p.id}`, undefined],
      ['POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'N', kind: 'open', position: 1 }],
      ['PATCH', `/meta/v1/pipeline-stages/${open.id}`, { name: 'N' }],
      ['DELETE', `/meta/v1/pipeline-stages/${open.id}`, undefined],
    ]
    for (const [method, path, body] of writes) {
      const res = await call(['pipelines:read', 'deals:read', 'deals:write'], method, path, body)
      expect([res.status, res.body.error.code], `${method} ${path}`).toEqual([403, 'insufficient_scope'])
      expect(res.body.error.message).toContain('pipelines:write')
    }
  })

  it('the four scopes are declared, member- and agent-grantable, and described', () => {
    const declared = createVaultRegistry().declaredScopes()
    for (const scope of FULL) {
      expect(declared, scope).toContain(scope)
      expect(SCOPE_POLICY[scope], scope).toEqual({ member: true, agentGrantable: true })
      expect(isAgentGrantable(scope), scope).toBe(true)
      expect(SCOPE_DESCRIPTIONS[scope]!.trim().length, scope).toBeGreaterThan(10)
    }
    expect(SCOPE_DESCRIPTIONS['deals:read']).toBe('View deals (also called opportunities)')
    expect(SCOPE_DESCRIPTIONS['pipelines:write']).toBe('Create, change and delete pipelines and stages')
    // The stages are under `pipelines`: no `pipeline_stages:*` scope exists.
    expect(declared.filter((x) => x.startsWith('pipeline_stages'))).toEqual([])
  })
})
