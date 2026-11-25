import { describe, expect, it } from 'vitest'
import { SUMMARY_MAX, VALUE_MAX, labelOf, quoted } from './summary.js'

// [[AGT588]] D8 hygiene and the label rule, as pure functions. The integration suite (`card.rest.integration.test.ts`) proves them through `action_requests.create`.
describe('quoted: every interpolated value', () => {
  it('is quoted, single-line, stripped of invisible characters and clamped to 80 characters with an ellipsis', () => {
    expect(quoted('Ann')).toBe('"Ann"')
    expect(quoted('a\u202Eb\u200Bc\u2066d\uFEFFe\u{E0041}f')).toBe('"abcdef"')
    expect(quoted('line one\nline two\r\n\tthree\u0000x')).toBe('"line one line two three x"')
    const long = quoted('x'.repeat(300))
    expect(long).toBe(`"${'x'.repeat(VALUE_MAX - 1)}…"`)
    expect(long.length).toBe(VALUE_MAX + 2)
    expect(quoted('x'.repeat(VALUE_MAX))).toBe(`"${'x'.repeat(VALUE_MAX)}"`)
  })
  it('keeps a double quote from closing the quotation early, and keeps ZWJ and ZWNJ', () => {
    expect(quoted('say "hi" now')).toBe(`"say 'hi' now"`)
    expect(quoted('a\u200Db\u200Cc')).toBe('"a\u200Db\u200Cc"')
  })
  it('never splits a surrogate pair when clamping', () => {
    const q = quoted('😀'.repeat(200))
    expect([...q].length).toBe(VALUE_MAX + 2)
    expect(q).not.toMatch(/[\uD800-\uDBFF]"|"[\uDC00-\uDFFF]/)
  })
  it('SUMMARY_MAX is 500', () => expect(SUMMARY_MAX).toBe(500))
})

describe('labelOf: name, else title, else subject, else the id', () => {
  const id = '0190b2c4-0000-7000-8000-000000000001'
  it('takes the first of name, title, subject the table has', () => {
    expect(labelOf({ id, name: 'N', title: 'T', subject: 'S' }, id)).toBe('N')
    expect(labelOf({ id, title: 'T', subject: 'S' }, id)).toBe('T')
    expect(labelOf({ id, subject: 'S' }, id)).toBe('S')
    expect(labelOf({ id, status: 'open' }, id)).toBe(id)
  })
  it('falls back to the id when the label column is NULL or blank, and to null when there is no row', () => {
    expect(labelOf({ id, name: null, title: 'T' }, id)).toBe(id)
    expect(labelOf({ id, name: '   ' }, id)).toBe(id)
    expect(labelOf(null, id)).toBeNull()
  })
})
