import type { ChannelMessage, ChannelPort } from '../port.js'
import type { GmailClient } from './client.js'
import type { GmailConnection } from './mapper.js'

export class GmailChannel implements ChannelPort<GmailConnection> {
  readonly channel = 'email' as const
  constructor(_client: GmailClient) {}
  readMessage(_conn: GmailConnection, _id: string): Promise<ChannelMessage | { skip: string }> {
    throw new Error('not implemented')
  }
  fetchAttachment(_conn: GmailConnection, _md: Record<string, string>): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    throw new Error('not implemented')
  }
}
