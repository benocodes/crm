import type { Program } from '../identity/program.js'
import type { ChannelPort, ConnectionRef } from '../channels/port.js'
import type { ObjectStore } from '../objects/store.js'
import type { StorageBinding } from '@vault/storage'
import type { StreamPrimitives } from './streams.js'

export interface PipelineContext {
  binding: StorageBinding
  organizationId: string
  actorId: string
  objects: ObjectStore
  streams: StreamPrimitives
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
  cap?: number
  attachmentMaxBytes?: number
}
export interface PipelineResult {
  captured: number
  existing: number
  skipped: Record<string, number>
  attachments: { stored: number; failed: number; skipped: number }
  orphaned_objects: number
}
export async function captureMessages(_ctx: PipelineContext, _port: ChannelPort, _conn: ConnectionRef, _ids: readonly string[], _opts: { final?: Program<unknown> } = {}): Promise<PipelineResult> {
  throw new Error('not implemented')
}
