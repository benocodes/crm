import { describe, expect, it } from 'vitest'
import { contentDisposition, safeContentType } from './binary.js'

describe('safeContentType', () => {
  it('plain type', () => expect(safeContentType('application/pdf')).toBe('application/pdf'))
  it('parameters and case dropped', () => expect(safeContentType('Text/HTML; charset=utf-8')).toBe('text/html'))
  it('refused', () => {
    for (const m of ['', 'pdf', 'a/b\r\nx: y', 'a/b c']) expect(safeContentType(m)).toBe('application/octet-stream')
  })
})

describe('contentDisposition', () => {
  it('plain name', () => expect(contentDisposition('cv.pdf')).toBe(`attachment; filename="cv.pdf"; filename*=UTF-8''cv.pdf`))
  it('quotes and backslash', () => {
    const h = contentDisposition('Jane "CV"\\x.pdf')
    expect(h).toContain('filename="Jane _CV__x.pdf"')
    expect(h).toContain('%22CV%22')
    expect(h).toContain('%5Cx.pdf')
  })
  it('non-ASCII', () => {
    expect(contentDisposition('résumé.pdf')).toBe(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`)
  })
  it('header injection', () => {
    const h = contentDisposition('a\r\nX-Evil: 1.pdf')
    expect(h).not.toMatch(/[\r\n]/)
  })
})
