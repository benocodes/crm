import { describe, expect, it } from 'vitest'
import { pkceChallenge, pkceVerifier, signState, verifyState } from './state.js'

// CHN140 D57: a stateless HMAC-signed state and a derived PKCE verifier.
const SECRET = 'state-secret-1'
const NOW = Date.parse('2026-11-05T10:00:00.000Z')
const claims = { user_id: '0190b2c4-0000-7000-8000-00000000a001', nonce: 'n-123', expires_at: NOW + 10 * 60_000 }

describe('state', () => {
  it('verifies what it signed and returns the claims', async () => {
    expect(await verifyState(SECRET, await signState(SECRET, claims), NOW)).toEqual(claims)
  })

  it('refuses an expired state (at and after expires_at)', async () => {
    const state = await signState(SECRET, claims)
    expect(await verifyState(SECRET, state, claims.expires_at - 1)).not.toBeNull()
    expect(await verifyState(SECRET, state, claims.expires_at)).toBeNull()
    expect(await verifyState(SECRET, state, claims.expires_at + 60_000)).toBeNull()
  })

  it('refuses a state signed with another secret', async () => {
    expect(await verifyState(SECRET, await signState('other-secret', claims), NOW)).toBeNull()
  })

  it('refuses a tampered payload and a tampered signature', async () => {
    const [payload, sig] = (await signState(SECRET, claims)).split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...claims, user_id: '0190b2c4-0000-7000-8000-00000000a002' })).toString('base64url')
    expect(await verifyState(SECRET, `${forged}.${sig}`, NOW)).toBeNull()
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
    expect(await verifyState(SECRET, `${payload}.${flipped}`, NOW)).toBeNull()
  })

  it.each(['', 'x', 'a.b.c', '.', 'a.', '.b', 'not base64.sig'])('refuses the malformed state %j', async (state) => {
    expect(await verifyState(SECRET, state, NOW)).toBeNull()
  })

  it('refuses a correctly signed payload that is not the claims shape', async () => {
    const state = await signState(SECRET, { ...claims, user_id: 5 } as never)
    expect(await verifyState(SECRET, state, NOW)).toBeNull()
  })
})

describe('PKCE (derived, nothing stored)', () => {
  it('the verifier is deterministic per nonce and secret, and differs across both', async () => {
    const v = await pkceVerifier(SECRET, 'n1')
    expect(await pkceVerifier(SECRET, 'n1')).toBe(v)
    expect(await pkceVerifier(SECRET, 'n2')).not.toBe(v)
    expect(await pkceVerifier('other', 'n1')).not.toBe(v)
  })

  it('the verifier is a valid RFC 7636 verifier (43 to 128 unreserved characters)', async () => {
    expect(await pkceVerifier(SECRET, 'n1')).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
  })

  it('the S256 challenge matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
