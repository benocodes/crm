import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../rest/app.js'
import { ScopeSet } from '../scopes.js'
import { authMiddleware } from './middleware.js'
import { scopesForRole, type ScopePolicy } from './roles.js'

// [[API518]] group 3 (D3), the paths that need no storage: the API key path (the middleware closes a key's stored grants) and the role path the user authenticators build their principal from
// (`scopesForRole`). The workspace authenticator's token paths are in server-d1's `read-metadata-closure.test.ts`. The seam: `x:read_metadata` is in the declared scopes passed in.
const declared = ['x:read', 'x:read_metadata', 'x:write', 'x:request_approval', 'y:read']
const policy: ScopePolicy = {
  'x:read': { member: true, agentGrantable: true },
  // A member's policy has no row for the metadata scope: a member holds it only through the closure of x:read.
  'x:read_metadata': { member: false, agentGrantable: true },
  'x:write': { member: false, agentGrantable: false },
  'x:request_approval': { member: false, agentGrantable: false },
  'y:read': { member: true, agentGrantable: true },
}

async function keyScopes(stored: string[], declaredScopes: readonly string[] | null = declared) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('storage', {} as never)
    await next()
  })
  app.use(
    '*',
    authMiddleware({
      env: () => ({}) as never,
      ...(declaredScopes ? { declaredScopes } : {}),
      authenticateKey: async () => ({
        actor: { id: 'agent-1', kind: 'agent' },
        organizationId: 'org-1',
        scopes: ScopeSet.parse(stored),
      }),
    }),
  )
  app.get('/', (c) => c.json(c.get('principal').scopes.toStrings()))
  const res = await app.request('/', { headers: { authorization: 'Bearer vbk_not_a_jwt' } })
  expect(res.status).toBe(200)
  return (await res.json()) as string[]
}

describe('the API key path (D3)', () => {
  it('a key holding x:read passes a requirement of x:read_metadata', async () => {
    expect(await keyScopes(['x:read'])).toEqual(['x:read', 'x:read_metadata'])
  })
  it('a key holding x:read_metadata alone fails a requirement of x:read, and implies nothing else', async () => {
    expect(await keyScopes(['x:read_metadata'])).toEqual(['x:read_metadata'])
  })
  it('adds nothing for a resource that does not declare it, and write => request_approval still applies', async () => {
    expect(await keyScopes(['y:read'])).toEqual(['y:read'])
    expect(await keyScopes(['x:write'])).toEqual(['x:request_approval', 'x:write'])
  })
  it('with no declared scopes handed to the middleware nothing is added', async () => {
    expect(await keyScopes(['x:read'], null)).toEqual(['x:read'])
  })
})

describe('the role path of the user authenticators (D3)', () => {
  it('a role holding x:read holds x:read_metadata through the closure, owner and member alike', () => {
    for (const role of ['owner', 'member'] as const) {
      const set = scopesForRole(role, declared, policy)
      expect(set.has({ resource: 'x', action: 'read_metadata' }), role).toBe(true)
    }
  })
  it('a member policy that grants x:read_metadata alone does not grant x:read', () => {
    const only: ScopePolicy = {
      ...policy,
      'x:read': { member: false, agentGrantable: false },
      'x:read_metadata': { member: true, agentGrantable: true },
    }
    const set = scopesForRole('member', declared, only)
    expect(set.has({ resource: 'x', action: 'read_metadata' })).toBe(true)
    expect(set.has({ resource: 'x', action: 'read' })).toBe(false)
  })
  it('a member with x:read and a resource that does not declare it gains nothing', () => {
    expect(scopesForRole('member', declared, policy).toStrings()).toEqual(['x:read', 'x:read_metadata', 'y:read'])
  })
})
