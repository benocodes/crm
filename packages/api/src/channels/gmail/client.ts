// `GmailClient` ([[CHN5]] D23, D44, D46): the REST calls the Gmail channel reads with. Cycle 1 has three; later cycles add their own
// with their first caller. The two streaming calls return the response body UNDECODED (Gmail's JSON with one base64url member).
import type { GmailMessageResource } from './types.js'

export interface GmailClient {
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

export interface HttpGmailClientOptions {
  /** Called before every request; the client never caches or refreshes. */
  accessToken: () => Promise<string>
  fetch?: typeof fetch
  baseUrl?: string
}

export class HttpGmailClient implements GmailClient {
  constructor(_options: HttpGmailClientOptions) {
    throw new Error('not implemented')
  }
  getMessageFull(_messageId: string): Promise<GmailMessageResource> {
    throw new Error('not implemented')
  }
  getMessageRaw(_messageId: string): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not implemented')
  }
  getAttachment(_messageId: string, _attachmentId: string): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not implemented')
  }
}
