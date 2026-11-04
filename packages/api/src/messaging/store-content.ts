import { AttachmentFetchError, type ChannelMessage, type ChannelPort, type ConnectionRef } from '../channels/port.js'
import { stringifyMarkdown } from '../channels/markdown.js'
import type { ObjectStore } from '../objects/store.js'
import type { CaptureAttachment } from './capture.js'
import { messagePreview } from './preview.js'
import { fileBlobKey, fileObjectPrefix, messageBodyKey, messageContentPrefix, messageOriginalKey } from './r2-keys.js'
import type { StreamPrimitives } from './streams.js'

/** [[CORE25]] D38: attachments above this are recorded `skipped` and never fetched. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

export interface ContentContext {
  organizationId: string
  objects: ObjectStore
  streams: StreamPrimitives
  /** Mints the fresh object id of each stored attachment. */
  newId: () => string
  attachmentMaxBytes?: number
}

export interface StoredContent {
  /** Null for a reaction. */
  content_key: string | null
  preview: string
  /** In position order. `fetch_status` is stored, skipped or failed; `file` is set iff stored. */
  attachments: CaptureAttachment[]
  /** Best-effort deletes that failed (a length-mismatched blob that could not be removed). */
  orphaned_objects: number
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Stores one NEW message's content outside any unit ([[CORE69]] D6, [[CORE25]] "Capture write path" step 4): `v1/body.md` and
 * `v1/original.<ext>` at the deterministic keys, then each attachment in position order, streamed through the hasher into a fresh
 * object. A reaction stores nothing. Every attachment outcome is data (`stored`, `skipped`, `failed` with a short code); an
 * object-store failure is infrastructure and throws, so the caller's retry overwrites the deterministic keys.
 */
export async function storeMessageContent(ctx: ContentContext, port: ChannelPort, conn: ConnectionRef, cm: ChannelMessage): Promise<StoredContent> {
  const { message, facts, raw } = cm
  const preview = messagePreview(message, facts.kind)
  if (facts.kind === 'reaction') return { content_key: null, preview, attachments: [], orphaned_objects: 0 }
  if (facts.attachments.length !== message.attachments.length) throw new Error('facts.attachments must describe message.attachments one to one')

  const contentKey = await messageContentPrefix(ctx.organizationId, facts.channel, facts.external_id)
  await ctx.objects.put(messageBodyKey(contentKey, 1), stringifyMarkdown(message.formatted), { contentType: 'text/markdown' })

  const originalKey = messageOriginalKey(contentKey, 1, raw.ext)
  const opened = await raw.open()
  if (opened instanceof Uint8Array) await ctx.objects.put(originalKey, opened, { contentType: raw.content_type })
  else await ctx.objects.putStream(originalKey, raw.size === null ? opened : opened.pipeThrough(ctx.streams.fixedLength(raw.size)), { size: raw.size, contentType: raw.content_type })

  const max = ctx.attachmentMaxBytes ?? ATTACHMENT_MAX_BYTES
  let orphaned = 0
  const attachments: CaptureAttachment[] = []
  const order = facts.attachments.map((f, index) => ({ f, index })).sort((x, y) => x.f.position - y.f.position)
  for (const { f, index } of order) {
    const a = message.attachments[index]!
    const base = {
      position: f.position,
      type: a.type,
      name: a.name ?? null,
      mime_type: a.mimeType ?? null,
      size_bytes: a.size ?? null,
      inline: f.inline,
      content_id: f.content_id,
      fetch_metadata: a.fetchMetadata ?? null,
    }
    const outcome = (fetch_status: 'skipped' | 'failed', fetch_error: string | null, size_bytes = base.size_bytes): CaptureAttachment => ({ ...base, size_bytes, fetch_status, fetch_error, file: null })

    if (a.size !== undefined && a.size > max) {
      attachments.push(outcome('skipped', null))
      continue
    }
    let fetched: { body: ReadableStream<Uint8Array>; size: number }
    try {
      fetched = await port.fetchAttachment(conn, a.fetchMetadata ?? {})
    } catch (err) {
      // A code, never the error's text: it may quote a URL or a token.
      attachments.push(outcome('failed', err instanceof AttachmentFetchError ? err.code : 'fetch_failed'))
      continue
    }
    if (fetched.size > max) {
      await fetched.body.cancel().catch(() => {})
      attachments.push(outcome('skipped', null, fetched.size))
      continue
    }

    const size = fetched.size
    const storageKey = fileObjectPrefix(ctx.organizationId, ctx.newId())
    const blobKey = fileBlobKey(storageKey)
    const name = a.name ?? `attachment-${f.position}`
    const mimeType = a.mimeType ?? 'application/octet-stream'

    // Count what the provider really sent, and tell a broken source from a broken store.
    const seen = { bytes: 0, done: false, readError: undefined as unknown, failed: false }
    const reader = fetched.body.getReader()
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const r = await reader.read()
          if (r.done) {
            seen.done = true
            controller.close()
          } else {
            seen.bytes += r.value.byteLength
            controller.enqueue(r.value)
          }
        } catch (err) {
          seen.failed = true
          seen.readError = err
          controller.error(err)
        }
      },
      cancel: (reason) => reader.cancel(reason),
    })
    const [forHash, forStore] = source.tee()
    const sink = ctx.streams.sha256()
    sink.digest.catch(() => {})
    const hashing = forHash.pipeTo(sink.writable)
    const putting = ctx.objects.putStream(blobKey, forStore.pipeThrough(ctx.streams.fixedLength(size)), { size, contentType: mimeType })
    const [hashed, put] = await Promise.allSettled([hashing, putting])

    if (seen.failed) {
      attachments.push(outcome('failed', 'fetch_failed', size))
      continue
    }
    if (seen.bytes > size || (seen.done && seen.bytes < size)) {
      // The provider's body is not the length it declared: nothing trustworthy was stored.
      await ctx.objects.delete(blobKey).catch(() => {
        orphaned++
      })
      attachments.push(outcome('failed', 'length_mismatch', size))
      continue
    }
    if (put.status === 'rejected') throw put.reason
    if (hashed.status === 'rejected') throw hashed.reason
    attachments.push({
      ...base,
      size_bytes: size,
      fetch_status: 'stored',
      fetch_error: null,
      file: { storage_key: storageKey, sha256: hex(await sink.digest), size_bytes: size, name, mime_type: mimeType },
    })
  }
  return { content_key: contentKey, preview, attachments, orphaned_objects: orphaned }
}
