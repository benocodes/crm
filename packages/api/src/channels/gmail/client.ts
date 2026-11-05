// `GmailClient` ([[CHN5]] D23, D44, D46): the REST calls the Gmail channel reads with. Cycle 1 has three; later cycles add their own
// with their first caller. The two streaming calls return the response body UNDECODED (Gmail's JSON with one base64url member).
import type { GmailHistoryPage, GmailMessageList, GmailMessageResource, GmailProfile, GmailSendAs } from './types.js'

export interface GmailClient {
  /** `users.getProfile`: the address and the current history id (the cursor the connect flow saves, [[CHN5]] D9). */
  getProfile(): Promise<GmailProfile>
  /** `users.settings.sendAs.list` ([[CHN5]] D10): the primary address and the aliases; an empty answer is an empty list. */
  listSendAs(): Promise<GmailSendAs[]>
  /** `users.history.list` ([[CHN5]] D12): one page of history records after `startHistoryId`. A start id Gmail no longer holds is a `GmailApiError` with status 404. */
  listHistory(p: { startHistoryId: string; pageToken?: string | null; maxResults: number; historyTypes: readonly string[] }): Promise<GmailHistoryPage>
  /** `users.messages.list` ([[CHN5]] D13, D67): one page of message ids matching `q`. */
  listMessages(p: { q: string; pageToken?: string | null; maxResults: number }): Promise<GmailMessageList>
  /** `users.messages.get?format=full`, parsed. */
  getMessageFull(messageId: string): Promise<GmailMessageResource>
  /** `users.messages.get?format=raw`: the JSON body as a byte stream; the `raw` member is the RFC 822 original in base64url. */
  getMessageRaw(messageId: string): Promise<ReadableStream<Uint8Array>>
  /** `users.messages.attachments.get`: the JSON body as a byte stream; the `data` member is the attachment in base64url. */
  getAttachment(messageId: string, attachmentId: string): Promise<ReadableStream<Uint8Array>>
}

/** A non-2xx Gmail response. Carries no request data: neither the URL nor the token. Classifying it ([[CHN5]] D16) is the caller's. */
export class GmailApiError extends Error {
  override name = 'GmailApiError'
  readonly status: number
  /** Gmail's `error.status`, for example `NOT_FOUND` or `RESOURCE_EXHAUSTED`; null when the body did not say. */
  readonly gmailStatus: string | null
  /** Gmail's first `error.errors[].reason`, for example `rateLimitExceeded`; null when absent. */
  readonly reason: string | null
  /** The `Retry-After` header as sent; null when absent. */
  readonly retryAfter: string | null
  /** `retryAfter` as whole seconds from now (a delay or an HTTP date); null when absent or unparseable. */
  readonly retryAfterSeconds: number | null
  constructor(init: { status: number; gmailStatus?: string | null; reason?: string | null; retryAfter?: string | null; retryAfterSeconds?: number | null }) {
    super(`Gmail API error ${init.status}${init.gmailStatus ? ` ${init.gmailStatus}` : ''}${init.reason ? ` (${init.reason})` : ''}`)
    this.status = init.status
    this.gmailStatus = init.gmailStatus ?? null
    this.reason = init.reason ?? null
    this.retryAfter = init.retryAfter ?? null
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Parses a `users.history.list` body leniently ([[CHN5]] D72): absent arrays are empty, unknown fields are ignored, only `messagesAdded` is read. */
export function parseHistoryList(_body: unknown): GmailHistoryPage {
  throw new Error('not implemented')
}

/** Parses a `users.messages.list` body leniently ([[CHN5]] D72): no `messages` member is an empty page. */
export function parseMessageList(_body: unknown): GmailMessageList {
  throw new Error('not implemented')
}

export interface HttpGmailClientOptions {
  /** Called before every request; the client never caches or refreshes. */
  accessToken: () => Promise<string>
  fetch?: typeof fetch
  /** The `users/me` base; default Gmail's. Injectable so no test reaches Google. */
  baseUrl?: string
}

const DEFAULT_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

function retryAfterSeconds(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** Reads what Gmail said about a failure, best effort: a body that is not Gmail's JSON error gives status only. Never touches the request. */
async function apiError(res: Response): Promise<GmailApiError> {
  let gmailStatus: string | null = null
  let reason: string | null = null
  try {
    const parsed = JSON.parse(await res.text()) as { error?: { status?: unknown; errors?: Array<{ reason?: unknown }> } }
    if (typeof parsed.error?.status === 'string') gmailStatus = parsed.error.status
    const r = parsed.error?.errors?.[0]?.reason
    if (typeof r === 'string') reason = r
  } catch {
    // not JSON
  }
  const retryAfter = res.headers.get('retry-after')
  return new GmailApiError({ status: res.status, gmailStatus, reason, retryAfter, retryAfterSeconds: retryAfterSeconds(retryAfter) })
}

export class HttpGmailClient implements GmailClient {
  private readonly accessToken: () => Promise<string>
  private readonly doFetch: typeof fetch
  private readonly base: string

  constructor(options: HttpGmailClientOptions) {
    this.accessToken = options.accessToken
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.base = options.baseUrl ?? DEFAULT_BASE
  }

  private async get(path: string): Promise<Response> {
    const token = await this.accessToken()
    const res = await this.doFetch(`${this.base}${path}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw await apiError(res)
    return res
  }

  private async stream(path: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.get(path)
    if (!res.body) throw new GmailApiError({ status: res.status, reason: 'empty_body' })
    return res.body as ReadableStream<Uint8Array>
  }

  async getProfile(): Promise<GmailProfile> {
    return (await (await this.get('/profile')).json()) as GmailProfile
  }
  async listSendAs(): Promise<GmailSendAs[]> {
    const body = (await (await this.get('/settings/sendAs')).json()) as { sendAs?: GmailSendAs[] }
    return body.sendAs ?? []
  }

  async listHistory(p: { startHistoryId: string; pageToken?: string | null; maxResults: number; historyTypes: readonly string[] }): Promise<GmailHistoryPage> {
    const q = new URLSearchParams({ startHistoryId: p.startHistoryId, maxResults: String(p.maxResults) })
    for (const t of p.historyTypes) q.append('historyTypes', t)
    if (p.pageToken) q.set('pageToken', p.pageToken)
    return parseHistoryList(await (await this.get(`/history?${q}`)).json())
  }
  async listMessages(p: { q: string; pageToken?: string | null; maxResults: number }): Promise<GmailMessageList> {
    const q = new URLSearchParams({ q: p.q, maxResults: String(p.maxResults) })
    if (p.pageToken) q.set('pageToken', p.pageToken)
    return parseMessageList(await (await this.get(`/messages?${q}`)).json())
  }

  async getMessageFull(messageId: string): Promise<GmailMessageResource> {
    return (await (await this.get(`/messages/${encodeURIComponent(messageId)}?format=full`)).json()) as GmailMessageResource
  }
  getMessageRaw(messageId: string): Promise<ReadableStream<Uint8Array>> {
    return this.stream(`/messages/${encodeURIComponent(messageId)}?format=raw`)
  }
  getAttachment(messageId: string, attachmentId: string): Promise<ReadableStream<Uint8Array>> {
    return this.stream(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)
  }
}
