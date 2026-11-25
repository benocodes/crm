import { describe, expect, it } from 'vitest'
import { stringifyMarkdown, toPlainText } from '../markdown.js'
import type { ChannelMessage } from '../port.js'
import { messagePreview } from '../../messaging/preview.js'
import { toBase64Url } from '../../test/gmail.js'
import { gmailFixture, MAILBOX, type FixtureName } from '../../test/gmail-fixtures.js'
import type { MessageSpec } from '../../test/gmail.js'
import type { GmailMessagePart } from './types.js'
import { mapGmailMessage, type GmailConnection } from './mapper.js'

// [[CHN5]] D35, [[CORE25]] "Channel port", D28, D29, D36, D37: the Gmail mapper over the synthetic fixtures.
const CONN: GmailConnection = { id: 'conn-1', mailbox: MAILBOX }
const mb = toBase64Url(new TextEncoder().encode(MAILBOX), false)

function map(name: FixtureName, adjust?: (s: MessageSpec) => MessageSpec): { out: ChannelMessage; opened: number } {
  const built = gmailFixture(name, adjust)
  let opened = 0
  const out = mapGmailMessage({
    conn: CONN,
    resource: built.resource,
    openRaw: async () => {
      opened++
      return new Blob([built.rfc822.slice()]).stream() as ReadableStream<Uint8Array>
    },
  })
  if ('skip' in out) throw new Error(`skipped: ${out.skip}`)
  return { out, opened }
}
const md = (name: FixtureName, adjust?: (s: MessageSpec) => MessageSpec): string =>
  stringifyMarkdown(map(name, adjust).out.message.formatted)

