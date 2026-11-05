// Test-only ([[CHN5]] D35, D47). Synthetic Gmail messages built to the documented `users.messages.get` shape, each from one part
// tree that yields BOTH the `format=full` resource and the RFC 822 original, and `FakeGmail`, a `GmailClient` over them that serves
// `format=raw` and attachment bodies in Gmail's wire form (JSON with one base64url member) in chunks it can vary. Web APIs only: the
// workerd smoke bundles this file. Not in the production barrel.
import { GmailApiError, type GmailClient } from '../channels/gmail/client.js'
import type { GmailMessagePart, GmailMessageResource, GmailProfile, GmailSendAs } from '../channels/gmail/types.js'

const enc = new TextEncoder()

/** base64url without padding. The slice length is a multiple of 3 so the pieces concatenate. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  const SLICE = 3 * 8192
  for (let at = 0; at < bytes.byteLength; at += SLICE) {
    let bin = ''
    for (const b of bytes.subarray(at, at + SLICE)) bin += String.fromCharCode(b)
    out += btoa(bin)
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface PartSpec {
  mimeType: string
  charset?: string
  /** Extra headers of this part (Content-Disposition, Content-ID ...). */
  headers?: Array<[string, string]>
  /** A body part's text, UTF-8. */
  text?: string
  /** An attachment's bytes, served through `getAttachment` under `attachmentId`. */
  bytes?: Uint8Array
  filename?: string
  attachmentId?: string
  /** What `body.size` declares (default: the byte length). */
  declaredSize?: number
  parts?: PartSpec[]
}

export interface MessageSpec {
  id: string
  threadId?: string
  labels?: string[]
  /** Epoch ms. */
  internalDate?: number
  /** The message headers in order (values as they appear on the wire, RFC 2047 words included). */
  headers: Array<[string, string]>
  payload: PartSpec
  /** Serve these bytes as the `format=raw` original instead of the generated RFC 822. */
  rawOverride?: Uint8Array
}

export interface BuiltGmailMessage {
  resource: GmailMessageResource
  rfc822: Uint8Array
  /** Attachment bytes by attachment id. */
  attachments: Map<string, Uint8Array>
}

export function buildGmailMessage(spec: MessageSpec): BuiltGmailMessage {
  const attachments = new Map<string, Uint8Array>()
  let partCounter = 0
  const contentType = (p: PartSpec, boundary?: string): string =>
    `${p.mimeType}${p.charset || p.text !== undefined ? `; charset=${p.charset ?? 'UTF-8'}` : ''}${boundary ? `; boundary="${boundary}"` : ''}${p.filename ? `; name="${p.filename}"` : ''}`
  const toPart = (p: PartSpec, extra: Array<[string, string]> = [], top = false): GmailMessagePart => {
    const partId = top ? '' : String(partCounter++)
    const headers: Array<[string, string]> = [...extra, ['Content-Type', contentType(p, p.parts ? `b-${p.mimeType.length}` : undefined)], ...(p.headers ?? [])]
    const body: GmailMessagePart['body'] = { size: 0 }
    if (p.bytes) {
      const id = p.attachmentId ?? `att-${spec.id}-${partCounter}`
      attachments.set(id, p.bytes)
      body.attachmentId = id
      body.size = p.declaredSize ?? p.bytes.byteLength
    } else if (p.text !== undefined) {
      const bytes = enc.encode(p.text)
      body.data = toBase64Url(bytes)
      body.size = p.declaredSize ?? bytes.byteLength
    }
    return {
      partId,
      mimeType: p.mimeType,
      filename: p.filename ?? '',
      headers: headers.map(([name, value]) => ({ name, value })),
      body,
      ...(p.parts ? { parts: p.parts.map((c) => toPart(c)) } : {}),
    }
  }
  const messageHeaders: Array<[string, string]> = [...spec.headers, ['MIME-Version', '1.0']]
  const payload = toPart(spec.payload, messageHeaders, true)

  // RFC 822 from the same tree: headers, a blank line, the body (UTF-8 8bit text, base64 attachments, multipart boundaries).
  const serialise = (p: PartSpec, extra: Array<[string, string]>): string => {
    const boundary = p.parts ? `b-${p.mimeType.length}` : undefined
    const lines = [...extra, ['Content-Type', contentType(p, boundary)], ...(p.headers ?? [])].map(([k, v]) => `${k}: ${v}`)
    if (p.bytes) lines.push('Content-Transfer-Encoding: base64')
    else if (p.text !== undefined) lines.push('Content-Transfer-Encoding: 8bit')
    let body = ''
    if (p.parts) {
      body = p.parts.map((c) => `--${boundary}\r\n${serialise(c, [])}\r\n`).join('') + `--${boundary}--`
    } else if (p.bytes) {
      body = (btoa(Array.from(p.bytes, (b) => String.fromCharCode(b)).join('')).match(/.{1,76}/g) ?? []).join('\r\n')
    } else body = (p.text ?? '').replace(/\r?\n/g, '\r\n')
    return `${lines.join('\r\n')}\r\n\r\n${body}`
  }
  const rfc822 = spec.rawOverride ?? enc.encode(serialise(spec.payload, messageHeaders))
  const resource: GmailMessageResource = {
    id: spec.id,
    threadId: spec.threadId ?? `t-${spec.id}`,
    labelIds: spec.labels ?? ['INBOX'],
    snippet: 'a snippet',
    historyId: '1000',
    internalDate: String(spec.internalDate ?? Date.parse('2026-10-22T09:00:00.000Z')),
    sizeEstimate: rfc822.byteLength,
    payload,
  }
  return { resource, rfc822, attachments }
}

