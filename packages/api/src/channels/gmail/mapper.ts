import type { ChannelMessage } from '../port.js'
import type { GmailMessageResource } from './types.js'

export interface GmailConnection {
  id: string
  /** The mailbox's address; encodes into the adapter-style message ids. */
  mailbox: string
}

export interface MapperInput {
  conn: GmailConnection
  resource: GmailMessageResource
  /** Opens the `raw` member lazily. */
  openRaw: () => Promise<ReadableStream<Uint8Array>>
}

/** `format=full` resource to a `ChannelMessage`, or a skip reason ([[CHN5]] D35). */
export function mapGmailMessage(_input: MapperInput): ChannelMessage | { skip: string } {
  throw new Error('not implemented')
}