describe('ids and facts', () => {
  it('maps a plain message', () => {
    // Pinned: the fixture's default internalDate is relative to now, and this test asserts the mapped timestamp exactly.
    const { out } = map('plain', (s) => ({ ...s, internalDate: Date.parse('2026-10-22T09:00:00.000Z') }))
    expect(out.facts).toMatchObject({
      channel: 'email',
      kind: 'message',
      external_id: 'plain@acme.test',
      in_reply_to: null,
      thread_hints: [],
      provider_message_id: 'plain',
      provider_thread_id: 't-plain',
      occurred_at: '2026-10-22T09:00:00.000Z',
      subject: 'Subject of plain',
      sent_by_connection: false,
      attachments: [],
    })
    expect(out.facts.participants).toEqual([
      { kind: 'email', value: 'jane@acme.test', name: 'Jane Roe', role: 'from' },
      { kind: 'email', value: MAILBOX, role: 'to' },
    ])
    expect(out.message.id).toBe(`gmail:${mb}:plain`)
    expect(out.message.threadId).toBe(`gmail:${mb}:t-plain`)
    expect(out.message.author).toEqual({
      userId: 'jane@acme.test',
      userName: 'jane@acme.test',
      fullName: 'Jane Roe',
      isBot: false,
      isMe: false,
    })
    expect(out.message.metadata).toMatchObject({ edited: false })
    expect(out.message.metadata.dateSent.toISOString()).toBe('2026-10-22T09:00:00.000Z')
    expect(out.message.text).toBe(toPlainText(out.message.formatted))
  })

  it('external_id is the Message-ID without angle brackets, whatever the header name case', () => {
    expect(map('plain').out.facts.external_id).toBe('plain@acme.test')
    const renamed = map('plain', (s) => ({
      ...s,
      headers: s.headers.map(([k, v]) => [
        k === 'Message-ID' ? 'message-id' : k,
        k === 'Message-ID' ? `  <Plain.Case@Acme.test>  ` : v,
      ]),
    }))
    expect(renamed.out.facts.external_id).toBe('Plain.Case@Acme.test')
  })

  it('a missing Message-ID falls back to gmail:<connection id>:<gmail message id>', () => {
    expect(map('noMessageId').out.facts.external_id).toBe('gmail:conn-1:no-message-id')
  })

  it('in_reply_to and hints: In-Reply-To first, then References newest first, no duplicates, no brackets', () => {
    const { out } = map('reply')
    expect(out.facts.in_reply_to).toBe('c@acme.test')
    expect(out.facts.thread_hints).toEqual(['c@acme.test', 'b@acme.test', 'a@acme.test'])
  })

  it('hints are capped at 20', () => {
    const refs = Array.from({ length: 25 }, (_, i) => `<r${i}@x.test>`).join(' ')
    const { out } = map('reply', (s) => ({
      ...s,
      headers: s.headers.map(([k, v]) => [k, k === 'References' ? refs : v]),
    }))
    expect(out.facts.thread_hints).toHaveLength(20)
    expect(out.facts.thread_hints[0]).toBe('c@acme.test')
    expect(out.facts.thread_hints[1]).toBe('r24@x.test')
  })

  it('sent_by_connection comes from the SENT label, and a self-addressed message keeps both roles', () => {
    const { out } = map('selfAddressed')
    expect(out.facts.sent_by_connection).toBe(true)
    expect(out.message.author.isMe).toBe(true)
    expect(map('plain').out.facts.sent_by_connection).toBe(false)
  })

  it('falls back to the Date header when internalDate is missing', () => {
    const built = gmailFixture('plain')
    delete built.resource.internalDate
    const out = mapGmailMessage({
      conn: CONN,
      resource: built.resource,
      openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array>,
    }) as ChannelMessage
    expect(out.facts.occurred_at).toBe('2026-10-22T09:00:00.000Z')
  })

  it('skips a draft and a resource without a payload, by name', () => {
    const draft = gmailFixture('plain', (s) => ({ ...s, labels: ['DRAFT'] }))
    expect(
      mapGmailMessage({
        conn: CONN,
        resource: draft.resource,
        openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array>,
      }),
    ).toEqual({ skip: 'draft' })
    const bare = gmailFixture('plain')
    delete bare.resource.payload
    expect(
      mapGmailMessage({
        conn: CONN,
        resource: bare.resource,
        openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array>,
      }),
    ).toEqual({ skip: 'no_payload' })
  })

  it('a message without a From keeps no from participant (the pipeline skips it as unsupported_sender)', () => {
    const { out } = map('plain', (s) => ({ ...s, headers: s.headers.filter(([k]) => k !== 'From') }))
    expect(out.facts.participants.some((p) => p.role === 'from')).toBe(false)
  })
})

describe('headers: RFC 2047 words, quoting, roles', () => {
  it('decodes encoded words in Subject and display names (B and Q, UTF-8 and ISO-8859-1), joining adjacent words', () => {
    const { out } = map('nonAscii')
    expect(out.facts.subject).toBe('Grüße aus Zürich ✓')
    expect(out.facts.participants).toEqual([
      { kind: 'email', value: 'jorg@bucher.test', name: 'Jörg Müller', role: 'from' },
      { kind: 'email', value: 'jane@acme.test', name: 'Doe, Jane', role: 'to' },
      { kind: 'email', value: MAILBOX, role: 'to' },
      { kind: 'email', value: 'andre@acme.test', name: 'André', role: 'cc' },
      { kind: 'email', value: 'hidden@acme.test', role: 'bcc' },
    ])
    expect(out.message.author.fullName).toBe('Jörg Müller')
  })

  it('a message without a Subject has a null subject', () => {
    expect(
      map('plain', (s) => ({ ...s, headers: s.headers.filter(([k]) => k !== 'Subject') })).out.facts.subject,
    ).toBeNull()
  })
})

