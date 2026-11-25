import { describe, expect, it } from 'vitest'
import { messagePreview } from '../../messaging/preview.js'
import { gmailFixture, MAILBOX } from '../../test/gmail-fixtures.js'
import { stringifyMarkdown, toPlainText } from '../markdown.js'
import { mapGmailMessage } from './mapper.js'

// [[CHN193]] D1 to D3 ([[AGT588]]): what a captured HTML body stores is what a mail client shows.
function render(html: string) {
  const built = gmailFixture('htmlOnly', (s) => ({ ...s, payload: { mimeType: 'text/html', text: html } }))
  const out = mapGmailMessage({
    conn: { id: 'conn-1', mailbox: MAILBOX },
    resource: built.resource,
    openRaw: async () => new Blob([built.rfc822.slice()]).stream() as ReadableStream<Uint8Array>,
  })
  if ('skip' in out) throw new Error(out.skip)
  const { formatted } = out.message
  return {
    body: stringifyMarkdown(formatted),
    plain: toPlainText(formatted),
    preview: messagePreview(out.message, 'message'),
  }
}
/** The visible text and the hidden text, in a wrapper around `attrs`. */
const wrapped = (open: string, close = '</div>') => `<p>VISIBLE-A</p>${open}SECRET${close}<p>VISIBLE-B</p>`
const hides = (html: string): void => {
  const r = render(html)
  for (const field of [r.body, r.plain, r.preview]) {
    expect(field).not.toContain('SECRET')
    expect(field).toContain('VISIBLE-A')
    expect(field).toContain('VISIBLE-B')
  }
}
const keeps = (html: string): void => {
  const r = render(html)
  for (const field of [r.body, r.plain, r.preview]) expect(field).toContain('SECRET')
}

describe('D1 hidden elements', () => {
  it.each([
    ['display:none', wrapped('<div style="display:none">')],
    ['display: none !important', wrapped('<div style="color:red; DISPLAY : NONE !important">')],
    ['visibility:hidden', wrapped('<div style="visibility:hidden">')],
    ['visibility:collapse', wrapped('<div style="visibility: collapse">')],
    ['opacity:0', wrapped('<div style="opacity:0">')],
    ['opacity:0.0', wrapped('<div style="opacity:0.0">')],
    ['font-size:0', wrapped('<div style="font-size:0">')],
    ['font-size:0px', wrapped('<div style="font-size:0px">')],
    ['font-size:0em', wrapped('<div style="font-size:0em">')],
    ['font-size:0pt', wrapped('<div style="font-size:0pt">')],
    ['height:0 + overflow:hidden', wrapped('<div style="height:0;overflow:hidden">')],
    ['max-height:0px + overflow:hidden', wrapped('<div style="overflow: hidden; max-height:0px">')],
    ['the hidden attribute', wrapped('<div hidden>')],
    ['a template element', wrapped('<template>', '</template>')],
    ['a span, not only a div', `<p>VISIBLE-A<span style="display:none">SECRET</span></p><p>VISIBLE-B</p>`],
    ['uppercase property and value', wrapped('<div style="DISPLAY:NONE">')],
    ['an earlier declaration overridden by a later hiding one', wrapped('<div style="display:block;display:none">')],
    [
      'nested in a visible element',
      `<div><p>VISIBLE-A</p><div><div style="display:none">SECRET</div></div></div><p>VISIBLE-B</p>`,
    ],
    [
      'hidden element holding a link',
      wrapped('<div style="display:none"><a href="https://x.test/SECRET">', '</a></div>'),
    ],
  ])('drops %s with its content', (_name, html) => hides(html))

  it.each([
    ['display:block', wrapped('<div style="display:block">')],
    ['opacity:0.5', wrapped('<div style="opacity:0.5">')],
    ['font-size:1px', wrapped('<div style="font-size:1px">')],
    ['font-size:10px', wrapped('<div style="font-size:10px">')],
    ['height:0 without overflow:hidden', wrapped('<div style="height:0">')],
    ['overflow:hidden without a zero height', wrapped('<div style="height:20px;overflow:hidden">')],
    ['a hiding declaration overridden later', wrapped('<div style="display:none;display:block">')],
    ['a later opacity override', wrapped('<div style="opacity:0;opacity:1">')],
    ['a hiding class (no stylesheet rules)', wrapped('<div class="hidden">')],
  ])('keeps %s', (_name, html) => keeps(html))

  it("a stylesheet class rule does not hide (only the element's own style is read)", () => {
    keeps('<style>.x{display:none}</style><div class="x">SECRET</div>')
  })
})

