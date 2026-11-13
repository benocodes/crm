import { stringifyMarkdown as chatStringify, toPlainText as chatPlain, parseMarkdown as chatParse } from 'chat'
import { parseMarkdown } from '../test/markdown.js'
import { stringifyMarkdown, toPlainText } from './markdown.js'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { messagePreview } from '../messaging/preview.js'
import { FakeChannel, standardScripts } from '../test/channels.js'
import type { ChannelMessage, VibaseMessage } from './port.js'
import { allGmailFixtures, FIXTURE_NAMES, MAILBOX, type FixtureName } from '../test/gmail-fixtures.js'
import { mapGmailMessage } from './gmail/mapper.js'

// [[CORE69]] D14, [[CORE25]] D15. The vault depends on `chat` for the SHAPE of `Message` and two functions. A bump that renames or
// retypes a picked field must fail loudly: half one at `pnpm -r typecheck`, half two here. [[CHN5]] adds the Gmail mapper's
// recorded fixtures to the same table.

// ---- half one: the type-level contract ------------------------------------------------------------------------------------
// A mapper's output must be assignable to `VibaseMessage`. This fixture mapper stands for every channel's; change the type of
// one picked field in it (or in `chat`) and `tsc` stops here.
function fixtureMapper(): VibaseMessage {
  return {
    id: 'gmail:abc:1',
    threadId: 'gmail:abc:t1',
    text: 'hello',
    formatted: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hello' }] }] },
    author: { userId: 'u', userName: 'u', fullName: 'U', isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [{ type: 'file', name: 'a.pdf', mimeType: 'application/pdf', size: 3, fetchMetadata: { id: '1' } }],
  }
}
it('a mapper output is assignable to VibaseMessage, and the port carries it unchanged', () => {
  expectTypeOf(fixtureMapper()).toExtend<VibaseMessage>()
  expectTypeOf<ChannelMessage['message']>().toEqualTypeOf<VibaseMessage>()
  expect(fixtureMapper().id).toBe('gmail:abc:1')
})

// ---- half two: fixtures through a zod schema and stored expectations ------------------------------------------------------
const messageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string(),
  formatted: z.object({ type: z.literal('root'), children: z.array(z.object({ type: z.string() }).loose()) }).loose(),
  author: z.object({ userId: z.string(), userName: z.string(), fullName: z.string(), isBot: z.union([z.boolean(), z.literal('unknown')]), isMe: z.boolean() }).strict(),
  metadata: z.object({ dateSent: z.date(), edited: z.boolean() }).loose(),
  attachments: z.array(
    z
      .object({ type: z.enum(['image', 'file', 'video', 'audio']), name: z.string().optional(), mimeType: z.string().optional(), size: z.number().int().nonnegative().optional(), fetchMetadata: z.record(z.string(), z.string()).optional() })
      .strict(),
  ),
})
const factsSchema = z.object({
  channel: z.literal('email'),
  kind: z.enum(['message', 'reaction']),
  external_id: z.string().min(1),
  in_reply_to: z.string().nullable(),
  thread_hints: z.array(z.string()).max(20),
  provider_message_id: z.string(),
  provider_thread_id: z.string(),
  occurred_at: z.iso.datetime(),
  subject: z.string().nullable(),
  participants: z.array(z.object({ kind: z.enum(['email', 'phone']), value: z.string(), name: z.string().optional(), role: z.enum(['from', 'to', 'cc', 'bcc']) })),
  sent_by_connection: z.boolean(),
  attachments: z.array(z.object({ position: z.number().int().nonnegative(), inline: z.boolean(), content_id: z.string().nullable() })),
})

/** Stored expectations: what `stringifyMarkdown(formatted)` and `messagePreview` must say for each fixture. */
const EXPECTED: Record<string, { markdown: string; preview: string }> = {
  plain: { markdown: 'Hello from plain\n', preview: 'Hello from plain' },
  'with-attachment': { markdown: 'Hello from with-attachment\n', preview: 'Hello from with-attachment' },
  reaction: { markdown: '', preview: '👍' },
  reply: { markdown: 'Hello from reply\n', preview: 'Hello from reply' },
  parent: { markdown: 'Hello from parent\n', preview: 'Hello from parent' },
  'non-ascii': { markdown: 'Hello from non-ascii\n', preview: 'Hello from non-ascii' },
}

describe('FakeChannel fixtures satisfy the port contract', () => {
  const scripts = standardScripts()
  const fake = new FakeChannel(Object.values(scripts))
  const ids = Object.values(scripts).filter((s) => s.skip === undefined).map((s) => s.providerMessageId)

  it.each(ids)('%s: message and facts match the schemas, and attachments line up', async (id) => {
    const out = (await fake.readMessage({ id: 'c' }, id)) as ChannelMessage
    expect(messageSchema.parse(out.message)).toBeTruthy()
    expect(factsSchema.parse(out.facts)).toBeTruthy()
    expect(out.facts.attachments).toHaveLength(out.message.attachments.length)
    for (const a of out.message.attachments) expect(a).not.toHaveProperty('data')
    for (const a of out.message.attachments) expect(a).not.toHaveProperty('fetchData')
  })

  it.each(Object.keys(EXPECTED))('%s: markdown and preview equal the stored expectation', async (id) => {
    const out = (await fake.readMessage({ id: 'c' }, id)) as ChannelMessage
    expect(stringifyMarkdown(out.message.formatted)).toBe(EXPECTED[id]!.markdown)
    expect(messagePreview(out.message, out.facts.kind)).toBe(EXPECTED[id]!.preview)
  })

  it('a skip is a plain reason', async () => {
    expect(await fake.readMessage({ id: 'c' }, 'skipped')).toEqual({ skip: 'draft' })
  })
})