describe('content', () => {
  it('uses the text part when there is no HTML part, soft line breaks kept', () => {
    expect(md('plain')).toBe('Hello Owner,\n\nPlease see below.\nThanks\n')
  })

  it('prefers the HTML part over the text part, and drops head and style', () => {
    const text = md('htmlOnly')
    expect(text).toBe('# Title\n\nSome *emphasis* and **strong** with [a link](https://example.test/x).\n\n> quoted\n')
    expect(text).not.toContain('p{}')
  })

  it('multipart/alternative: the HTML wins and its table survives as a GFM table', () => {
    const text = md('alternativeTable')
    expect(text).not.toContain('PLAIN VERSION')
    expect(text).toBe(
      '# Quarterly\n\n| Item    | Qty |\n| ------- | --- |\n| Widgets | 3   |\n| Gadgets | 5   |\n\nThanks, **Jane**\n',
    )
  })

  it('the preview is the plain text, collapsed', () => {
    const { out } = map('alternativeTable')
    expect(messagePreview(out.message, 'message')).toBe('Quarterly Item Qty Widgets 3 Gadgets 5 Thanks, Jane')
  })

  it('decodes a body in its declared charset', () => {
    const built = gmailFixture('plain', (s) => ({ ...s, payload: { mimeType: 'text/plain', text: 'x' } }))
    built.resource.payload!.body!.data = toBase64Url(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))
    const ct = built.resource.payload!.headers!.find((h) => h.name === 'Content-Type')!
    ct.value = 'text/plain; charset=ISO-8859-1'
    const out = mapGmailMessage({
      conn: CONN,
      resource: built.resource,
      openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array>,
    }) as ChannelMessage
    expect(stringifyMarkdown(out.message.formatted)).toBe('café\n')
  })
})

describe('attachments', () => {
  it('lists an attachment with its metadata and a fetch handle, never its bytes', () => {
    const { out } = map('attachment')
    expect(out.message.attachments).toEqual([
      {
        type: 'file',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 300,
        fetchMetadata: { message_id: 'with-attachment', attachment_id: 'att-pdf', size: '300' },
      },
    ])
    expect(out.facts.attachments).toEqual([{ position: 0, inline: false, content_id: null }])
    expect(md('attachment')).toBe('Report attached\n')
  })

  it('an inline image is an attachment with its content id, and the HTML body keeps its alt text, not the cid URL ([[AGT588]] D3)', () => {
    const { out } = map('inlineImage')
    expect(out.message.attachments).toEqual([
      {
        type: 'image',
        name: 'logo.png',
        mimeType: 'image/png',
        size: 40,
        fetchMetadata: { message_id: 'inline-image', attachment_id: 'att-logo', size: '40' },
      },
    ])
    expect(out.facts.attachments).toEqual([{ position: 0, inline: true, content_id: 'logo1@acme.test' }])
    expect(md('inlineImage')).toBe('Logo: logo\n')
  })

  it('declares the size the part declares, even when it is wrong', () => {
    const { out } = map('attachment', (s) => ({
      ...s,
      payload: { ...s.payload, parts: s.payload.parts!.map((p) => (p.bytes ? { ...p, declaredSize: 999 } : p)) },
    }))
    expect(out.message.attachments[0]!.size).toBe(999)
    expect(out.message.attachments[0]!.fetchMetadata!.size).toBe('999')
  })
})

describe('raw', () => {
  it('is lazy: mapping opens nothing, the size is unknown, and open() requests the stream once', async () => {
    const { out, opened } = map('plain')
    expect(opened).toBe(0)
    expect(out.raw).toMatchObject({ ext: 'eml', content_type: 'message/rfc822', size: null })
    const stream = await out.raw.open()
    expect(stream).toBeInstanceOf(ReadableStream)
  })
})

// [[CORE571]] D1, D4: bounded parse and bounded MIME walk. One poison email must not stop a mailbox's capture.
const depthOf = (node: { children?: unknown[] }): number => {
  let max = 0
  const stack: Array<{ n: { children?: unknown[] }; d: number }> = [{ n: node, d: 0 }]
  while (stack.length > 0) {
    const { n, d } = stack.pop()!
    max = Math.max(max, d)
    for (const c of n.children ?? []) stack.push({ n: c as { children?: unknown[] }, d: d + 1 })
  }
  return max
}
const deepHtml = (levels: number, inner: string): string =>
  `<html><body>${'<div>'.repeat(levels)}${inner}${'</div>'.repeat(levels)}</body></html>`
