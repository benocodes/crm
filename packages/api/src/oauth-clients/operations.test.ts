import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { ApiError } from '../errors.js'
import type { ControlOperation } from '../registry.js'

// [[CORE627]] group 1: the four operations are registered on every composition with the contract's shape, and answer 501 without a runtime.
const NAMES = ['oauth_clients.create', 'oauth_clients.list', 'oauth_clients.get', 'oauth_clients.delete']
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
    ])
    expect(ops.map((o) => o!.scope)).toEqual([
      { resource: 'oauth_clients', action: 'write' },
      { resource: 'oauth_clients', action: 'read' },
      { resource: 'oauth_clients', action: 'read' },
      { resource: 'oauth_clients', action: 'write' },
    ])
    for (const o of ops) expect(o!.proposal).toBeUndefined()
  })

  it('carry the D14 sentences', () => {
    for (const o of ops) expect(o!.description).toMatch(/^Human only \(owners\)/)
    expect(ops[0]!.description).toContain('skip_consent = false is not implemented yet')
    expect(ops[3]!.description).toMatch(/revocation/)
    expect(ops[3]!.description).toMatch(/one hour/)
  })

  it.each(NAMES)('%s answers 501 provider_not_configured when composition hands no runtime', async (name) => {
    const op = registry.get(name) as ControlOperation
    const err = await op.run({} as never, { params: { client_id: 'x' }, body: {}, query: {} } as never).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 501, code: 'provider_not_configured' })
  })
})
