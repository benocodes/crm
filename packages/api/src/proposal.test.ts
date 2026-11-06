import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SCOPE_DESCRIPTIONS, SCOPE_POLICY, grantableScopes } from './auth/roles.js'
import { deriveTools } from './mcp/tools.js'
import { createVaultRegistry } from './operations.js'
import { proposableOperations, proposalMeta } from './proposal.js'
import { Registry, type TenantOperation } from './registry.js'
import { createApp } from './rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from './test/user-auth.js'
import { coldStorage } from './test/storage.js'

// [[AGT8]] D2, D30, D32, D40: the proposal manifest and discovery.
const registry = createVaultRegistry()
const ELIGIBLE = [
  'associations.create', 'associations.delete',
  'companies.create', 'companies.delete', 'companies.update',
  'contacts.create', 'contacts.delete', 'contacts.merge', 'contacts.update',
  'deals.create', 'deals.delete', 'deals.move_stage', 'deals.update',
  'identities.create', 'identities.delete', 'identities.resolve', 'identities.update',
  'notes.create', 'notes.delete', 'notes.update',
  'pipeline_stages.create', 'pipeline_stages.delete', 'pipeline_stages.update',
  'pipelines.create', 'pipelines.delete', 'pipelines.update',
  'tags.create', 'tags.delete', 'tags.update',
  'tasks.create', 'tasks.delete', 'tasks.update',
]

describe('the manifest (D32)', () => {
  it('pins the eligible list: a newly eligible operation is a reviewed change', () => {
    expect(proposableOperations(registry).map((o) => o.name).sort()).toEqual(ELIGIBLE)
  })

  it('every tenant operation has metadata: eligible with its request scope, or ineligible with a reason', () => {
    for (const op of registry.operations()) {
      const meta = proposalMeta(op)
      if (meta.eligible) expect(meta.request_scope, op.name).toBe(`${(op as TenantOperation).scope!.resource}:request_approval`)
      else expect(meta.reason?.length, op.name).toBeGreaterThan(3)
    }
  })

  it('a tenant operation that changes data cannot be registered without it (load-time check)', () => {
    const probe = { kind: 'tenant', surface: 'api', name: 'probe.change', summary: 's', method: 'post', path: '/probe', scope: { resource: 'probe', action: 'write' }, response: { status: 204 }, prepare: () => { throw new Error('unused') } } as unknown as TenantOperation
    expect(() => new Registry().register(probe)).toThrow('proposal metadata')
    expect(() => new Registry().register({ ...probe, proposal: { eligible: false, reason: 'because' } })).not.toThrow()
    expect(() => new Registry().register({ ...probe, method: 'get', response: { status: 200, schema: z.object({}) } })).not.toThrow()
    // A proposable operation runs inline and needs a write scope.
    expect(() => new Registry().register({ ...probe, proposal: { eligible: true }, scope: { resource: 'probe', action: 'read' } })).toThrow('write scope')
  })

  it('ineligible operations name their reason: reads, connections, agents, keys, the queue itself', () => {
    const reason = (name: string) => proposalMeta(registry.get(name)!).reason
    expect(reason('tasks.list')).toMatch(/read-only/)
    expect(reason('connections.authorize')).toMatch(/consent screen/)
    expect(reason('connections.delete')).toMatch(/not proposable/)
    expect(reason('agents.create')).toMatch(/administration/)
    expect(reason('api_keys.revoke')).toMatch(/administration|credentials/)
    expect(reason('contact_files.create')).toMatch(/file links/)
    expect(reason('action_requests.approve')).toMatch(/never proposed/)
    expect(proposalMeta(registry.get('me.get')!).eligible).toBe(false)
  })
})

