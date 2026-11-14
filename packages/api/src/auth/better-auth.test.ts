import { generateKeyPair } from 'jose'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBetterAuthAdapter, type BetterAuthKey } from './better-auth.js'
import { BA_BASE, BA_ISSUER, baIssuer, mintBaToken, type BaIssuer, type BaMint } from '../test/better-auth.js'
import { mintClerkToken, testIssuer } from '../test/clerk.js'

// [[CORE244]] D8, D23, P1 at the adapter: Better Auth-shaped JWTs against the keys of `auth_jwks`, no network, no database.
let issuer: BaIssuer
let table: BetterAuthKey[]
let reads: number
let nowMs: number
const T0 = new Date('2026-11-14T10:00:00.000Z').getTime()
const adapter = (over: { cli?: string } = {}) =>
  createBetterAuthAdapter({
    issuer: BA_ISSUER,
    audience: BA_BASE,
    readKeys: async () => {
      reads++
      return table
    },
    readProfile: async () => null,
    readClientName: async () => null,
    now: () => new Date(nowMs),
    ...over,
  })
const mint = (o: BaMint = {}) => mintBaToken(issuer, { now: new Date(nowMs), ...o })
beforeEach(async () => {
  issuer = await baIssuer('key-1')
  table = [{ kid: issuer.kid, alg: 'EdDSA', publicJwk: issuer.publicJwk }]
  reads = 0
  nowMs = T0
})

describe('a valid token of each kind verifies (D8)', () => {
  it('a session JWT is a session: subject, issued-at, no role, no organisation', async () => {
    expect(await adapter().verify(await mint({ sub: 'u-1' }))).toEqual({ ok: true, kind: 'session', subject: 'u-1', issuedAt: new Date(T0), organization: null, role: undefined })
  })
  it('an OAuth access token is oauth: client, and the vault scopes only (the provider\'s own scopes dropped)', async () => {
    expect(await adapter().verify(await mint({ kind: 'oauth', sub: 'u-1', clientId: 'c-1', scope: 'openid offline_access contacts:read contacts:write email' }))).toEqual({
      ok: true,
      kind: 'oauth',
      subject: 'u-1',
      clientId: 'c-1',
      scopes: ['contacts:read', 'contacts:write'],
    })
  })
  it('the audience may be a list that names the API origin (the provider adds the userinfo endpoint with openid)', async () => {
    expect((await adapter().verify(await mint({ kind: 'oauth', aud: [BA_BASE, `${BA_ISSUER}/oauth2/userinfo`] }))).ok).toBe(true)
  })
})

