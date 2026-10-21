import { describe, expect, it } from 'vitest'
import { createAuthAdapter, parseOriginList } from './adapter.js'
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
  })

  it('CLERK_API_URL is honoured', async () => {
    const f = fakeClerkFetch(new Map([['user_1', clerkUser({ id: 'user_1', email: 'a@x.test' })]]))
    const env = { ...(await baseEnv()), CLERK_API_URL: 'http://127.0.0.1:9' }
    await createAuthAdapter(env, { fetch: f })!.fetchProfile('user_1')
    expect(f.calls[0]!.url.startsWith('http://127.0.0.1:9/')).toBe(true)
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
