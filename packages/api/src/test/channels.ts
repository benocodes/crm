// Test-only ([[CORE69]] D13). A `ChannelPort` over scripted messages and attachment bytes. It records every `open()` and
// every `fetchAttachment` call, which is how a test proves an existing message fetched nothing. Not in the production barrel.
import { toPlainText } from '../channels/markdown.js'
import { parseMarkdown } from './markdown.js'
import { AttachmentFetchError, type ChannelMessage, type ChannelPort, type ConnectionRef, type ParticipantRole } from '../channels/port.js'

export interface FakeAttachmentScript {
  name?: string
  mimeType?: string
  type?: 'image' | 'file' | 'video' | 'audio'
  bytes: Uint8Array
  /** The size the message declares; `null` omits it (default: the byte length). */
  declaredSize?: number | null
  /** The size `fetchAttachment` reports (default: the byte length). Different from the byte length means a length mismatch. */
  reportedSize?: number
  /** `fetchAttachment` throws this instead. */
  fail?: Error
  inline?: boolean
  contentId?: string | null
}
export interface FakeRawScript {
  ext?: 'eml' | 'json'
  /** The original's bytes. */
  bytes?: Uint8Array
  /** `'unknown'`: `size` is null and `open()` returns a stream; a number is declared as is; default: the byte length, a resolved array. */
  size?: number | 'unknown'
  /** Deliver the bytes as a stream even with a known size. */
  stream?: boolean
}
export interface FakeMessageScript {
  providerMessageId: string
  /** The port answers `{ skip }` with this reason. */
  skip?: string
  kind?: 'message' | 'reaction'
  externalId?: string
  inReplyTo?: string | null
  threadHints?: string[]
  providerThreadId?: string
  occurredAt?: string
  subject?: string | null
  /** The message body as markdown (default: a one-line text). A reaction's `text` is its emoji. */
  markdown?: string
  from?: string
  to?: string[]
  cc?: string[]
  /** Replaces the computed participants altogether. */
  participants?: Array<{ kind: 'email' | 'phone'; value: string; name?: string; role: ParticipantRole }>
  sentByConnection?: boolean
  attachments?: FakeAttachmentScript[]
  raw?: FakeRawScript
}

const encoder = new TextEncoder()
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([bytes.slice()]).stream() as ReadableStream<Uint8Array>

export class FakeChannel implements ChannelPort<ConnectionRef> {
  readonly channel = 'email' as const
  /** Provider message ids whose `raw.open()` was called, in call order. */
  readonly opens: string[] = []
  /** Every `fetchAttachment` call, in order. */
  readonly fetches: Array<{ conn: ConnectionRef; metadata: Record<string, string> }> = []
  /** Provider message ids passed to `readMessage`, in call order. */
  readonly reads: string[] = []
  private readonly scripts = new Map<string, FakeMessageScript>()

  constructor(scripts: readonly FakeMessageScript[] = []) {
    for (const s of scripts) this.add(s)
  }

  add(script: FakeMessageScript): this {
    this.scripts.set(script.providerMessageId, script)
    return this
  }

  async readMessage(_conn: ConnectionRef, providerMessageId: string): Promise<ChannelMessage | { skip: string }> {
    this.reads.push(providerMessageId)
    const s = this.scripts.get(providerMessageId)
    if (!s) throw new Error(`FakeChannel: no script for ${providerMessageId}`)
    if (s.skip !== undefined) return { skip: s.skip }
    const kind = s.kind ?? 'message'
    const externalId = s.externalId ?? `<${s.providerMessageId}@fake.test>`
    const markdown = s.markdown ?? `Hello from ${s.providerMessageId}`
    const formatted = parseMarkdown(kind === 'reaction' ? '' : markdown)
    const from = s.from ?? 'jane@acme.test'
    const attachments = s.attachments ?? []
    const rawBytes = s.raw?.bytes ?? encoder.encode(`From: ${from}\r\nMessage-ID: ${externalId}\r\n\r\n${markdown}`)
    const rawSize = s.raw?.size === 'unknown' ? null : (s.raw?.size ?? rawBytes.byteLength)
    const asStream = s.raw?.stream === true || rawSize === null
    return {
      message: {
        id: `fake:${s.providerMessageId}`,
        threadId: `fake:${s.providerThreadId ?? `t-${s.providerMessageId}`}`,
        text: kind === 'reaction' ? markdown : toPlainText(formatted),
        formatted,
        author: { userId: from, userName: from, fullName: from.split('@')[0]!, isBot: false, isMe: false },
        metadata: { dateSent: new Date(s.occurredAt ?? '2026-10-22T09:00:00.000Z'), edited: false },
        attachments: attachments.map((a, i) => ({
          type: a.type ?? 'file',
          ...(a.name === undefined ? {} : { name: a.name }),
          ...(a.mimeType === undefined ? {} : { mimeType: a.mimeType }),
          ...(a.declaredSize === null ? {} : { size: a.declaredSize ?? a.bytes.byteLength }),
          fetchMetadata: { key: `${s.providerMessageId}:${i}` },
        })),
      },
      facts: {
        channel: 'email',
        kind,
        external_id: externalId,
        in_reply_to: s.inReplyTo ?? null,
        thread_hints: s.threadHints ?? [],
        provider_message_id: s.providerMessageId,
        provider_thread_id: s.providerThreadId ?? `t-${s.providerMessageId}`,
        occurred_at: s.occurredAt ?? '2026-10-22T09:00:00.000Z',
        subject: s.subject === undefined ? `Subject ${s.providerMessageId}` : s.subject,
        participants:
          s.participants ??
          [
            { kind: 'email', value: from, name: from.split('@')[0]!, role: 'from' },
            ...(s.to ?? ['owner@vibase.test']).map((value) => ({ kind: 'email' as const, value, role: 'to' as const })),
            ...(s.cc ?? []).map((value) => ({ kind: 'email' as const, value, role: 'cc' as const })),
          ],
        sent_by_connection: s.sentByConnection ?? false,
        attachments: attachments.map((a, position) => ({ position, inline: a.inline ?? false, content_id: a.contentId ?? null })),
      },
      raw: {
        ext: s.raw?.ext ?? 'eml',
        content_type: s.raw?.ext === 'json' ? 'application/json' : 'message/rfc822',
        size: rawSize,
        open: async () => {
          this.opens.push(s.providerMessageId)
          return asStream ? streamOf(rawBytes) : rawBytes.slice()
        },
      },
    }
  }

