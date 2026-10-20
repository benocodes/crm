import { describe, expect, it } from 'vitest'
import { generateKeyPair } from 'jose'
import { createClerkAdapter } from './clerk.js'
import { API_URL, SECRET_KEY, clerkUser, mintClerkToken, testClerkAdapter, testIssuer } from '../test/clerk.js'

const NOW = new Date('2026-10-20T12:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)
const setup = () => testClerkAdapter({ now: () => NOW })
const mint = async (o: Parameters<typeof mintClerkToken>[1] = {}) => mintClerkToken(await testIssuer(), { now: NOW, ...o })

describe('clerk verify', () => {
  it('valid token', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ sub: 'user_1' }))).toEqual({ ok: true, subject: 'user_1' })
  })

  it('bad signature', async () => {
    const { adapter } = await setup()
    const other = await generateKeyPair('RS256')
    expect(await adapter.verify(await mint({ key: other.privateKey }))).toEqual({ ok: false, reason: 'signature' })
  })

  it('expired beyond skew / within skew', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ exp: nowS - 10 }))).toEqual({ ok: false, reason: 'expired' })
    expect((await adapter.verify(await mint({ exp: nowS - 3 }))).ok).toBe(true)
  })

  it('not yet valid / nbf within skew', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ nbf: nowS + 10 }))).toEqual({ ok: false, reason: 'not_yet_valid' })
    expect((await adapter.verify(await mint({ nbf: nowS + 3 }))).ok).toBe(true)
  })

  it('wrong issuer', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ iss: 'https://evil.example' }))).toEqual({ ok: false, reason: 'issuer' })
  })

  it('azp outside the list, absent, not a string', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ azp: 'https://evil.example' }))).toEqual({ ok: false, reason: 'azp' })
    expect((await adapter.verify(await mint({ azp: undefined }))).ok).toBe(true)
    expect(await adapter.verify(await mint({ azp: 42 }))).toEqual({ ok: false, reason: 'azp' })
  })

  it('missing sub, empty sub, missing exp', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ omit: ['sub'] }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter.verify(await mint({ sub: '' }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter.verify(await mint({ omit: ['exp'] }))).toEqual({ ok: false, reason: 'claims' })
  })

  it('HS256 is refused', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ alg: 'HS256' }))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('malformed', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify('a.b.c')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('an escaped PEM (literal \\n) works', async () => {
    const issuer = await testIssuer()
    const adapter = createClerkAdapter({
      jwtKey: issuer.pem.replace(/\n/g, '\\n'),
      issuer: issuer.issuer,
      authorizedParties: [issuer.party],
      secretKey: SECRET_KEY,
      now: () => NOW,
    })
    expect((await adapter.verify(await mint())).ok).toBe(true)
  })

  it('organisation claims are ignored', async () => {
    const { adapter } = await setup()
    const r = await adapter.verify(await mint({ extra: { o: { id: 'org_x', rol: 'admin' } } }))
    expect(r).toEqual({ ok: true, subject: 'user_1' })
  })
})

describe('clerk fetchProfile', () => {
  const withUser = async (u: ReturnType<typeof clerkUser>) =>
    (await testClerkAdapter({ profiles: new Map([[u.id, u]]), now: () => NOW })).adapter

  it('primary verified', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: 'a@x.test', verified: true, first: 'Ada', last: 'L' }))
    expect(await a.fetchProfile('user_1')).toEqual({ email: 'a@x.test', emailVerified: true, name: 'Ada L' })
  })

  it('primary unverified', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: 'a@x.test', verified: false }))
    expect((await a.fetchProfile('user_1')).emailVerified).toBe(false)
  })

  it('the primary address is chosen', async () => {
    const u = clerkUser({ id: 'user_1', email: 'first@x.test' })
    u.email_addresses = [
      { ...u.email_addresses[0]!, id: 'idn_a', email_address: 'first@x.test' },
      { ...u.email_addresses[0]!, id: 'idn_b', email_address: 'second@x.test' },
    ]
    u.primary_email_address_id = 'idn_b'
    expect((await (await withUser(u)).fetchProfile('user_1')).email).toBe('second@x.test')
  })

  it('no email', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: null, first: 'Ada', last: null }))
    expect(await a.fetchProfile('user_1')).toEqual({ email: null, emailVerified: false, name: 'Ada' })
  })

  it('name parts', async () => {
    const name = async (first: string | null, last: string | null) =>
      (await (await withUser(clerkUser({ id: 'u', email: 'a@x.test', first, last }))).fetchProfile('u')).name
    expect(await name('Ada', null)).toBe('Ada')
    expect(await name(null, null)).toBeNull()
  })

  it('request shape', async () => {
    const t = await testClerkAdapter({ profiles: new Map([['user_a/b', clerkUser({ id: 'user_a/b', email: 'a@x.test' })]]) })
    await t.adapter.fetchProfile('user_a/b')
    expect(t.fetch.calls).toEqual([{ url: `${API_URL}/v1/users/user_a%2Fb`, authorization: `Bearer ${SECRET_KEY}` }])
  })

  it('HTTP error', async () => {
    const t = await testClerkAdapter({ profiles: new Map() })
    await expect(t.adapter.fetchProfile('nobody')).rejects.toThrow('clerk profile fetch failed: 404')
  })
})