// ---- the Gmail mapper's fixtures join the table ([[CHN5]] D35) ---------------------------------------------------------------
const GMAIL_EXPECTED: Record<FixtureName, { markdown: string; preview: string }> = {
  plain: { markdown: 'Hello Owner,\n\nPlease see below.\nThanks\n', preview: 'Hello Owner, Please see below. Thanks' },
  htmlOnly: { markdown: '# Title\n\nSome *emphasis* and **strong** with [a link](https://example.test/x).\n\n> quoted\n', preview: 'Title Some emphasis and strong with a link. quoted' },
  alternativeTable: {
    markdown: '# Quarterly\n\n| Item    | Qty |\n| ------- | --- |\n| Widgets | 3   |\n| Gadgets | 5   |\n\nThanks, **Jane**\n',
    preview: 'Quarterly Item Qty Widgets 3 Gadgets 5 Thanks, Jane',
  },
  inlineImage: { markdown: 'Logo: ![logo](cid:logo1@acme.test)\n', preview: 'Logo: logo' },
  attachment: { markdown: 'Report attached\n', preview: 'Report attached' },
  nonAscii: { markdown: 'Grüße ✓\n', preview: 'Grüße ✓' },
  noMessageId: { markdown: 'body without a Message-ID\n', preview: 'body without a Message-ID' },
  selfAddressed: { markdown: 'a note to myself\n', preview: 'a note to myself' },
  reply: { markdown: 'Re: hello\n', preview: 'Re: hello' },
}
describe('Gmail mapper fixtures satisfy the port contract', () => {
  const map = (name: FixtureName, fixtures = allGmailFixtures()): ChannelMessage => {
    const out = mapGmailMessage({ conn: { id: 'c', mailbox: MAILBOX }, resource: fixtures[name].resource, openRaw: async () => new Blob([]).stream() as ReadableStream<Uint8Array> })
    if ('skip' in out) throw new Error(out.skip)
    return out
  }
  it.each(FIXTURE_NAMES)('%s: message and facts match the schemas, attachments line up, no bytes inline', (name) => {
    const out = map(name)
    expect(messageSchema.parse(out.message)).toBeTruthy()
    expect(factsSchema.parse(out.facts)).toBeTruthy()
    expect(out.facts.attachments).toHaveLength(out.message.attachments.length)
    for (const a of out.message.attachments) expect(a).not.toHaveProperty('data')
  })
  it.each(FIXTURE_NAMES)('%s: markdown and preview equal the stored expectation', (name) => {
    const out = map(name)
    expect(stringifyMarkdown(out.message.formatted)).toBe(GMAIL_EXPECTED[name].markdown)
    expect(messagePreview(out.message, out.facts.kind)).toBe(GMAIL_EXPECTED[name].preview)
  })
  it('a changed fixture field changes the result (the expectations are not vacuous)', () => {
    const fixtures = allGmailFixtures()
    const part = fixtures.plain.resource.payload!
    part.body!.data = Buffer.from('Changed body').toString('base64url')
    expect(stringifyMarkdown(map('plain', fixtures).message.formatted)).not.toBe(GMAIL_EXPECTED.plain.markdown)
  })
})

// ---- parity half: the vendored markdown functions equal chat's own ([[CORE69]] D25) --------------------------------------------
// `chat` cannot load in the Worker, so its two functions are copied. This is the test that fails when a `chat` bump changes them.
const PARITY: Record<string, string> = {
  heading: '# Title\n\nSome *emphasis* and **strong** text.\n',
  'gfm table': '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n',
  strikethrough: 'keep ~~this~~ that\n',
  list: '- one\n- two\n  - nested\n\n1. first\n2. second\n',
  'hard break': 'line one  \nline two\\\nline three\n',
  'thematic break': 'above\n\n---\n\nbelow\n',
  'quote, code and link': '> quoted\n\n```ts\nconst a = 1\n```\n\n[site](https://example.test) and `code` ![img](https://example.test/i.png "t")\n',
  empty: '',
}
describe('vendored markdown functions equal chat 4.43.0', () => {
  it.each(Object.entries(PARITY))('%s', (_name, md) => {
    const ast = parseMarkdown(md)
    expect(ast).toEqual(chatParse(md))
    expect(stringifyMarkdown(ast)).toBe(chatStringify(ast))
    expect(toPlainText(ast)).toBe(chatPlain(ast))
  })
  it('the fixtures exercise the cases that separate toPlainText from mdast-util-to-string', () => {
    expect(toPlainText(parseMarkdown(PARITY['gfm table']!))).toBe('a\tb\n1\t2\n3\t4')
    expect(toPlainText(parseMarkdown(PARITY['hard break']!))).toContain('\n')
  })
})
