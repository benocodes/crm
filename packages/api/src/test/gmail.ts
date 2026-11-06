// Test-only ([[CHN5]] D35, D47). Synthetic Gmail messages built to the documented `users.messages.get` shape, each from one part
// tree that yields BOTH the `format=full` resource and the RFC 822 original, and `FakeGmail`, a `GmailClient` over them that serves
// `format=raw` and attachment bodies in Gmail's wire form (JSON with one base64url member) in chunks it can vary. Web APIs only: the
// workerd smoke bundles this file. Not in the production barrel.
import { GmailApiError, parseHistoryList, parseMessageList, type GmailClient } from '../channels/gmail/client.js'
import type { GmailHistoryPage, GmailMessageList, GmailMessagePart, GmailMessageResource, GmailProfile, GmailSendAs } from '../channels/gmail/types.js'

const enc = new TextEncoder()

/** base64url, padded with `=` as Google pads every base64url member ([[CHN5]] D82 d). The slice length is a multiple of 3 so the pieces concatenate. */
export function toBase64Url(bytes: Uint8Array, pad = true): string {
  let out = ''
  const SLICE = 3 * 8192
  for (let at = 0; at < bytes.byteLength; at += SLICE) {
    let bin = ''
    for (const b of bytes.subarray(at, at + SLICE)) bin += String.fromCharCode(b)
    out += btoa(bin)
  }
  const url = out.replace(/\+/g, '-').replace(/\//g, '_')
  return pad ? url : url.replace(/=+$/, '')
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

/**
 * Gmail's error body for a scripted failure. The per-minute quota `403` is served as Google sent it to the real run ([[CHN5]] D82 g): `PERMISSION_DENIED`,
 * `errors[].reason: rateLimitExceeded` in domain `usageLimits`, and the `details[]` entries, with no `Retry-After` unless the failure carries one.
 */
export function errorBody(err: GmailApiError): Record<string, unknown> {
  if (err.status === 403 && err.reason === 'rateLimitExceeded') {
    const message = "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'."
    return {
      error: {
        code: 403,
        message,
        errors: [{ message, domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'googleapis.com',
            metadata: { consumer: 'projects/000000000000', quota_limit_value: '1500', quota_unit: '1/min/{project}/{user}', quota_metric: 'gmail.googleapis.com/quota_total_query_cost', window_start_time: '1791363743', quota_location: 'global', service: 'gmail.googleapis.com', quota_limit: 'TotalQueryCostPerMinutePerUser' },
          },
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Request a higher quota limit.', url: 'https://cloud.google.com/docs/quota#requesting_higher_quota' }] },
        ],
      },
    }
  }
  return { error: { code: err.status, status: err.gmailStatus, ...(err.reason ? { errors: [{ reason: err.reason }] } : {}) } }
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

/** `messageId` is '' for the two list calls, which carry `startHistoryId` / `q` and `pageToken` instead. */
export type FakeGmailCall = { op: 'full' | 'raw' | 'attachment' | 'history' | 'list'; messageId: string; attachmentId?: string; startHistoryId?: string; q?: string; pageToken?: string | null }

/**
 * One scripted history record ([[CHN5]] D72, D82). `added` entries carry `labelIds` as Gmail sends them on the record (every real record did): the listed `labels`,
 * else the message's own labels, else `INBOX`. `labels: null` serves the labelless form (D73's fallback), and only on request.
 */
export interface FakeHistoryRecord {
  id: string
  added?: Array<{ id: string; labels?: string[] | null }>
  /** Records of the kinds capture ignores ([[CHN5]] D6). */
  labelsAdded?: Array<{ id: string; labelIds: string[] }>
  deleted?: string[]
}

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
  /** The mailbox's history, in id order. Served by `listHistory` in Gmail's wire form, omissions included. */
  readonly history: FakeHistoryRecord[] = []
  /** A `startHistoryId` below this is Gmail's `404` (history no longer held). */
  expireHistoryBefore = 0
  /** Ids a list returns whatever the query says (a label can change between the list and the get). */
  readonly extraListed: string[] = []
  /** When set, called before every message, history and list call: the access token source, the way `HttpGmailClient` asks per request. A token `valid` refuses is a `401`. */
  private tokenSource: { token: () => Promise<string>; valid: (t: string) => boolean } | null = null

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

  clearFailures(): this {
    this.failures.length = 0
    return this
  }

  /** Makes every call ask `token()` first and answer `401` unless `valid(token)`. A token source that throws fails the call before it is logged. */
  withToken(token: () => Promise<string>, valid: (t: string) => boolean): this {
    this.tokenSource = { token, valid }
    return this
  }
  private async authenticate(): Promise<void> {
    if (!this.tokenSource) return
    const t = await this.tokenSource.token()
    if (!this.tokenSource.valid(t)) throw new GmailApiError({ status: 401, gmailStatus: 'UNAUTHENTICATED' })
  }
  private enterList(call: FakeGmailCall): void {
    this.calls.push(call)
    const failure = this.failures.find((f) => f.match(call))
    if (failure) throw failure.error
  }

  /** Gmail's `users.history.list` body for a request: no `history` member when empty, no `nextPageToken` on the last page. */
  historyWire(startHistoryId: string, pageToken: string | null | undefined, maxResults: number): Record<string, unknown> {
    if (Number(startHistoryId) < this.expireHistoryBefore) throw new GmailApiError({ status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' })
    const all = this.history.filter((r) => Number(r.id) > Number(startHistoryId))
    const at = pageToken ? Number(pageToken.replace(/^h/, '')) : 0
    const slice = all.slice(at, at + maxResults)
    const wire = (r: FakeHistoryRecord) => {
      const msg = (id: string, labels?: string[] | null) => ({ id, threadId: this.messages.get(id)?.resource.threadId ?? `t-${id}`, ...(labels ? { labelIds: labels } : {}) })
      const labelsOf = (a: { id: string; labels?: string[] | null }): string[] | null => (a.labels === null ? null : (a.labels ?? this.messages.get(a.id)?.resource.labelIds ?? ['INBOX']))
      return {
        id: r.id,
        messages: [...(r.added ?? []).map((a) => msg(a.id))],
        ...((r.added?.length ?? 0) > 0 ? { messagesAdded: r.added!.map((a) => ({ message: msg(a.id, labelsOf(a)) })) } : {}),
        ...(r.deleted?.length ? { messagesDeleted: r.deleted.map((id) => ({ message: msg(id) })) } : {}),
        ...(r.labelsAdded?.length ? { labelsAdded: r.labelsAdded.map((l) => ({ message: msg(l.id), labelIds: l.labelIds })) } : {}),
      }
    }
    return {
      ...(slice.length > 0 ? { history: slice.map(wire) } : {}),
      ...(at + maxResults < all.length ? { nextPageToken: `h${at + maxResults}` } : {}),
      historyId: this.profile.historyId,
    }
  }
  /** Gmail's `users.messages.list` body: matches of `after:<unix seconds> {in:inbox in:sent}` plus `extraListed`; no `messages` member when empty. */
  messageListWire(q: string, pageToken: string | null | undefined, maxResults: number): Record<string, unknown> {
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0)
    const matching = [...this.messages.values()].filter((m) => {
      const labels = m.resource.labelIds ?? []
      return (labels.includes('INBOX') || labels.includes('SENT')) && Number(m.resource.internalDate) / 1000 >= after
    })
    const ids = [...new Set([...matching.map((m) => m.resource.id), ...this.extraListed])]
    const at = pageToken ? Number(pageToken.replace(/^m/, '')) : 0
    const slice = ids.slice(at, at + maxResults)
    return {
      ...(slice.length > 0 ? { messages: slice.map((id) => ({ id, threadId: this.messages.get(id)?.resource.threadId ?? `t-${id}` })) } : {}),
      ...(at + maxResults < ids.length ? { nextPageToken: `m${at + maxResults}` } : {}),
      resultSizeEstimate: ids.length,
    }
  }
  async listHistory(p: { startHistoryId: string; pageToken?: string | null; maxResults: number; historyTypes: readonly string[] }): Promise<GmailHistoryPage> {
    await this.authenticate()
    this.enterList({ op: 'history', messageId: '', startHistoryId: p.startHistoryId, pageToken: p.pageToken ?? null })
    return parseHistoryList(this.historyWire(p.startHistoryId, p.pageToken, p.maxResults))
  }
  async listMessages(p: { q: string; pageToken?: string | null; maxResults: number }): Promise<GmailMessageList> {
    await this.authenticate()
    this.enterList({ op: 'list', messageId: '', q: p.q, pageToken: p.pageToken ?? null })
    return parseMessageList(this.messageListWire(p.q, p.pageToken, p.maxResults))
  }

  /**
   * The same data over HTTP, for runs that inject `fetch` (the compose tests, the workerd smoke): `users/me/{history,messages,messages/<id>,
   * messages/<id>/attachments/<id>,profile}`, a bearer token `valid` accepts, the same call log and the same scripted failures as the client methods.
   */
  readonly handle = async (req: Request, valid: (token: string) => boolean): Promise<Response> => {
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ') || !valid(auth.slice(7))) return json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401)
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '')
    const q = url.searchParams
    try {
      if (path === '/profile') return json(this.profile)
      if (path === '/history') {
        this.enterList({ op: 'history', messageId: '', startHistoryId: q.get('startHistoryId') ?? '', pageToken: q.get('pageToken') })
        return json(this.historyWire(q.get('startHistoryId') ?? '', q.get('pageToken'), Number(q.get('maxResults') ?? 100)))
      }
      if (path === '/messages') {
        this.enterList({ op: 'list', messageId: '', q: q.get('q') ?? '', pageToken: q.get('pageToken') })
        return json(this.messageListWire(q.get('q') ?? '', q.get('pageToken'), Number(q.get('maxResults') ?? 100)))
      }
      const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path)
      if (attachment) {
        const message = this.enter({ op: 'attachment', messageId: decodeURIComponent(attachment[1]!), attachmentId: decodeURIComponent(attachment[2]!) })
        const bytes = message.attachments.get(decodeURIComponent(attachment[2]!))
        if (!bytes) return json({ error: { code: 404, status: 'NOT_FOUND' } }, 404)
        return new Response(attachmentWire(bytes) as unknown as BodyInit, { headers: { 'content-type': 'application/json' } })
      }
      const one = /^\/messages\/([^/]+)$/.exec(path)
      if (one) {
        const id = decodeURIComponent(one[1]!)
        if (q.get('format') === 'raw') return new Response(rawWire(this.enter({ op: 'raw', messageId: id })) as unknown as BodyInit, { headers: { 'content-type': 'application/json' } })
        return json(this.enter({ op: 'full', messageId: id }).resource)
      }
      return json({ error: { code: 404, status: 'NOT_FOUND' } }, 404)
    } catch (err) {
      if (err instanceof GmailApiError) return json(errorBody(err), err.status, err.retryAfter ? { 'retry-after': err.retryAfter } : {})
      throw err
    }
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
    await this.authenticate()
    return structuredClone(this.enter({ op: 'full', messageId }).resource)
  }
  async getMessageRaw(messageId: string): Promise<ReadableStream<Uint8Array>> {
    await this.authenticate()
    return chunkedStream(rawWire(this.enter({ op: 'raw', messageId })), this.chunk)
  }
  async getAttachment(messageId: string, attachmentId: string): Promise<ReadableStream<Uint8Array>> {
    await this.authenticate()
    const message = this.enter({ op: 'attachment', messageId, attachmentId })
    const bytes = message.attachments.get(attachmentId)
    if (!bytes) throw new GmailApiError({ status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' })
    return chunkedStream(attachmentWire(bytes), this.chunk)
  }
}
