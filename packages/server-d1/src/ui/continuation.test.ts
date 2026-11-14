// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { returnTarget } from './continuation.js'

// [[UI247]] D6 (b): `return_to` is honoured only when, resolved against the page's origin, it is same-origin with the pathname exactly `/device` or `/connect`.
const q = (v: string) => `?return_to=${encodeURIComponent(v)}`
describe('returnTarget', () => {
  it.each([
    ['/device', '/device'],
    ['/device?user_code=ABCDEFGH', '/device?user_code=ABCDEFGH'],
    ['/connect', '/connect'],
    [`${location.origin}/device?user_code=ABCDEFGH`, '/device?user_code=ABCDEFGH'],
  ])('%s is honoured as %s', (value, expected) => {
    expect(returnTarget(q(value))).toBe(expected)
  })

  it.each([
    'https://evil.example/device',
    '//evil.example/device',
    '/device/../x',
    '/device/',
    '/devices',
    '/consent',
    '/sign-in',
    '/auth/device',
    'javascript:alert(1)',
    'data:text/html,x',
    '',
    '/\\evil.example',
    'device',
  ])('%j is ignored', (value) => {
    expect(returnTarget(q(value))).toBeNull()
  })

  it('no return_to is null', () => {
    expect(returnTarget('')).toBeNull()
    expect(returnTarget('?notice=password-reset')).toBeNull()
  })

  it('a signed query is none of its business: only return_to counts', () => {
    expect(returnTarget('?client_id=c&sig=s')).toBeNull()
  })
})