const wireOf = (members: Array<[string, unknown]>): Uint8Array => enc.encode(`{${members.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`)

/** Gmail's `format=raw` body: a message resource whose `snippet` is hostile to a naive scanner, then the base64url `raw` member. */
export function rawWire(msg: BuiltGmailMessage): Uint8Array {
  const { resource } = msg
  return wireOf([
    ['id', resource.id],
    ['threadId', resource.threadId],
    ['labelIds', resource.labelIds],
    ['snippet', 'she said "raw":"AAAA" and \\"raw\\": done'],
    ['historyId', resource.historyId],
    ['internalDate', resource.internalDate],
    ['sizeEstimate', resource.sizeEstimate],
    ['raw', toBase64Url(msg.rfc822)],
  ])
}
export const attachmentWire = (bytes: Uint8Array): Uint8Array => wireOf([['size', bytes.byteLength], ['data', toBase64Url(bytes)]])

/** A lazily pulled stream over `bytes`, cut into chunks of `size(index)` bytes. */
export function chunkedStream(bytes: Uint8Array, size: number | ((index: number) => number)): ReadableStream<Uint8Array> {
  let at = 0
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close()
      const n = Math.max(1, typeof size === 'number' ? size : size(index++))
      controller.enqueue(bytes.slice(at, at + n))
      at += n
    },
  })
}

export type FakeGmailCall = { op: 'full' | 'raw' | 'attachment'; messageId: string; attachmentId?: string }

export class FakeGmail implements GmailClient {
  /** Every call, in order. */
  readonly calls: FakeGmailCall[] = []
  private readonly messages = new Map<string, BuiltGmailMessage>()
  private readonly failures: Array<{ match: (c: FakeGmailCall) => boolean; error: Error }> = []
  /** Chunk size of every streamed body (default 4096); a function varies it per chunk. */
  chunk: number | ((index: number) => number)

  /** The account calls (CHN140), in order: `profile` and `send_as`. Kept apart from `calls`, which are per message. */
  readonly accountCalls: Array<'profile' | 'send_as'> = []
  profile: GmailProfile
  sendAs: GmailSendAs[]

  constructor(messages: Iterable<BuiltGmailMessage> = [], opts: { chunk?: number | ((index: number) => number); profile?: GmailProfile; sendAs?: GmailSendAs[] } = {}) {
    this.chunk = opts.chunk ?? 4096
    this.profile = opts.profile ?? { emailAddress: 'owner@vault.test', historyId: '1' }
    this.sendAs = opts.sendAs ?? [{ sendAsEmail: this.profile.emailAddress, isPrimary: true }]
    for (const m of messages) this.add(m)
  }

  add(message: BuiltGmailMessage): this {
    this.messages.set(message.resource.id, message)
    return this
  }

  /** Makes calls matching `match` throw `error`. */
  failWhen(match: (c: FakeGmailCall) => boolean, error: Error): this {
    this.failures.push({ match, error })
    return this
  }

  private enter(call: FakeGmailCall): BuiltGmailMessage {
    this.calls.push(call)
    const failure = this.failures.find((f) => f.match(call))
    if (failure) throw failure.error
    const message = this.messages.get(call.messageId)
    if (!message) throw new GmailApiError({ status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' })
    return message
  }

  async getProfile(): Promise<GmailProfile> {
    this.accountCalls.push('profile')
    return structuredClone(this.profile)
  }
  async listSendAs(): Promise<GmailSendAs[]> {
    this.accountCalls.push('send_as')
    return structuredClone(this.sendAs)
  }
  async getMessageFull(messageId: string): Promise<GmailMessageResource> {
    return structuredClone(this.enter({ op: 'full', messageId }).resource)
  }
  async getMessageRaw(messageId: string): Promise<ReadableStream<Uint8Array>> {
    return chunkedStream(rawWire(this.enter({ op: 'raw', messageId })), this.chunk)
  }
  async getAttachment(messageId: string, attachmentId: string): Promise<ReadableStream<Uint8Array>> {
    const message = this.enter({ op: 'attachment', messageId, attachmentId })
    const bytes = message.attachments.get(attachmentId)
    if (!bytes) throw new GmailApiError({ status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' })
    return chunkedStream(attachmentWire(bytes), this.chunk)
  }
}