describe('scopes (D30)', () => {
  it('request_approval is declared for exactly the resources with an eligible operation, and action_requests:read beside the others', () => {
    const declared = registry.declaredScopes()
    const resources = [...new Set(proposableOperations(registry).map((o) => o.scope!.resource))].sort()
    expect(declared.filter((s) => s.endsWith(':request_approval'))).toEqual(resources.map((r) => `${r}:request_approval`))
    expect(declared).toContain('action_requests:read')
    expect(declared).not.toContain('action_requests:write')
    expect(declared.filter((s) => s.startsWith('agents:') || s.startsWith('connections:'))).not.toContain('agents:request_approval')
  })

  it('policy, descriptions and default grantable scopes agree: each request_approval row copies its write row, with the consent sentence', () => {
    const declared = registry.declaredScopes()
    expect(Object.keys(SCOPE_POLICY).sort()).toEqual(declared)
    expect(Object.keys(SCOPE_DESCRIPTIONS).sort()).toEqual(declared)
    for (const scope of declared.filter((s) => s.endsWith(':request_approval'))) {
      const resource = scope.split(':')[0]!
      expect(SCOPE_POLICY[scope], scope).toEqual(SCOPE_POLICY[`${resource}:write`])
      expect(SCOPE_DESCRIPTIONS[scope]).toBe(`Propose changes to ${resource} for review`)
      expect(grantableScopes(declared)).toContain(scope)
    }
    expect(SCOPE_POLICY['action_requests:read']).toEqual({ member: true, agentGrantable: true })
  })
})

describe('discovery (D40): OpenAPI, the tool list and the manifest carry the same names', () => {
  it('every tenant operation in OpenAPI carries x-vault-proposal, and the operation enum lists the eligible names', async () => {
    const app = createApp({ storage: coldStorage(), registry })
    for (const surface of ['api', 'meta']) {
      const doc = (await (await app.request(`/${surface}/v1/openapi.json`)).json()) as any
      for (const [path, item] of Object.entries<any>(doc.paths)) {
        for (const method of ['get', 'post', 'patch', 'delete']) {
          const op = item[method]
          if (!op) continue
          const real = registry.get(op.operationId)!
          expect(op['x-vault-proposal'], `${method} ${path}`).toEqual(real.kind === 'tenant' ? proposalMeta(real) : undefined)
        }
      }
    }
    const api = (await (await app.request('/api/v1/openapi.json')).json()) as any
    const enumOf = (schema: any): string[] => schema.properties.operation.enum
    const body = api.paths['/api/v1/action-requests'].post.requestBody.content['application/json'].schema
    expect([...enumOf(body)].sort()).toEqual(ELIGIBLE)
  })

  it('the MCP create tool has the same enum and each eligible tool says how to propose it', () => {
    const tools = deriveTools(registry)
    const create = tools.find((t) => t.tool.name === 'action_requests_create')!
    expect(([...(create.tool.inputSchema as any).properties.operation.enum] as string[]).sort()).toEqual(ELIGIBLE)
    expect(create.tool.description).toContain('request_approval')
    for (const name of ELIGIBLE) {
      const t = tools.find((e) => e.op.name === name)!
      expect(t.tool.description, name).toContain(`Proposable: ${(t.op as TenantOperation).scope!.resource}:request_approval`)
      expect(t.tool.description, name).toContain(`operation=${name}`)
    }
    expect(tools.find((t) => t.op.name === 'tasks.list')!.tool.description).not.toContain('Proposable')
    expect(tools.find((t) => t.op.name === 'associations.create')!.tool.description).toContain('read on the endpoint type')
  })
})

describe('Postgres (D26)', () => {
  it('the new operations answer 501 not_implemented on a binding that is not D1, before any unit runs', async () => {
    const app = createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() })
    const token = mintTestUserToken({ userId: '0190b2c4-0000-7000-8000-000000000001', organizationId: '0190b2c4-0000-7000-8000-0000000000a1', scopes: registry.declaredScopes(), kind: 'user' })
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    for (const [method, path, body] of [
      ['POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: 'x' }, reason: 'r' }],
      ['GET', '/api/v1/action-requests', undefined],
      ['GET', '/api/v1/action-requests/0190b2c4-0000-7000-8000-0000000000b1', undefined],
      ['POST', '/api/v1/action-requests/0190b2c4-0000-7000-8000-0000000000b1/approve', {}],
      ['POST', '/api/v1/action-requests/0190b2c4-0000-7000-8000-0000000000b1/reject', {}],
      ['POST', '/api/v1/action-requests/0190b2c4-0000-7000-8000-0000000000b1/withdraw', undefined],
    ] as const) {
      const res = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      expect([res.status, ((await res.json()) as any).error.code], `${method} ${path}`).toEqual([501, 'not_implemented'])
    }
  })
})
