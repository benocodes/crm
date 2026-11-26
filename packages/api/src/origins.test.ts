import { describe, expect, it } from 'vitest'
import { parseOriginList } from './auth/adapter.js'
import { originMatches, parseWildcardOrigin } from './origins.js'
import { ORIGIN_MATCH_TABLE } from './test/origin-table.js'

// [[API622]] D1-D3, P1, P2: the entry grammar for CORS_ALLOWED_ORIGINS (group 1, `parseOriginList`) and the matcher (group 2). The auth package runs the matching table through Better Auth's own matcher (parity).
const wild = (value: string) => parseOriginList(value, 'CORS_ALLOWED_ORIGINS', { allowWildcard: true })

describe('group 1: the grammar through parseOriginList (CORS)', () => {
  it.each([
    'https://*.hq.vibase.ai',
    'https://*.hq.vibase.ai:8443',
    'http://*.example.com',
    'http://*.localhost:5173',
    'https://*.com',
    'https://*.workers.dev',
    'https://*.pages.dev',
  ])('accepts %s', (entry) => {
    expect(wild(entry)).toEqual([entry])
  })

  it('keeps exact entries byte for byte beside a wildcard, strips one trailing slash (P2)', () => {
    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    expect(wild(` https://a.test/ ,https://*.b.test/, ${ext} `)).toEqual(['https://a.test', 'https://*.b.test', ext])
  })

  it.each([
    '*',
    'https://*',
    '*.hq.vibase.ai',
    'https://foo*.com',
    'https://a.*.com',
    'https://*.*.com',
    'https://**.com',
    'https://*.a.com?x=1',
    'https://*.a.com/path',
    'https://*.a.com/#f',
    'https://*.1.2.3.4',
    'https://*.[::1]',
    'chrome-extension://*',
    'chrome-extension://*.abcdefghijklmnopabcdefghijklmnop',
    'ftp://*.a.com',
    'https://*.a.com:99999',
    'https://*.A.com',
  ])('refuses %s, naming the var and its own value as today', (entry) => {
    expect(() => wild(entry)).toThrow(`CORS_ALLOWED_ORIGINS: "${entry}" is not an origin`)
  })

  it('P1: without allowWildcard (CLERK_AUTHORIZED_PARTIES) a wildcard is refused', () => {
    expect(() => parseOriginList('https://*.example.com', 'CLERK_AUTHORIZED_PARTIES')).toThrow(
      'CLERK_AUTHORIZED_PARTIES: "https://*.example.com" is not an origin',
    )
    expect(parseOriginList('https://a.example.com', 'CLERK_AUTHORIZED_PARTIES')).toEqual(['https://a.example.com'])
  })

  it('parseWildcardOrigin returns the base origin, undefined for an exact entry', () => {
    expect(parseWildcardOrigin('https://*.hq.vibase.ai:8443')).toBe('https://hq.vibase.ai:8443')
    expect(parseWildcardOrigin('https://hq.vibase.ai')).toBeUndefined()
  })
})

describe('group 2: originMatches', () => {
  it.each(ORIGIN_MATCH_TABLE)('%s vs %s -> %s', (entry, origin, want) => {
    expect(originMatches([entry], origin)).toBe(want)
  })
  it('an empty list matches nothing; any entry in the list may match', () => {
    expect(originMatches([], 'https://a.test')).toBe(false)
    expect(originMatches(['https://x.test', 'https://*.a.test', 'https://b.test'], 'https://q.a.test')).toBe(true)
    expect(originMatches(['https://x.test', 'https://*.a.test'], 'https://q.b.test')).toBe(false)
  })
})
