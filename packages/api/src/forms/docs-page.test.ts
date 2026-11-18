import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INGRESS_ANSWERS,
  MAX_ARRAY_ITEMS,
  MAX_BODY_BYTES,
  MAX_FIELDS,
  MAX_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  RESERVED_FIELDS,
  RESERVED_PREFIX,
} from './ingress.js'

// [[CHN432]] D20, P6 (432.8): the site-author page is checked against the handler's exports, never a copy in this test.
const PAGE = fileURLToPath(new URL('../../../docs/src/content/docs/guides/forms.md', import.meta.url))
const INGRESS = fileURLToPath(new URL('./ingress.ts', import.meta.url))
const page = () => readFileSync(PAGE, 'utf8')
const sizes = (n: number) => [String(n), n.toLocaleString('en-US'), ...(n % 1024 === 0 ? [`${n / 1024} KiB`] : [])]

describe('guides/forms names what the route does', () => {
  it('names every reserved field and the reserved prefix', () => {
    const text = page()
    for (const name of RESERVED_FIELDS) expect(text, name).toContain(name)
    expect(text).toContain(RESERVED_PREFIX)
  })

  it.each([
    ['the body size', MAX_BODY_BYTES],
    ['the field count', MAX_FIELDS],
    ['the name length', MAX_NAME_LENGTH],
    ['the value length', MAX_VALUE_LENGTH],
    ['the values per repeated field', MAX_ARRAY_ITEMS],
  ])('states %s', (_what, n) => {
    const text = page()
    expect(
      sizes(n).some((s) => text.includes(s)),
      sizes(n).join(' | '),
    ).toBe(true)
  })

  it('has a line for every status and code the route answers, and for the preflight', () => {
    const lines = page().split('\n')
    for (const { status, code } of INGRESS_ANSWERS)
      expect(
        lines.some((l) => l.includes(String(status)) && l.includes(code)),
        `${status} ${code}`,
      ).toBe(true)
    expect(lines.some((l) => l.includes('204') && /preflight|OPTIONS/i.test(l))).toBe(true)
  })

  it('shows the three formats, a plain HTML form and a fetch(new FormData(form)) example, both with the widget', () => {
    const text = page()
    for (const s of ['application/x-www-form-urlencoded', 'multipart/form-data', 'application/json'])
      expect(text).toContain(s)
    expect(text).toContain('<form')
    expect(text).toContain('fetch(')
    expect(text).toContain('new FormData(')
    expect(text).toMatch(/cf-turnstile\b/)
    expect(text).toContain('challenges.cloudflare.com/turnstile/v0/api.js')
  })

  it('has the answers list complete: every ApiError the handler raises is in INGRESS_ANSWERS', () => {
    const src = readFileSync(INGRESS, 'utf8')
    const raised = [...src.matchAll(/new ApiError\((\d+), '([a-z_]+)'/g)].map((m) => `${m[1]} ${m[2]}`)
    const listed = INGRESS_ANSWERS.map((a) => `${a.status} ${a.code}`)
    expect(raised.length).toBeGreaterThan(5)
    expect(raised.filter((r) => !listed.includes(r))).toEqual([])
    expect(listed.filter((l) => !l.startsWith('202') && !raised.includes(l))).toEqual([])
  })
})
