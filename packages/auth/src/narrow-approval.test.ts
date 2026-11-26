import { describe, expect, it } from 'vitest'
import { APIError } from 'better-auth/api'
import { narrowAgentApproval } from './auth.js'

// [[CORE662]] review finding 2 ([[CORE630]] D11, 630.72): the narrowing hook must never let an approval through unnarrowed because ITS read of the session yielded nothing while the library's own read could succeed.
const grant = async () => ['contacts:read'] as const
const ctx = (path: string, body: Record<string, unknown>) =>
  ({
    path,
    method: 'POST',
    body,
    headers: new Headers(),
    context: { adapter: { findOne: async () => null, update: async () => undefined }, options: {} },
  }) as never

describe('the narrowing hook with no readable session', () => {
  it.each([
    ['a device approval', `/${'device'}/approve`, { userCode: 'ABCD2345' }],
    ['an accepting consent', '/oauth2/consent', { accept: true, oauth_query: 'client_id=x&scope=openid' }],
  ])('%s is refused, never passed on unnarrowed', async (_n, path, body) => {
    const err = await narrowAgentApproval(ctx(path, body), grant).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(APIError)
  })

  it('a claim read with no session is left alone (the page is not signed in yet)', async () => {
    const c = { ...(ctx(`/${'device'}`, {}) as object), method: 'GET', query: { user_code: 'ABCD2345' } } as never
    await expect(narrowAgentApproval(c, grant)).resolves.toBeUndefined()
  })
})
