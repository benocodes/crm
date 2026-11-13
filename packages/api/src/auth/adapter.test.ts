import { describe, expect, it } from 'vitest'
import { createAuthAdapter, createWorkspaceAuthAdapter, parseOriginList } from './adapter.js'
import { WEBHOOK_SECRET, clerkUser, fakeClerkFetch, mintClerkToken, testIssuer } from '../test/clerk.js'

const baseEnv = async () => {
  const issuer = await testIssuer()
  return {
    AUTH_PROVIDER: 'clerk',
    CLERK_JWT_KEY: issuer.pem,
    CLERK_ISSUER: issuer.issuer,
    CLERK_AUTHORIZED_PARTIES: issuer.party,
    CLERK_SECRET_KEY: 'sk_test_fake',
    CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as Record<string, string | undefined>
}

describe('createAuthAdapter', () => {
  it('unset provider', () => {
    expect(createAuthAdapter({})).toBeUndefined()
    expect(createAuthAdapter({ AUTH_PROVIDER: '' })).toBeUndefined()
  })

  it('clerk configured', async () => {
    const adapter = createAuthAdapter(await baseEnv())!
    expect(adapter.provider).toBe('clerk')
    const token = await mintClerkToken(await testIssuer(), { sub: 'user_9' })
    expect(await adapter.verify(token)).toMatchObject({ ok: true, subject: 'user_9', organization: null })
  })

  it.each(['CLERK_JWT_KEY', 'CLERK_ISSUER', 'CLERK_SECRET_KEY', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_WEBHOOK_SECRET'])('missing %s', async (name) => {
    const env = await baseEnv()
    delete env[name]
    expect(() => createAuthAdapter(env)).toThrow(`AUTH_PROVIDER=clerk requires ${name}`)
  })

  it('empty parties', async () => {
    const env = { ...(await baseEnv()), CLERK_AUTHORIZED_PARTIES: ' , ' }
    expect(() => createAuthAdapter(env)).toThrow('AUTH_PROVIDER=clerk requires CLERK_AUTHORIZED_PARTIES')
  })

  it('malformed webhook secret', async () => {
    const env = { ...(await baseEnv()), CLERK_WEBHOOK_SECRET: 'secret' }
    expect(() => createAuthAdapter(env)).toThrow('CLERK_WEBHOOK_SECRET must be a whsec_ secret')
  })

  it('unknown provider', () => {
    expect(() => createAuthAdapter({ AUTH_PROVIDER: 'auth0' })).toThrow('unknown AUTH_PROVIDER "auth0"')
    // [[CORE243]] D1: the built-in provider is known (no token adapter yet), so it is not a configuration error.
    expect(createWorkspaceAuthAdapter({ AUTH_PROVIDER: 'better-auth' })).toBeUndefined()
  })

  it('CLERK_API_URL is honoured', async () => {
    const f = fakeClerkFetch(new Map([['user_1', clerkUser({ id: 'user_1', email: 'a@x.test' })]]))
    const env = { ...(await baseEnv()), CLERK_API_URL: 'http://127.0.0.1:9' }
    await createAuthAdapter(env, { fetch: f })!.fetchProfile('user_1')
    expect(f.calls[0]!.url.startsWith('http://127.0.0.1:9/')).toBe(true)
  })
})

describe('createWorkspaceAuthAdapter ([[CORE64]] D24, D8)', () => {
  it('does not need CLERK_WEBHOOK_SECRET, and ignores one that is set', async () => {
    const env = await baseEnv()
    delete env.CLERK_WEBHOOK_SECRET
    expect(createWorkspaceAuthAdapter(env)!.provider).toBe('clerk')
    expect(() => createWorkspaceAuthAdapter({ ...env, CLERK_WEBHOOK_SECRET: 'not-a-secret' })).not.toThrow()
  })

  it('the Organizations adapter still requires the webhook secret', async () => {
    const env = await baseEnv()
    delete env.CLERK_WEBHOOK_SECRET
    expect(() => createAuthAdapter(env)).toThrow('AUTH_PROVIDER=clerk requires CLERK_WEBHOOK_SECRET')
  })

  it('CLERK_AUTHORIZED_PARTIES is optional for the workspace adapter and required for the Organizations one', async () => {
    const env = await baseEnv()
    delete env.CLERK_AUTHORIZED_PARTIES
    expect(createWorkspaceAuthAdapter(env)).toBeDefined()
    expect(() => createAuthAdapter(env)).toThrow('AUTH_PROVIDER=clerk requires CLERK_AUTHORIZED_PARTIES')
    expect(() => createAuthAdapter({ ...env, CLERK_AUTHORIZED_PARTIES: ' , ' })).toThrow('AUTH_PROVIDER=clerk requires CLERK_AUTHORIZED_PARTIES')
  })

  it('unset provider is undefined', () => {
    expect(createWorkspaceAuthAdapter({})).toBeUndefined()
  })

  it('reads vibase_role by default and AUTH_ROLE_CLAIM when set', async () => {
    const issuer = await testIssuer()
    const env = await baseEnv()
    const token = await mintClerkToken(issuer, { extra: { vibase_role: 'owner', acme_role: 'member' } })
    expect(await createWorkspaceAuthAdapter(env)!.verify(token)).toMatchObject({ ok: true, role: 'owner' })
    expect(await createWorkspaceAuthAdapter({ ...env, AUTH_ROLE_CLAIM: ' acme_role ' })!.verify(token)).toMatchObject({ ok: true, role: 'member' })
    expect(await createWorkspaceAuthAdapter({ ...env, AUTH_ROLE_CLAIM: 'absent' })!.verify(token)).toMatchObject({ ok: true, role: undefined })
  })

  it.each(['', '   '])('AUTH_ROLE_CLAIM %j fails closed', async (value) => {
    const env = { ...(await baseEnv()), AUTH_ROLE_CLAIM: value }
    expect(() => createWorkspaceAuthAdapter(env)).toThrow('AUTH_ROLE_CLAIM must not be empty')
  })

  it('every webhook is refused: there is no secret', async () => {
    const env = await baseEnv()
    delete env.CLERK_WEBHOOK_SECRET
    const adapter = createWorkspaceAuthAdapter(env)!
    const now = Math.floor(Date.now() / 1000)
    const result = await adapter.parseWebhook({ headers: new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': String(now), 'svix-signature': 'v1,AAAA' }), body: '{}' })
    expect(result).toEqual({ ok: false, reason: 'signature' })
  })
})

describe('parseOriginList', () => {
  it('trims, drops empties and trailing slashes', () => {
    expect(parseOriginList(' https://a.test/ ,https://b.test:8443,, ', 'X')).toEqual(['https://a.test', 'https://b.test:8443'])
  })
  it('refuses an origin with a path', () => {
    expect(() => parseOriginList('https://a.test/pane', 'X')).toThrow('X: "https://a.test/pane" is not an origin')
  })
  it('accepts an extension origin', () => {
    const o = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    expect(parseOriginList(o, 'X')).toEqual([o])
  })
  it.each(['null', 'chrome-extension://short', 'chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', 'ftp://a.test'])(
    'refuses %s',
    (entry) => {
      expect(() => parseOriginList(entry, 'X')).toThrow(`X: "${entry}" is not an origin`)
    },
  )
  it('empty list', () => {
    expect(parseOriginList(undefined, 'X')).toEqual([])
    expect(parseOriginList('', 'X')).toEqual([])
  })
})
