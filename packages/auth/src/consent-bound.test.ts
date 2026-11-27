import { describe, expect, it, vi } from 'vitest'
import { APIError } from 'better-auth/api'

// [[CORE673]] D11 (the hook): the consent accept narrows the accepted vault scopes to accepted ∩ the approving account's bound, for a person too. The session read is stubbed (its own refusals are narrow-approval.test.ts);
// what is proven here is what the hook does with each bound and each accept body.
const session = vi.hoisted(() => ({ subject: 'sub-1' as string | null }))
vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth/api')>()),
  getSessionFromCtx: async () => (session.subject ? { user: { id: session.subject } } : null),
  getAuthoritativeSessionFromCtx: async () => (session.subject ? { user: { id: session.subject } } : null),
}))
const { narrowApproval } = await import('./auth.js')

const REQUEST = 'openid offline_access contacts:read contacts:write webhooks:read audit:read'
const consent = (body: Record<string, unknown>) =>
  ({
    path: '/oauth2/consent',
    method: 'POST',
    body: { accept: true, oauth_query: `client_id=x&scope=${encodeURIComponent(REQUEST)}`, ...body },
    headers: new Headers(),
    context: { adapter: { findOne: async () => null, update: async () => undefined }, options: {} },
  }) as never
const run = async (
  bound: { kind: 'person' | 'agent'; scopes: string[] },
  body: Record<string, unknown>,
): Promise<string | undefined> => {
  const out = await narrowApproval(consent(body), async () => bound)
  return (out?.context.body.scope as string | undefined)?.split(' ').sort().join(' ')
}

const OWNER = { kind: 'person' as const, scopes: ['contacts:read', 'contacts:write', 'webhooks:read', 'audit:read'] }
const MEMBER = { kind: 'person' as const, scopes: ['contacts:read', 'contacts:write'] }
const NONE = { kind: 'person' as const, scopes: [] }
const AGENT = { kind: 'agent' as const, scopes: ['contacts:read'] }

describe('the consent hook narrows to the approving account (matrix: account x accept body)', () => {
  const cases: Array<[string, string, typeof OWNER, string]> = [
    // [body name, body scope, bound, expected]
    ['only in-bound scopes', 'contacts:read', OWNER, 'contacts:read'],
    ['only in-bound scopes', 'contacts:read', MEMBER, 'contacts:read'],
    ['only in-bound scopes', 'contacts:read', NONE, ''],
    ['only in-bound scopes', 'contacts:read', AGENT, 'contacts:read'],
    ['an out-of-role grantable scope', 'contacts:read webhooks:read', OWNER, 'contacts:read webhooks:read'],
    ['an out-of-role grantable scope', 'contacts:read webhooks:read', MEMBER, 'contacts:read'],
    ['an out-of-role grantable scope', 'contacts:read audit:read', MEMBER, 'contacts:read'],
    ['an out-of-role grantable scope', 'contacts:read webhooks:read', NONE, ''],
    ['an out-of-role grantable scope', 'contacts:read webhooks:read', AGENT, 'contacts:read'],
    ['a switched-off scope the role holds is not added', 'contacts:read', MEMBER, 'contacts:read'],
    ['OIDC and offline_access pass', 'openid offline_access webhooks:read', MEMBER, 'offline_access openid'],
    ['OIDC and offline_access pass', 'openid offline_access webhooks:read', NONE, 'offline_access openid'],
    [
      'OIDC and offline_access pass',
      'openid offline_access webhooks:read',
      OWNER,
      'offline_access openid webhooks:read',
    ],
    ['OIDC and offline_access pass', 'openid offline_access webhooks:read', AGENT, 'offline_access openid'],
  ]
  it.each(cases)('%s: %s for %j', async (_n, scope, bound, expected) => {
    expect(await run(bound, { scope })).toBe(expected)
  })

  it('a body with no scope narrows the signed request itself', async () => {
    expect(await run(MEMBER, {})).toBe('contacts:read contacts:write offline_access openid')
    expect(await run(NONE, {})).toBe('offline_access openid')
  })

  it('all_permissions: a person passes it untouched, an agent account has it expanded to its record', async () => {
    expect(await run(MEMBER, { scope: 'openid all_permissions' })).toBe('all_permissions openid')
    expect(await run(AGENT, { scope: 'openid all_permissions' })).toBe('contacts:read openid')
  })

  it('a scope outside the request, in a hand-made body, is narrowed away (never refused) when it is out of the bound', async () => {
    expect(await run(MEMBER, { scope: 'contacts:read tasks:write webhooks:read' })).toBe('contacts:read')
  })

  it('a refused consent (accept false) is left alone', async () => {
    const out = await narrowApproval({ ...(consent({ accept: false }) as object) } as never, async () => MEMBER)
    expect(out).toBeUndefined()
  })

  it('a bound read that throws refuses the accept, for a person and an agent account', async () => {
    for (const _ of [1, 2]) {
      const err = await narrowApproval(consent({ scope: 'contacts:read' }), async () => {
        throw new Error('CRM database unavailable')
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(APIError)
    }
  })

  it('an accept the hook cannot attribute to a signed-in account is refused', async () => {
    session.subject = null
    const err = await narrowApproval(consent({ scope: 'contacts:read' }), async () => MEMBER).catch((e: unknown) => e)
    session.subject = 'sub-1'
    expect(err).toBeInstanceOf(APIError)
  })

  it('a person is never narrowed on the device flow (P2); an agent account is', async () => {
    const device = (userCode: string) =>
      ({
        path: '/device/approve',
        method: 'POST',
        body: { userCode },
        headers: new Headers(),
        context: {
          adapter: {
            findOne: async () => ({
              id: 'd1',
              status: 'pending',
              userId: null,
              scope: 'openid contacts:read webhooks:read',
            }),
            update: vi.fn(async () => undefined),
          },
          options: {},
        },
      }) as never
    const person = device('A')
    await narrowApproval(person, async () => MEMBER)
    expect(
      (person as { context: { adapter: { update: ReturnType<typeof vi.fn> } } }).context.adapter.update,
    ).not.toHaveBeenCalled()
    const agent = device('B')
    await narrowApproval(agent, async () => AGENT)
    expect(
      (agent as { context: { adapter: { update: ReturnType<typeof vi.fn> } } }).context.adapter.update,
    ).toHaveBeenCalled()
  })
})