  async fetchAttachment(conn: ConnectionRef, fetchMetadata: Record<string, string>): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    this.fetches.push({ conn, metadata: fetchMetadata })
    const [id, index] = (fetchMetadata.key ?? '').split(':') as [string, string]
    const a = this.scripts.get(id)?.attachments?.[Number(index)]
    if (!a) throw new Error(`FakeChannel: no attachment ${fetchMetadata.key}`)
    if (a.fail) throw a.fail
    return { body: streamOf(a.bytes), size: a.reportedSize ?? a.bytes.byteLength }
  }
}

/** Deterministic bytes of a given length. */
export const bytesOf = (length: number, seed = 1): Uint8Array => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 255)

/** One message per scripted case of D13, with the ids the pipeline tests name. */
export function standardScripts(): Record<string, FakeMessageScript> {
  const many = Array.from({ length: 101 }, (_, i) => `r${i}@bulk.test`)
  return {
    plain: { providerMessageId: 'plain' },
    withAttachment: { providerMessageId: 'with-attachment', attachments: [{ name: 'a.pdf', mimeType: 'application/pdf', bytes: bytesOf(300) }] },
    reaction: { providerMessageId: 'reaction', kind: 'reaction', markdown: '👍', inReplyTo: '<plain@fake.test>' },
    reply: { providerMessageId: 'reply', inReplyTo: '<parent@fake.test>', threadHints: ['<parent@fake.test>'], occurredAt: '2026-10-22T09:05:00.000Z', providerThreadId: 't-conversation' },
    parent: { providerMessageId: 'parent', occurredAt: '2026-10-22T09:00:00.000Z', providerThreadId: 't-conversation' },
    nonAscii: { providerMessageId: 'non-ascii', participants: [{ kind: 'email', value: 'jane@acme.test', role: 'from' }, { kind: 'email', value: 'jörg@bücher.test', role: 'to' }, { kind: 'email', value: 'ok@vibase.test', role: 'to' }] },
    noSender: { providerMessageId: 'no-sender', participants: [{ kind: 'email', value: 'jörg@bücher.test', role: 'from' }, { kind: 'email', value: 'ok@vibase.test', role: 'to' }] },
    overCap: { providerMessageId: 'over-cap', to: many },
    failingAttachment: { providerMessageId: 'failing-attachment', attachments: [{ name: 'gone.pdf', bytes: bytesOf(10), fail: new AttachmentFetchError('not_found', 'https://mail.example/secret-token') }] },
    brokenAttachment: { providerMessageId: 'broken-attachment', attachments: [{ name: 'x.bin', bytes: bytesOf(10), fail: new Error('socket hang up for https://mail.example/token=abc') }] },
    hugeAttachment: { providerMessageId: 'huge-attachment', attachments: [{ name: 'big.bin', bytes: bytesOf(8), declaredSize: 60 * 1024 * 1024 }] },
    hugeFetched: { providerMessageId: 'huge-fetched', attachments: [{ name: 'big2.bin', bytes: bytesOf(8), declaredSize: null, reportedSize: 60 * 1024 * 1024 }] },
    mismatch: { providerMessageId: 'mismatch', attachments: [{ name: 'liar.bin', bytes: bytesOf(100), reportedSize: 120 }] },
    bigOriginal: { providerMessageId: 'big-original', raw: { size: 'unknown', bytes: bytesOf(5 * 1024 * 1024 + 123) } },
    skipped: { providerMessageId: 'skipped', skip: 'draft' },
  }
}
