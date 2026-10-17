import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import { normalizeDomain, normalizeIdentityValue } from './normalize.js'

function apiError(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return e as ApiError
  }
  throw new Error('did not throw')
}

describe('normalizeIdentityValue email', () => {
  it('lowercases and trims', () => {
    expect(normalizeIdentityValue('email', '  Ori@Example.COM ')).toBe('ori@example.com')
  })
  it("keeps the local part's dots and +tags", () => {
    expect(normalizeIdentityValue('email', 'A.B+x@Gmail.com')).toBe('a.b+x@gmail.com')
  })
  it.each(['ori', 'ori@', '@x.com', 'ori@example', 'o ri@example.com', 'a@b@c.com'])('rejects %s', (v) => {
    const e = apiError(() => normalizeIdentityValue('email', v))
    expect([e.status, e.code, e.message]).toEqual([400, 'invalid_identity', 'invalid email address'])
  })
  it('rejects over 254 characters', () => {
    const v = `${'a'.repeat(64)}@${'b'.repeat(190)}.com`
    expect(v.length).toBeGreaterThan(254)
    expect(apiError(() => normalizeIdentityValue('email', v)).code).toBe('invalid_identity')
  })
})

describe('normalizeIdentityValue phone', () => {
  it('strips separators', () => {
    expect(normalizeIdentityValue('phone', '+44 (20) 7946-0958')).toBe('+442079460958')
    expect(normalizeIdentityValue('phone', '+1.415.555.0100')).toBe('+14155550100')
  })
  it.each(['020 7946 0958', '+0123456789', '+12345', '+1234567890123456', '+44 20 abc'])('requires E.164: %s', (v) => {
    const e = apiError(() => normalizeIdentityValue('phone', v))
    expect([e.status, e.code, e.message]).toEqual([400, 'invalid_identity', 'invalid phone number (E.164 required)'])
  })
})

describe('normalizeDomain', () => {
  it('normalises', () => {
    expect(normalizeDomain(' Example.COM ')).toBe('example.com')
    expect(normalizeDomain('www.acme.co.uk')).toBe('www.acme.co.uk')
  })
  it.each(['https://acme.com', 'acme', 'acme.com/', 'a@acme.com', 'acme.com.', '-acme.com'])('rejects %s', (v) => {
    const e = apiError(() => normalizeDomain(v))
    expect([e.status, e.code, e.message]).toEqual([400, 'validation_error', 'domain: invalid domain'])
  })
})
