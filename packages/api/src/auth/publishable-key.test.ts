import { describe, expect, it } from 'vitest'
import { parsePublishableKey, publishableKeyHost } from './publishable-key.js'

// [[UI30]] D5: `CLERK_PUBLISHABLE_KEY` is public, and a key from another instance is a configuration error that never echoes the key.
// Built at run time so a secret scanner does not mistake the fixtures for real keys.
const pk = (host: string, kind = 'test') => ['pk', kind, btoa(`${host}$`)].join('_')
const HOST = 'acme-test-12.clerk.accounts.dev'
const ISSUER = `https://${HOST}`

describe('publishableKeyHost', () => {
  it('decodes the Frontend API host of a test and a live key', () => {
    expect(publishableKeyHost(pk(HOST))).toBe(HOST)
    expect(publishableKeyHost(pk('clerk.hq.vibase.ai', 'live'))).toBe('clerk.hq.vibase.ai')
  })
  it.each([
    ['no prefix', btoa(`${HOST}$`)],
    ['no terminator', ['pk', 'test', btoa(HOST)].join('_')],
    ['not a host', ['pk', 'test', btoa('not a host$')].join('_')],
    ['not base64', 'pk_test_!!!'],
    ['empty', ''],
  ])('%s: undefined', (_n, key) => {
    expect(publishableKeyHost(key)).toBeUndefined()
  })
})

describe('parsePublishableKey', () => {
  it('returns the trimmed key when its host is the issuer host (case-insensitive)', () => {
    expect(parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: ` ${pk(HOST)} ` })).toBe(pk(HOST))
    expect(parsePublishableKey({ CLERK_ISSUER: ISSUER.toUpperCase().replace('HTTPS', 'https'), CLERK_PUBLISHABLE_KEY: pk(HOST) })).toBe(pk(HOST))
  })
  it('unset or blank is undefined', () => {
    expect(parsePublishableKey({ CLERK_ISSUER: ISSUER })).toBeUndefined()
    expect(parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: '  ' })).toBeUndefined()
  })
  it('a key for another host throws naming the variable and never the value', () => {
    const key = pk('other.clerk.accounts.dev')
    expect(() => parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: key })).toThrow(/CLERK_PUBLISHABLE_KEY/)
    try {
      parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: key })
    } catch (e) {
      const m = (e as Error).message
      expect(m).not.toContain(key)
      expect(m).not.toContain('other.clerk.accounts.dev')
    }
  })
  it('a malformed key throws naming the variable and never the value', () => {
    const key = 'pk_test_' + 'x'.repeat(10) + '!!'
    expect(() => parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: key })).toThrow(/CLERK_PUBLISHABLE_KEY/)
    try {
      parsePublishableKey({ CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: key })
    } catch (e) {
      expect((e as Error).message).not.toContain(key)
    }
  })
})