describe('every bad token is refused (D8, D23)', () => {
  it('wrong signature: a different key under the same kid', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    expect(await adapter().verify(await mint({ key: other.privateKey }))).toEqual({ ok: false, reason: 'signature' })
  })
  it('a key that is not in auth_jwks (unknown kid), and a token with no kid', async () => {
    expect(await adapter().verify(await mint({ kid: 'not-a-key' }))).toEqual({ ok: false, reason: 'signature' })
    expect(await adapter().verify(await mint({ kid: null }))).toEqual({ ok: false, reason: 'signature' })
  })
  it('wrong iss, including the issuer an attacker host would claim (never the request host)', async () => {
    expect(await adapter().verify(await mint({ iss: 'https://evil.example/auth' }))).toEqual({ ok: false, reason: 'issuer' })
    expect(await adapter().verify(await mint({ iss: BA_BASE }))).toEqual({ ok: false, reason: 'issuer' })
    expect(await adapter().verify(await mint({ kind: 'oauth', iss: 'https://other.vibase.test/auth' }))).toEqual({ ok: false, reason: 'issuer' })
  })
  it('wrong aud: another origin, a list without the API origin, none at all', async () => {
    expect(await adapter().verify(await mint({ aud: 'https://evil.example' }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter().verify(await mint({ aud: ['https://a.example', 'https://b.example'] }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter().verify(await mint({ kind: 'oauth', omit: ['aud'] }))).toMatchObject({ ok: false })
  })
  it('expired', async () => {
    const old = await mint({ ttl: 900, now: new Date(T0 - 2 * 3600_000) })
    expect(await adapter().verify(old)).toEqual({ ok: false, reason: 'expired' })
  })
  it('alg none and HS256', async () => {
    expect(await adapter().verify(await mint({ alg: 'none' }))).toEqual({ ok: false, reason: 'algorithm' })
    expect(await adapter().verify(await mint({ alg: 'HS256' }))).toEqual({ ok: false, reason: 'algorithm' })
  })
  it('an OIDC ID token from the same issuer (audience = the client id, no marker)', async () => {
    expect(await adapter().verify(await mint({ kind: 'id' }))).toEqual({ ok: false, reason: 'claims' })
    // even if it were addressed to the API origin, it is neither kind
    expect(await adapter().verify(await mint({ kind: 'id', aud: BA_BASE }))).toEqual({ ok: false, reason: 'claims' })
  })
  it('a Clerk-shaped token on a better-auth Worker', async () => {
    const clerk = await testIssuer()
    expect((await adapter().verify(await mintClerkToken(clerk, { sub: 'user_1', extra: { vibase_role: 'owner' } }))).ok).toBe(false)
  })
  it('not a JWT at all', async () => {
    expect(await adapter().verify('abc.def.ghi')).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('the two kinds are never confused (D8)', () => {
  it('a delegating client\'s access token is oauth, never a session, even with a session id claim', async () => {
    const r = await adapter().verify(await mint({ kind: 'oauth', clientId: 'delegating', extra: { vibase_token: 'session' } }))
    expect(r).toMatchObject({ ok: true, kind: 'oauth', clientId: 'delegating' })
  })
  it('a JWT without the access-token header that carries a client is refused', async () => {
    expect(await adapter().verify(await mint({ extra: { client_id: 'c', azp: 'c', scope: 'contacts:read' } }))).toEqual({ ok: false, reason: 'claims' })
  })
  it('a JWT that is no access token and lacks the session marker is refused', async () => {
    expect(await adapter().verify(await mint({ omit: ['vibase_token'] }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter().verify(await mint({ extra: { vibase_token: 'other' } }))).toEqual({ ok: false, reason: 'claims' })
  })
  it('an access token with no client id is refused', async () => {
    expect(await adapter().verify(await mint({ kind: 'oauth', omit: ['client_id'] }))).toEqual({ ok: false, reason: 'claims' })
  })
})

describe('the JWKS cache (P1, CORE259 D11)', () => {
  it('a warm request reads nothing; the first reads once', async () => {
    const a = adapter()
    await a.verify(await mint())
    expect(reads).toBe(1)
    for (let i = 0; i < 5; i++) expect((await a.verify(await mint())).ok).toBe(true)
    expect(reads).toBe(1)
  })
  it('an unknown kid re-reads at most once per 30 seconds, however many forged ones arrive', async () => {
    const a = adapter()
    await a.verify(await mint())
    expect(reads).toBe(1)
    nowMs += 31_000
    for (let i = 0; i < 20; i++) await a.verify(await mint({ kid: `forged-${i}` }))
    expect(reads).toBe(2)
    nowMs += 10_000
    await a.verify(await mint({ kid: 'forged-again' }))
    expect(reads).toBe(2)
    nowMs += 21_000
    await a.verify(await mint({ kid: 'forged-later' }))
    expect(reads).toBe(3)
  })
  it('a key created after the cache was filled is picked up as soon as the 30 seconds have passed', async () => {
    const a = adapter()
    await a.verify(await mint())
    const second = await baIssuer('key-2')
    nowMs += 31_000
    table = [...table, { kid: 'key-2', alg: 'EdDSA', publicJwk: second.publicJwk }]
    expect((await a.verify(await mintBaToken(second, { now: new Date(nowMs) }))).ok).toBe(true)
  })
  it('the cache lives 5 minutes, then the next request reads again', async () => {
    const a = adapter()
    await a.verify(await mint())
    nowMs += 4 * 60_000
    await a.verify(await mint())
    expect(reads).toBe(1)
    nowMs += 61_000
    await a.verify(await mint())
    expect(reads).toBe(2)
  })
  it('an empty auth_jwks is a refusal, never a throw', async () => {
    table = []
    expect(await adapter().verify(await mint())).toEqual({ ok: false, reason: 'signature' })
  })
  it('concurrent cold requests share one read', async () => {
    const a = adapter()
    await Promise.all([a.verify(await mint()), a.verify(await mint()), a.verify(await mint())])
    expect(reads).toBe(1)
  })
})
