import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { ApiError } from '../errors.js'
import { createApp } from '../rest/app.js'
import { coldStorage } from '../test/storage.js'
import type { ControlOperation } from '../registry.js'

// [[CORE627]] group 1: the five operations are registered on every composition with the contract's shape, and answer 501 without a runtime.
const NAMES = [
  'oauth_clients.create',
  'oauth_clients.list',
  'oauth_clients.get',
  'oauth_clients.delete',
  'oauth_clients.update',
]
const registry = createVibaseRegistry()
const ops = NAMES.map((n) => registry.get(n) as ControlOperation | undefined)

describe('oauth_clients operations', () => {
  it('are control operations on the meta surface, tagged oauth_clients, not proposable, at the stated paths and statuses', () => {
    const shape = ops.map((o) => o && [o.name, o.kind, o.surface, o.tags, o.method, o.path, o.response.status])
    expect(shape).toEqual([
      ['oauth_clients.create', 'control', 'meta', ['oauth_clients'], 'post', '/oauth-clients', 201],
      ['oauth_clients.list', 'control', 'meta', ['oauth_clients'], 'get', '/oauth-clients', 200],
      ['oauth_clients.get', 'control', 'meta', ['oauth_clients'], 'get', '/oauth-clients/{client_id}', 200],
      ['oauth_clients.delete', 'control', 'meta', ['oauth_clients'], 'delete', '/oauth-clients/{client_id}', 204],
      ['oauth_clients.update', 'control', 'meta', ['oauth_clients'], 'patch', '/oauth-clients/{client_id}', 200],
    ])
    expect(ops.map((o) => o!.scope)).toEqual([
      { resource: 'oauth_clients', action: 'write' },
      { resource: 'oauth_clients', action: 'read' },
      { resource: 'oauth_clients', action: 'read' },
      { resource: 'oauth_clients', action: 'write' },
      { resource: 'oauth_clients', action: 'write' },
    ])
    for (const o of ops) expect('proposal' in o!).toBe(false)
  })

  it('carry the D14 sentences', () => {
    for (const o of ops) expect(o!.description).toMatch(/^Human only \(owners\)/)
    expect(ops[0]!.description).toContain('skip_consent = false is not implemented yet')
    expect(ops[3]!.description).toMatch(/revocation/)
    expect(ops[3]!.description).toMatch(/one hour/)
    // [[CORE628]] D14
    expect(ops[4]!.description).toContain('skip_consent = false is not implemented yet')
    expect(ops[4]!.description).toMatch(/replace/)
    expect(ops[4]!.description).toMatch(/revokes no token/)
    expect(ops[4]!.description).toContain('CORS_ALLOWED_ORIGINS')
    expect(ops[0]!.description).toContain('CORS_ALLOWED_ORIGINS')
  })

  it.each(NAMES)('%s answers 501 provider_not_configured when composition hands no runtime', async (name) => {
    const op = registry.get(name) as ControlOperation
    const err = await op.run({} as never, { params: { client_id: 'x' }, body: {}, query: {} } as never).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 501, code: 'provider_not_configured' })
  })

  it('the meta OpenAPI document carries the five operations (paths, statuses, tag, descriptions) and the CRM document none of them', async () => {
    const app = createApp({ storage: coldStorage() })
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const crm = (await (await app.request('/api/v1/openapi.json')).json()) as any
    const list = meta.paths['/meta/v1/oauth-clients']
    const one = meta.paths['/meta/v1/oauth-clients/{client_id}']
    expect(Object.keys(list).sort()).toEqual(['get', 'post'])
    expect(Object.keys(one).sort()).toEqual(['delete', 'get', 'patch'])
    expect(list.post.operationId).toBe('oauth_clients.create')
    expect(Object.keys(list.post.responses)).toContain('201')
    expect(Object.keys(list.get.responses)).toContain('200')
    expect(Object.keys(one.get.responses)).toContain('200')
    expect(Object.keys(one.delete.responses)).toContain('204')
    expect(one.patch.operationId).toBe('oauth_clients.update')
    expect(Object.keys(one.patch.responses)).toContain('200')
    expect(one.patch.description).toContain('skip_consent = false is not implemented yet')
    for (const o of [list.post, list.get, one.get, one.delete, one.patch]) expect(o.tags).toEqual(['oauth_clients'])
    expect(list.post.description).toContain('skip_consent = false is not implemented yet')
    expect(one.delete.description).toMatch(/at most one hour/)
    expect(JSON.stringify(crm)).not.toContain('oauth-clients')
  })
})