const mapDeep = (html: string): ChannelMessage =>
  map('htmlOnly', (s) => ({ ...s, payload: { ...s.payload, text: html } })).out

describe('deep HTML is bounded, not rejected (CORE571 D1)', () => {
  for (const levels of [5_000, 50_000]) {
    it(`a body nested ${levels} levels deep maps and keeps its innermost text`, () => {
      const out = mapDeep(deepHtml(levels, '<p>innermost words</p>'))
      expect(out.message.text).toContain('innermost words')
      expect(stringifyMarkdown(out.message.formatted)).toContain('innermost words')
      expect(depthOf(out.message.formatted as never)).toBeLessThanOrEqual(256)
    })
  }

  it('text beside nested elements past the bound keeps its document order', () => {
    const html = `<html><body>${'<div>'.repeat(400)}one<span>two</span>three${'</div>'.repeat(400)}</body></html>`
    expect(mapDeep(html).message.text.replace(/\s+/g, '')).toBe('onetwothree')
  })

  it('both sides of the bound: structure kept at element depth 256, flattened at 257', () => {
    // html > body > N divs: the innermost div is at element depth N + 2, its blockquote child at N + 3.
    const has = (m: ChannelMessage) => stringifyMarkdown(m.message.formatted).includes('> marker')
    const atBound = mapDeep(deepHtml(253, '<blockquote>marker</blockquote>'))
    const pastBound = mapDeep(deepHtml(254, '<blockquote>marker</blockquote>'))
    expect(has(atBound)).toBe(true)
    expect(has(pastBound)).toBe(false)
    expect(pastBound.message.text).toContain('marker')
  })
})

describe('deep MIME parts are bounded (CORE571 D4)', () => {
  const nest = (levels: number, leaf: GmailMessagePart): GmailMessagePart => {
    let part = leaf
    for (let i = 0; i < levels; i++)
      part = { partId: '', mimeType: 'multipart/mixed', filename: '', body: { size: 0 }, parts: [part] }
    return part
  }
  const text = (data: string): GmailMessagePart => ({
    partId: '0',
    mimeType: 'text/plain',
    filename: '',
    body: { size: 1, data: toBase64Url(new TextEncoder().encode(data)) },
  })
  const att = (id: string): GmailMessagePart => ({
    partId: '1',
    mimeType: 'application/pdf',
    filename: `${id}.pdf`,
    body: { size: 1, attachmentId: id },
  })
  const mapParts = (payload: GmailMessagePart): ChannelMessage => {
    const base = gmailFixture('plain').resource
    const out = mapGmailMessage({
      conn: CONN,
      resource: { ...base, payload: { ...payload, headers: base.payload!.headers } },
      openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array>,
    })
    if ('skip' in out) throw new Error(`skipped: ${out.skip}`)
    return out
  }

  it('keeps a body and an attachment under 32 multipart levels and nothing under 33', () => {
    // `nest(n, leaf)` wraps the leaf in n multipart parts, the payload being level 1.
    const top = (...parts: GmailMessagePart[]): GmailMessagePart => ({ ...nest(1, text('x')), parts })
    const out = mapParts(
      top(
        nest(31, text('at-bound body')),
        nest(31, att('at-bound')),
        nest(32, text('past-bound body')),
        nest(32, att('past-bound')),
      ),
    )
    expect(out.message.text).toContain('at-bound body')
    expect(out.message.text).not.toContain('past-bound body')
    expect(out.facts.attachments).toHaveLength(1)
    expect(out.message.attachments.map((a) => a.name)).toEqual(['at-bound.pdf'])
  })

  it('a resource nested 5,000 levels deep does not throw', () => {
    const out = mapParts(nest(5_000, text('buried')))
    expect(out.message.text).not.toContain('buried')
  })
})
