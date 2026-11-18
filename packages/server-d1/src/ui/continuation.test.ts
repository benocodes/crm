// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { APP_PAGE_PATHS } from '../app/paths.js'
import { crossOriginTarget, returnTarget } from './continuation.js'

// [[UI247]] D6 (b): `return_to` is honoured only when, resolved against the page's origin, it is same-origin with the pathname exactly `/device` or `/connect`.
const q = (v: string) => `?return_to=${encodeURIComponent(v)}`
describe('returnTarget', () => {
  it.each([
    ['/device', '/device'],
    ['/device?user_code=ABCDEFGH', '/device?user_code=ABCDEFGH'],
    ['/connect', '/connect'],
    ['/home', '/home'],
    ['/home?x=1', '/home?x=1'],
    [`${location.origin}/home`, '/home'],
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
    '/home/',
    '/home/x',
    '/homes',
    '/home/../x',
    'home',
    '/accounts/x',
    '/agents',
    '/app/app.js',
    '//evil.example/home',
    '/home/..%2Fx',
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

// [[UI461]] D3: the app pages come from APP_PAGE_PATHS, not a list of continuation.ts's own.
describe('the allow-list follows APP_PAGE_PATHS', () => {
  afterEach(() => {
    ;(APP_PAGE_PATHS as unknown as string[]).pop()
  })
  it('a path added to the constant is honoured with no edit to continuation.ts', () => {
    expect(returnTarget(q('/agents'))).toBeNull()
    ;(APP_PAGE_PATHS as unknown as string[]).push('/agents')
    expect(returnTarget(q('/agents'))).toBe('/agents')
  })
  it('/accounts is a return target (UI467 D1)', () => {
    expect(returnTarget(q('/accounts'))).toBe('/accounts')
    expect(returnTarget(q('/accounts?x=1'))).toBe('/accounts?x=1')
    expect(returnTarget(q('/accounts/'))).toBeNull()
  })
  it('a cross-origin https /home is still the callbackURL path, not a page target', () => {
    expect(returnTarget(q('https://app.example.com/home'))).toBeNull()
    expect(crossOriginTarget(q('https://app.example.com/home'))).toBe('https://app.example.com/home')
  })
})
