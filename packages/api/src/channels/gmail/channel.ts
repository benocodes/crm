// `GmailChannel` ([[CHN5]] D23, D24, D25): [[CORE69]]'s `ChannelPort` over a `GmailClient`. `readMessage` maps `format=full` and gives
// a lazy `raw`; `fetchAttachment` returns the decoded stream with the size the message declared. Type-only imports from the port: no
// runtime import from `chat` ([[CORE69]] D25).
import { AttachmentFetchError, type ChannelMessage, type ChannelPort } from '../port.js'
import { GmailApiError, type GmailClient } from './client.js'
import { base64UrlMemberDecoder } from './decoder.js'
import { mapGmailMessage, type GmailConnection } from './mapper.js'

/** A short machine code for a failed attachment fetch ([[CORE69]] D3): never provider text. */
function fetchErrorCode(err: unknown): string {
  if (!(err instanceof GmailApiError)) return 'fetch_failed'
  if (err.status === 404) return 'not_found'
  if (err.status === 401 || err.status === 403) return 'access_denied'
  if (err.status === 429) return 'rate_limited'
  return `http_${err.status}`
}

export class GmailChannel implements ChannelPort<GmailConnection> {
  readonly channel = 'email' as const

  /** `accept`, when given, is the label rule applied to the FETCHED message ([[CHN5]] D70): the scans use it, since a list returns no labels. A refusal is the skip `label`. */
  constructor(
    private readonly client: GmailClient,
    private readonly opts: { accept?: (labelIds: readonly string[] | undefined) => boolean } = {},
  ) {}

  async readMessage(conn: GmailConnection, providerMessageId: string): Promise<ChannelMessage | { skip: string }> {
    let resource
    try {
      resource = await this.client.getMessageFull(providerMessageId)
    } catch (err) {
      // Deleted between the history entry and this fetch ([[CHN5]] D16). Anything else is the caller's to classify.
      if (err instanceof GmailApiError && err.status === 404) return { skip: 'not_found' }
      throw err
    }
    if (this.opts.accept && !this.opts.accept(resource.labelIds)) return { skip: 'label' }
    return mapGmailMessage({
      conn,
      resource,
      openRaw: async () => (await this.client.getMessageRaw(providerMessageId)).pipeThrough(base64UrlMemberDecoder('raw')),
    })
  }

  async fetchAttachment(_conn: GmailConnection, fetchMetadata: Record<string, string>): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    const { message_id: messageId, attachment_id: attachmentId, size: declared } = fetchMetadata
    const size = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null
    if (!messageId || !attachmentId || size === null) throw new AttachmentFetchError('bad_metadata')
    let wire: ReadableStream<Uint8Array>
    try {
      wire = await this.client.getAttachment(messageId, attachmentId)
    } catch (err) {
      throw new AttachmentFetchError(fetchErrorCode(err))
    }
    return { body: wire.pipeThrough(base64UrlMemberDecoder('data')), size }
  }
}
