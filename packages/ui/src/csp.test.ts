// [[UI443]] cycle 1, group 1 (D5): APP_CSP is PAGE_CSP with inline styles only.
import { describe, expect, it } from 'vitest'
import { APP_CSP, PAGE_CSP } from './csp'

const directives = (csp: string) => new Map(csp.split('; ').map((d) => [d.split(' ')[0]!, d.slice(d.indexOf(' ') + 1)]))

describe('APP_CSP', () => {
  it('differs from PAGE_CSP in style-src alone, which is exactly self plus unsafe-inline', () => {
    const app = directives(APP_CSP)
    const page = directives(PAGE_CSP)
    expect([...app.keys()]).toEqual([...page.keys()])
    const differing = [...app.keys()].filter((k) => app.get(k) !== page.get(k))
    expect(differing).toEqual(['style-src'])
    expect(app.get('style-src')).toBe("'self' 'unsafe-inline'")
  })

  it("keeps script-src 'self' in both policies and allows no inline script", () => {
    expect(directives(APP_CSP).get('script-src')).toBe("'self'")
    expect(directives(PAGE_CSP).get('script-src')).toBe("'self'")
  })

  it('leaves PAGE_CSP unchanged', () => {
    expect(PAGE_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
  })
})
