import { describe, expect, it } from 'vitest'
import { AttachmentFetchError, ChannelThrottledError, type ChannelMessage } from '../port.js'
import { FakeGmail } from '../../test/gmail.js'
import { gmailFixture, MAILBOX } from '../../test/gmail-fixtures.js'
import { GmailApiError } from './client.js'
import { GmailChannel } from './channel.js'
import type { GmailConnection } from './mapper.js'

// [[CHN5]] D24, D25, D16, [[CORE69]] D3: GmailChannel over FakeGmail.
const CONN: GmailConnection = { id: 'conn-1', mailbox: MAILBOX }
const bytesOfStream = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => new Uint8Array(await new Response(s).arrayBuffer())
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))

describe('readMessage', () => {
  it('requests format=full only, and maps it', async () => {
    const gmail = new FakeGmail([gmailFixture('attachment')])
    const out = (await new GmailChannel(gmail).readMessage(CONN, 'with-attachment')) as ChannelMessage
    expect(out.facts.provider_message_id).toBe('with-attachment')
    expect(gmail.calls).toEqual([{ op: 'full', messageId: 'with-attachment' }])
  })

  it('raw is lazy: opening it requests format=raw once, and the stream is the decoded RFC 822 original', async () => {
    const built = gmailFixture('attachment')
    const gmail = new FakeGmail([built], { chunk: (i) => 1 + ((i * 37) % 53) })
    const out = (await new GmailChannel(gmail).readMessage(CONN, 'with-attachment')) as ChannelMessage
    expect(out.raw.size).toBeNull()
    expect(gmail.calls.map((c) => c.op)).toEqual(['full'])
    const opened = await out.raw.open()
    expect(opened).toBeInstanceOf(ReadableStream)
    expect(gmail.calls.map((c) => c.op)).toEqual(['full', 'raw'])
    expect(same(await bytesOfStream(opened as ReadableStream<Uint8Array>), built.rfc822)).toBe(true)
  })

  it('a message that is gone (404) is a skip', async () => {
    expect(await new GmailChannel(new FakeGmail()).readMessage(CONN, 'nope')).toEqual({ skip: 'not_found' })
  })

  it('any other failure throws for the caller to classify, status intact', async () => {
    const gmail = new FakeGmail([gmailFixture('plain')]).failWhen(() => true, new GmailApiError({ status: 429, reason: 'rateLimitExceeded', retryAfterSeconds: 7 }))
    await expect(new GmailChannel(gmail).readMessage(CONN, 'plain')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 })
  })

  it('a draft is a skip from the mapper', async () => {
    const gmail = new FakeGmail([gmailFixture('plain', (s) => ({ ...s, labels: ['DRAFT'] }))])
    expect(await new GmailChannel(gmail).readMessage(CONN, 'plain')).toEqual({ skip: 'draft' })
  })
})

describe('fetchAttachment', () => {
  const setup = async () => {
    const built = gmailFixture('attachment')
    const gmail = new FakeGmail([built], { chunk: 33 })
    const channel = new GmailChannel(gmail)
    const out = (await channel.readMessage(CONN, 'with-attachment')) as ChannelMessage
    return { built, gmail, channel, md: out.message.attachments[0]!.fetchMetadata! }
  }

  it('returns the decoded bytes with the declared size', async () => {
    const { built, gmail, channel, md } = await setup()
    const got = await channel.fetchAttachment(CONN, md)
    expect(got.size).toBe(300)
    expect(same(await bytesOfStream(got.body), built.attachments.get('att-pdf')!)).toBe(true)
    expect(gmail.calls.at(-1)).toEqual({ op: 'attachment', messageId: 'with-attachment', attachmentId: 'att-pdf' })
  })

  it.each([
    [404, 'not_found'],
    [403, 'access_denied'],
    [401, 'access_denied'],
    [500, 'http_500'],
  ])('a Gmail %i is an AttachmentFetchError with the short code %s and no provider text', async (status, code) => {
    const { gmail, channel, md } = await setup()
    gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status, reason: 'secret reason text' }))
    const err = await channel.fetchAttachment(CONN, md).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachmentFetchError)
    expect((err as AttachmentFetchError).code).toBe(code)
    expect((err as AttachmentFetchError).message).toBe(code)
  })

  it('a 429 is not an attachment failure: it is a ChannelThrottledError carrying Retry-After ([[CHN5]] D83)', async () => {
    const { gmail, channel, md } = await setup()
    gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status: 429, retryAfter: '8', retryAfterSeconds: 8 }))
    const err = await channel.fetchAttachment(CONN, md).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChannelThrottledError)
    expect((err as ChannelThrottledError).retryAfterSeconds).toBe(8)
  })

  it('a non-Gmail failure is fetch_failed', async () => {
    const { gmail, channel, md } = await setup()
    gmail.failWhen((c) => c.op === 'attachment', new Error('socket hang up https://x?token=abc'))
    const err = (await channel.fetchAttachment(CONN, md).catch((e: unknown) => e)) as AttachmentFetchError
    expect(err).toMatchObject({ code: 'fetch_failed', message: 'fetch_failed' })
  })

  it('metadata without an attachment id or a size is bad_metadata, and nothing is requested', async () => {
    const { gmail, channel } = await setup()
    const before = gmail.calls.length
    for (const md of [{}, { message_id: 'm', attachment_id: 'a' }, { message_id: 'm', attachment_id: 'a', size: 'x' }] as Array<Record<string, string>>) {
      expect(await channel.fetchAttachment(CONN, md).catch((e: unknown) => e)).toMatchObject({ code: 'bad_metadata' })
    }
    expect(gmail.calls).toHaveLength(before)
  })

  it('a corrupt body errors the returned stream', async () => {
    const { gmail, channel, md } = await setup()
    gmail.getAttachment = async () => new Blob(['{"data":"ab+/cd"}']).stream() as ReadableStream<Uint8Array>
    const got = await channel.fetchAttachment(CONN, md)
    await expect(bytesOfStream(got.body)).rejects.toThrow()
  })
})