describe('D2 comments and raw HTML', () => {
  it('drops a plain comment from body, preview and plain text (the #193 reproduction)', () => {
    const r = render('<p>Hello<!-- SECRET comment --> world</p>')
    for (const f of [r.body, r.plain, r.preview]) {
      expect(f).not.toContain('SECRET')
      expect(f).not.toContain('<!--')
    }
    expect(r.plain).toContain('Hello')
    expect(r.plain).toContain('world')
  })

  it('drops an Outlook conditional block with its content', () => {
    const r = render('<p>VISIBLE-A</p><!--[if mso]><p>SECRET</p><![endif]--><p>VISIBLE-B</p>')
    for (const f of [r.body, r.plain, r.preview]) {
      expect(f).not.toContain('SECRET')
      expect(f).not.toContain('[if')
      expect(f).not.toContain('<!')
      expect(f).toContain('VISIBLE-B')
    }
  })

  it('leaves no html node and no raw markup in the markdown', () => {
    const built = gmailFixture('htmlOnly', (s) => ({
      ...s,
      payload: { mimeType: 'text/html', text: '<p>a</p><!-- c --><div><!-- d -->b</div>' },
    }))
    const out = mapGmailMessage({
      conn: { id: 'c', mailbox: MAILBOX },
      resource: built.resource,
      openRaw: async () => new Blob([built.rfc822.slice()]).stream() as ReadableStream<Uint8Array>,
    })
    if ('skip' in out) throw new Error(out.skip)
    const types: string[] = []
    const stack: unknown[] = [out.message.formatted]
    while (stack.length) {
      const n = stack.pop() as { type: string; children?: unknown[] }
      types.push(n.type)
      for (const c of n.children ?? []) stack.push(c)
    }
    expect(types).not.toContain('html')
  })
})

describe('D3 images', () => {
  it('an img becomes its alt text', () => {
    expect(render('<p>See <img src="https://track.test/p.gif?u=SECRET" alt="the chart"> here</p>').body).toBe(
      'See the chart here\n',
    )
  })
  it.each([
    ['no alt', '<p>A<img src="https://track.test/p.gif">B</p>'],
    ['a whitespace-only alt', '<p>A<img src="https://track.test/p.gif" alt="   ">B</p>'],
    ['an empty alt', '<p>A<img src="https://track.test/p.gif" alt="">B</p>'],
    ['a cid image', '<p>A<img src="cid:logo@x.test">B</p>'],
  ])('an img with %s becomes nothing, and no image URL is stored', (_n, html) => {
    const r = render(html)
    expect(r.body).toBe('AB\n')
    expect(r.body).not.toMatch(/http|cid:/)
    expect(r.plain).toBe('AB')
  })
  it('a link keeps its URL', () => {
    expect(render('<p><a href="https://example.test/x">a link</a></p>').body).toContain('(https://example.test/x)')
  })
  it('a linked image keeps the link and drops the image URL', () => {
    const r = render('<a href="https://example.test/go"><img src="https://track.test/i.png" alt="Go"></a>')
    expect(r.body).toContain('https://example.test/go')
    expect(r.body).not.toContain('track.test')
    expect(r.body).toContain('Go')
  })
})
