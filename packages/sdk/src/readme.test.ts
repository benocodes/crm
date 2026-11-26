import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// DX636 group 6 (D10a): the README's "Browser sign-in" section names every method and every code the module can reject with.
const HERE = dirname(fileURLToPath(import.meta.url))
const readme = (): string => readFileSync(join(HERE, '..', 'README.md'), 'utf8')
const SECTION_TITLE = '## Browser sign-in'
function section(markdown: string): string {
  const start = markdown.indexOf(`\n${SECTION_TITLE}\n`)
  if (start < 0) return ''
  const rest = markdown.slice(start + 1)
  const next = rest.indexOf('\n## ', SECTION_TITLE.length)
  return next < 0 ? rest : rest.slice(0, next)
}

// The codes `sign-in.ts` throws as literals; the test below checks this list against the source.
const CODES = [
  'unsupported_provider',
  'discovery_failed',
  'issuer_mismatch',
  'endpoint_origin',
  'insecure_issuer',
  'invalid_return_to',
  'state_mismatch',
  'authorization_failed',
  'invalid_response',
  'network_error',
]
const METHODS = ['signIn', 'handleRedirect', 'token', 'isSignedIn', 'signOut']

describe('DX636 group 6: the README documents browser sign-in completely', () => {
  it('the list of codes here is exactly the literal codes sign-in.ts throws (plus invalid_response and network_error, built in helpers)', () => {
    const source = readFileSync(join(HERE, 'sign-in.ts'), 'utf8')
    const literal = new Set([...source.matchAll(/new VibaseError\(\s*\d+,\s*'([a-z_]+)'/g)].map((m) => m[1]))
    // invalid_response is the fallback of the `error` variable in the code exchange and the refresh; network_error is built by `network()`.
    const found = new Set([
      ...literal,
      ...[...source.matchAll(/\?\s*[a-z.]+\s*:\s*'(invalid_response)'/g)].map((m) => m[1]),
    ])
    found.add('network_error')
    expect([...found].sort()).toEqual([...CODES].sort())
  })

  it('has a "Browser sign-in" section', () => {
    expect(section(readme()).length).toBeGreaterThan(200)
  })

  it.each(CODES)('the section names the code %s', (code) => {
    expect(section(readme())).toContain(`\`${code}\``)
  })

  it('the section also names the two pass-through kinds: an OAuth error code and http_<status>', () => {
    const body = section(readme())
    expect(body).toContain('`http_<status>`')
    expect(body).toMatch(/OAuth `error`/)
  })

  it.each(METHODS)('the section has its own bullet under "### The verbs" for %s', (method) => {
    const body = section(readme())
    const start = body.indexOf('### The verbs')
    expect(start).toBeGreaterThan(-1)
    const verbs = body.slice(start, body.indexOf('\n### ', start + 1))
    expect(verbs).toContain(`\n- **\`${method}(`)
  })
})
