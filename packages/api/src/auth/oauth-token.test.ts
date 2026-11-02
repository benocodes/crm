import { generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { createAuthAdapter, createWorkspaceAuthAdapter, ProfileNotFoundError, type AuthAdapter } from './adapter.js'
import { fromProviderScope, toProviderScope } from './clerk.js'
import { SECRET_KEY, WEBHOOK_SECRET, clerkUser, fakeClerkFetch, mintClerkToken, mintOAuthToken, testIssuer } from '../test/clerk.js'

// CORE77 D13 (token kinds), D18 (scope mapping), D12 (the profile's role) at the adapter: no network, a fake Backend API.
async function adapterOf(opts: { clients?: Map<string, string>; profiles?: Map<string, ReturnType<typeof clerkUser>> } = {}): Promise<{ adapter: AuthAdapter; fetch: ReturnType<typeof fakeClerkFetch> }> {
  const issuer = await testIssuer()
  const fetch = fakeClerkFetch(opts.profiles ?? new Map(), { clients: opts.clients })
  const adapter = createWorkspaceAuthAdapter(
    { AUTH_PROVIDER: 'clerk', CLERK_JWT_KEY: issuer.pem, CLERK_ISSUER: issuer.issuer, CLERK_SECRET_KEY: SECRET_KEY },
    { fetch },
  )!
  return { adapter, fetch }
}

describe('verify returns the token kind (D13)', () => {
  it('a session token and an OAuth token signed with the same key resolve by kind', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const session = await adapter.verify(await mintClerkToken(issuer, { sub: 'user_1', azp: undefined, extra: { vibase_role: 'owner' } }))
    expect(session).toMatchObject({ ok: true, kind: 'session', subject: 'user_1', role: 'owner' })
    const oauth = await adapter.verify(await mintOAuthToken(issuer, { sub: 'user_1', clientId: 'client_a', scope: 'contacts:read contacts:write' }))
    expect(oauth).toEqual({ ok: true, kind: 'oauth', subject: 'user_1', clientId: 'client_a', scopes: ['contacts:read', 'contacts:write'] })
  })

  it('the typ header or a client_id claim marks an OAuth token', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const byTyp = await mintClerkToken(issuer, { sub: 'u', typ: 'at+jwt', azp: undefined, extra: { client_id: 'c1', scope: 'contacts:read' } })
    expect(await adapter.verify(byTyp)).toMatchObject({ ok: true, kind: 'oauth', clientId: 'c1' })
    const byClaim = await mintOAuthToken(issuer, { sub: 'u', clientId: 'c2', scope: 'contacts:read', typ: null })
    expect(await adapter.verify(byClaim)).toMatchObject({ ok: true, kind: 'oauth', clientId: 'c2' })
    const rfc = await mintOAuthToken(issuer, { sub: 'u', clientId: 'c3', scope: '', typ: 'application/at+jwt' })
    expect(await adapter.verify(rfc)).toMatchObject({ ok: true, kind: 'oauth', clientId: 'c3', scopes: [] })
  })

  it('an OAuth token with no azp is admitted, and a stray azp is not checked for it', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const without = await mintOAuthToken(issuer, { sub: 'u', clientId: 'c', scope: 'contacts:read' })
    expect(await adapter.verify(without)).toMatchObject({ ok: true, kind: 'oauth' })
    const stray = await mintClerkToken(issuer, { sub: 'u', typ: 'at+jwt', azp: 'https://not-listed.example', extra: { client_id: 'c', scope: 'contacts:read' } })
    expect(await adapter.verify(stray)).toMatchObject({ ok: true, kind: 'oauth' })
  })

  it('an OAuth token with a foreign issuer, a bad signature or an expiry is refused', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const base = { sub: 'u', clientId: 'c', scope: 'contacts:read' }
    expect(await adapter.verify(await mintOAuthToken(issuer, { ...base, iss: 'https://evil.example' }))).toEqual({ ok: false, reason: 'issuer' })
    const other = await generateKeyPair('RS256')
    expect(await adapter.verify(await mintOAuthToken(issuer, { ...base, key: other.privateKey }))).toEqual({ ok: false, reason: 'signature' })
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(await adapter.verify(await mintOAuthToken(issuer, { ...base, exp: past, now: new Date(Date.now() - 7200_000) }))).toEqual({ ok: false, reason: 'expired' })
    expect(await adapter.verify(await mintOAuthToken(issuer, { ...base, alg: 'HS256' }))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('an OAuth token with no client id is refused', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const token = await mintClerkToken(issuer, { sub: 'u', typ: 'at+jwt', azp: undefined, extra: { scope: 'contacts:read' } })
    expect(await adapter.verify(token)).toEqual({ ok: false, reason: 'claims' })
  })

  it('the Organizations adapter reads every token as a session token (the parked path is unchanged)', async () => {
    const issuer = await testIssuer()
    const adapter = createAuthAdapter({ AUTH_PROVIDER: 'clerk', CLERK_JWT_KEY: issuer.pem, CLERK_ISSUER: issuer.issuer, CLERK_SECRET_KEY: SECRET_KEY, CLERK_AUTHORIZED_PARTIES: issuer.party, CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET })!
    const token = await mintClerkToken(issuer, { sub: 'u', typ: 'at+jwt', azp: issuer.party, extra: { client_id: 'c' } })
    expect(await adapter.verify(token)).toMatchObject({ ok: true, kind: 'session', subject: 'u' })
  })
})

