// The vault-owned channel port ([[CORE25]] D14, exact shape in [[CORE69]] D3). A provider implements it; the pipeline
// (`captureMessages`) reads through it and knows nothing else of the provider. Sending is optional for capture-only adapters.
import type { Message } from 'chat'

/** The contract with the SDK: a renamed or retyped field upstream fails typecheck here. Plain data, hand-constructible. */
export type VibaseMessage = Pick<Message, 'id' | 'threadId' | 'text' | 'formatted' | 'author' | 'metadata' | 'attachments'>

export type ChannelName = 'email'
export type ParticipantRole = 'from' | 'to' | 'cc' | 'bcc'

/** The interaction facts the SDK's `Message` does not model. `attachments[i]` describes `message.attachments[i]`. */
export interface ChannelFacts {
  channel: ChannelName
  kind: 'message' | 'reaction'
  external_id: string
  in_reply_to: string | null
  /** At most 20, nearest first. */
  thread_hints: string[]
  provider_message_id: string
  provider_thread_id: string
  /** ISO instant. */
  occurred_at: string
  subject: string | null
  participants: Array<{ kind: 'email' | 'phone'; value: string; name?: string; role: ParticipantRole }>
  sent_by_connection: boolean
  attachments: Array<{ position: number; inline: boolean; content_id: string | null }>
}

/** The original payload, opened lazily: a message found to exist already never opens it. `size` is null when not known up front. */
export interface ChannelRaw {
  ext: 'eml' | 'json'
  content_type: string
  size: number | null
  open(): Promise<ReadableStream<Uint8Array> | Uint8Array>
}

export interface ChannelMessage {
  message: VibaseMessage
  facts: ChannelFacts
  raw: ChannelRaw
}

export interface ConnectionRef {
  id: string
}

/** Authorised outbound content. Provider ids are transport details, never vault external ids. */
export interface OutboundPost {
  from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; client_ref: string
  provider_thread_id: string | null; provider_anchor_id: string | null
  anchor_external_id?: string; in_reply_to?: string; references?: string[]
}
export interface OutboundResult { id: string; threadId: string }

export interface ChannelPort<C extends ConnectionRef = ConnectionRef> {
  readonly channel: ChannelName
  postToThread?(post: OutboundPost, signal: AbortSignal, beforeSend?: () => void): Promise<OutboundResult>
  readMessage(conn: C, providerMessageId: string): Promise<ChannelMessage | { skip: string }>
  fetchAttachment(conn: C, fetchMetadata: Record<string, string>): Promise<{ body: ReadableStream<Uint8Array>; size: number }>
}

/** A failed attachment fetch. `code` is a short machine code (stored in `fetch_error`); never put provider text in it. */
export class AttachmentFetchError extends Error {
  override name = 'AttachmentFetchError'
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

/**
 * The provider throttled a fetch (a rate or quota limit). Unlike an `AttachmentFetchError` it is never a property of the attachment, so it is not stored as a
 * `failed` link: it propagates out of the capture and the page repeats after a sleep ([[CHN5]] D83). `retryAfterSeconds` is what the provider asked, else null.
 */
export class ChannelThrottledError extends Error {
  override name = 'ChannelThrottledError'
  constructor(readonly retryAfterSeconds: number | null) {
    super('the provider throttled the fetch')
  }
}
