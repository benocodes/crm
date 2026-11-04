// Test-only ([[CORE69]] D22, [[CORE72]]). The messaging corpus of golden `messaging.json`, written by the real capture pipeline:
// `captureMessages` over a `FakeChannel` into the backend's object store, at golden ids and the golden seed instant. Nothing is
// inserted directly, so `body.md`, the blobs and every row are what production would write.
//
//   thread 1: m1 (a parent with a pdf and an inline png), m2 (the connection's reply with a text file, cc bob), m3 (a reaction)
//   thread 2: m4 (one message whose only attachment cannot be fetched: fetch_status failed, no file)
import { AttachmentFetchError } from '../../channels/port.js'
import { captureMessages, type PipelineContext } from '../../messaging/pipeline.js'
import { bytesOf, FakeChannel, type FakeMessageScript } from '../channels.js'
import { nodeStreams } from '../streams.js'

export const MESSAGING_SCOPES = ['messages:read', 'interactions:read', 'files:read'] as const

export const messagingCorpus = (): FakeMessageScript[] => [
  {
    providerMessageId: 'm1',
    providerThreadId: 't1',
    subject: 'Quarterly plan',
    occurredAt: '2026-10-22T07:10:00.000Z',
    markdown: '# Plan\n\nHello **world**, the numbers are attached.',
    from: 'jane@acme.test',
    attachments: [
      { name: 'plan.pdf', mimeType: 'application/pdf', bytes: bytesOf(300) },
      { name: 'logo.png', mimeType: 'image/png', type: 'image', inline: true, contentId: 'logo@fake.test', bytes: bytesOf(64, 7) },
    ],
  },
  {
    providerMessageId: 'm2',
    providerThreadId: 't1',
    subject: 'Re: Quarterly plan',
    occurredAt: '2026-10-22T07:20:00.000Z',
    inReplyTo: '<m1@fake.test>',
    threadHints: ['<m1@fake.test>'],
    markdown: 'Thanks, notes attached.',
    from: 'owner@vault.test',
    to: ['jane@acme.test'],
    cc: ['bob@acme.test'],
    sentByConnection: true,
    attachments: [{ name: 'notes.txt', mimeType: 'text/plain', bytes: bytesOf(48, 3) }],
  },
  { providerMessageId: 'm3', providerThreadId: 't1', kind: 'reaction', occurredAt: '2026-10-22T07:30:00.000Z', inReplyTo: '<m1@fake.test>', markdown: '👍', from: 'bob@acme.test' },
  {
    providerMessageId: 'm4',
    providerThreadId: 't2',
    subject: 'Invoice',
    occurredAt: '2026-10-22T07:40:00.000Z',
    markdown: 'See the invoice.',
    from: 'carol@other.test',
    attachments: [{ name: 'invoice.pdf', bytes: bytesOf(10), fail: new AttachmentFetchError('not_found', 'https://mail.example/secret') }],
  },
]

export async function seedMessaging(ctx: Omit<PipelineContext, 'streams'>): Promise<void> {
  const channel = new FakeChannel(messagingCorpus())
  await captureMessages({ ...ctx, streams: nodeStreams() }, channel, { id: '0190b2c4-0000-7000-8000-00000000f001' }, ['m1', 'm2', 'm3', 'm4'])
}
