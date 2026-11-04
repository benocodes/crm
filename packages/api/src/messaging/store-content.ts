import type { ChannelMessage, ChannelPort, ConnectionRef } from '../channels/port.js'
import type { ObjectStore } from '../objects/store.js'
import type { CaptureAttachment } from './capture.js'
import type { StreamPrimitives } from './streams.js'

export interface ContentContext {
  organizationId: string
  objects: ObjectStore
  streams: StreamPrimitives
  newId: () => string
  attachmentMaxBytes?: number
}
export interface StoredContent {
  content_key: string | null
  preview: string
  attachments: CaptureAttachment[]
  /** Object deletes that failed (a length-mismatched blob that could not be removed). */
  orphaned_objects: number
}
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
export async function storeMessageContent(_ctx: ContentContext, _port: ChannelPort, _conn: ConnectionRef, _message: ChannelMessage): Promise<StoredContent> {
  throw new Error('not implemented')
}