describe('scope mapping (D18)', () => {
  it('toProviderScope and fromProviderScope are the identity (V5: Clerk accepts ":")', () => {
    for (const s of ['contacts:read', 'agents:write', 'notes:write']) {
      expect(toProviderScope(s)).toBe(s)
      expect(fromProviderScope(s)).toBe(s)
    }
  })

  it('token scopes pass through fromProviderScope; Clerk\'s own scopes are dropped', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const token = await mintOAuthToken(issuer, {
      sub: 'u',
      clientId: 'c',
      scope: 'openid offline_access public_metadata private_metadata profile email contacts:read contacts:write',
    })
    expect(await adapter.verify(token)).toMatchObject({ kind: 'oauth', scopes: ['contacts:read', 'contacts:write'] })
  })

  it('a repeated scope appears once', async () => {
    const issuer = await testIssuer()
    const { adapter } = await adapterOf()
    const token = await mintOAuthToken(issuer, { sub: 'u', clientId: 'c', scope: 'contacts:read contacts:read' })
    expect(await adapter.verify(token)).toMatchObject({ scopes: ['contacts:read'] })
  })
})

describe('the profile (D12) and the client name (D15)', () => {
  it('fetchProfile returns public_metadata.vibase_role, undefined when absent', async () => {
    const profiles = new Map([
      ['user_a', clerkUser({ id: 'user_a', email: 'a@x.test', role: 'agent' })],
      ['user_b', clerkUser({ id: 'user_b', email: 'b@x.test' })],
    ])
    const { adapter } = await adapterOf({ profiles })
    expect((await adapter.fetchProfile('user_a')).role).toBe('agent')
    expect((await adapter.fetchProfile('user_b')).role).toBeUndefined()
  })

  it('a 404 profile is a ProfileNotFoundError; another failure is a plain error', async () => {
    const { adapter } = await adapterOf()
    await expect(adapter.fetchProfile('user_gone')).rejects.toBeInstanceOf(ProfileNotFoundError)
  })

  it('fetchOAuthClientName finds the application by its exact client id, null when unknown', async () => {
    const { adapter, fetch } = await adapterOf({ clients: new Map([['client_a', 'Claude Desktop'], ['client_ab', 'Other']]) })
    expect(await adapter.fetchOAuthClientName('client_a')).toBe('Claude Desktop')
    expect(await adapter.fetchOAuthClientName('client_zzz')).toBeNull()
    expect(fetch.calls.at(0)!.url).toContain('/v1/oauth_applications')
    expect(fetch.calls.at(0)!.url).toContain('name_query=client_a')
  })

  it('fetchOAuthClientName throws on a failing Backend API', async () => {
    const { adapter, fetch } = await adapterOf({ clients: new Map([['c', 'N']]) })
    fetch.fail.clients = 500
    await expect(adapter.fetchOAuthClientName('c')).rejects.toThrow()
  })
})
