import { sql } from 'kysely'
import { boundIds, coldDb, defineOperation, execute, memberOf, readSet, step, unit, UnitDriftError, type QueryContext, type StorageBinding, type StorageIdentity } from '@vibase/storage'
import type { ChannelMessage, ChannelPort, ConnectionRef } from '../channels/port.js'
import { operationOf, type Program } from '../identity/program.js'
import type { ObjectStore } from '../objects/store.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import { recordMessages, type CaptureAttachment, type CaptureMessage, type CaptureResult } from './capture.js'
import { captureChunks, normalizeParticipants } from './capture-chunks.js'
import { messagePreview } from './preview.js'
import { fileBlobKey, messageContentPrefix } from './r2-keys.js'
import { ATTACHMENT_MAX_BYTES, storeMessageContent } from './store-content.js'
import type { StreamPrimitives } from './streams.js'

/** The pipeline's explicit context ([[CORE69]] D12). Every unit runs as a `tenant` identity whose actor is `actorId`. */
export interface PipelineContext {
  binding: StorageBinding
  organizationId: string
  /** The connection's owner ([[CHN5]] D21): the actor of every unit and of every event. */
  actorId: string
  objects: ObjectStore
  streams: StreamPrimitives
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
  /** Defaults to the runtime's `maxSetSize`. */
  cap?: number
  /** Defaults to 50 MiB ([[CORE25]] D38). */
  attachmentMaxBytes?: number
}

/** Plain counts only (invariant 7, [[CORE25]] D47): no ids, addresses or content. */
export interface PipelineResult {
  captured: number
  existing: number
  /** By reason: the port's own `{ skip }` reasons, `unsupported_sender`, `too_many_participants`, `too_many_attachments`, and `dropped_address` (addresses, not messages). */
  skipped: Record<string, number>
  attachments: { stored: number; failed: number; skipped: number }
  /** Object deletes that failed. */
  orphaned_objects: number
}

export interface PipelineOptions {
  /** Prepared steps committed in the LAST chunk's unit, or alone when the batch yields no chunk ([[CORE69]] D10). */
  final?: Program<unknown>
}

const MAX_DRIFT_RETRIES = 2
const RESERVED_PREFIXES = ['capture:', 'resolve:']

interface Entry {
  channel: ChannelMessage
  capture: CaptureMessage
  existing: boolean
}

/**
 * Composes `final` into a capture program by [[CORE68]]'s rule for `resolveProgram`: reads spread beside capture's (a key collision
 * is a programmer error, thrown before anything runs), steps appended after capture's with the `result` step dropped and every
 * label stripped, its value discarded. An empty `final` adds no statement, so the unit keeps its shape.
 */
function withFinal(capture: Program<CaptureResult>, final: Program<unknown>): Program<CaptureResult> {
  return {
    reads(qc) {
      const own = capture.reads(qc)
      const extra = final.reads(qc)
      assertNoCollision(Object.keys(own), Object.keys(extra))
      return { ...own, ...extra }
    },
    build(found, qc) {
      const built = capture.build(found, qc)
      const extra = final.build(found, qc)
      const appended = extra.steps.filter((s) => s.label !== 'result').map((s) => step(s.query, undefined, s.expect ? { expect: s.expect } : {}))
      return unit({ steps: [...built.steps, ...appended], events: [...built.events, ...extra.events], decode: built.decode })
    },
  }
}

function assertNoCollision(own: readonly string[], extra: readonly string[]): void {
  for (const key of extra) {
    if (own.includes(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) throw new Error(`the final program's read key "${key}" collides with the capture unit's`)
  }
}

/**
 * `captureMessages` ([[CORE69]] D8-D12): reads a channel port, stores content in the object store and records it through
 * `recordMessages`, one batch at a time. A plain async function (no Workflow, cursor or provider knowledge) that [[CHN5]]'s page
 * step calls. In order: read each id, one at a time; map and normalise; ONE pre-check read for the batch; chunk; per chunk store
 * the new messages' content one at a time, record in one unit (retried in place on drift), delete duplicate objects.
 */
export async function captureMessages(
  ctx: PipelineContext,
  port: ChannelPort,
  conn: ConnectionRef,
  providerMessageIds: readonly string[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const { binding } = ctx
  const cap = ctx.cap ?? binding.runtime.maxSetSize
  const maxBytes = ctx.attachmentMaxBytes ?? ATTACHMENT_MAX_BYTES
  const identity: StorageIdentity = { kind: 'tenant', actorId: ctx.actorId, organizationId: ctx.organizationId }
  const makeEnv = (): PreparedEnv => ({
    actor: { id: ctx.actorId, kind: 'user' },
    organizationId: ctx.organizationId,
    scopes: ScopeSet.parse([]),
    now: ctx.clock(),
    newId: ctx.newId,
    randomBytes: ctx.randomBytes,
  })
  const result: PipelineResult = { captured: 0, existing: 0, skipped: {}, attachments: { stored: 0, failed: 0, skipped: 0 }, orphaned_objects: 0 }
  const skip = (reason: string, n = 1) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + n
  }

  // A collision between `final`'s reads and the capture unit's is a bug in the caller: refuse it before a byte is read or stored.
  if (opts.final) {
    const qc: QueryContext = { db: coldDb(binding.runtime.dialect), dialect: binding.runtime.dialect, maxSetSize: binding.runtime.maxSetSize }
    assertNoCollision(Object.keys(recordMessages(makeEnv(), { connection_id: conn.id, messages: [] }).reads(qc)), Object.keys(opts.final.reads(qc)))
  }

  // (1)-(2) Read one at a time, map, normalise.
  const entries: Entry[] = []
  for (const id of providerMessageIds) {
    const read = await port.readMessage(conn, id)
    if ('skip' in read) {
      skip(read.skip)
      continue
    }
    const { facts, message } = read
    const norm = normalizeParticipants(facts.participants)
    if (norm.dropped > 0) skip('dropped_address', norm.dropped)
    if (norm.skip !== null) {
      skip(norm.skip)
      continue
    }
    const reaction = facts.kind === 'reaction'
    entries.push({
      channel: read,
      existing: false,
      capture: {
        channel: facts.channel,
        kind: facts.kind,
        external_id: facts.external_id,
        in_reply_to: facts.in_reply_to,
        thread_hints: facts.thread_hints.slice(0, 20),
        provider_message_id: facts.provider_message_id,
        provider_thread_id: facts.provider_thread_id,
        occurred_at: facts.occurred_at,
        subject: facts.subject,
        author: { user_id: message.author.userId, user_name: message.author.userName, full_name: message.author.fullName, is_bot: message.author.isBot === true },
        preview: messagePreview(message, facts.kind),
        content_key: null,
        sent_by_connection: facts.sent_by_connection,
        participants: norm.participants,
        attachments: reaction ? [] : pendingAttachments(read),
      },
    })
  }

  // (3) One pre-check for the whole batch: which (channel, external_id) already exist.
  const known = await existingExternalIds(ctx, identity, [...new Set(entries.map((e) => e.capture.external_id))], cap)
  for (const e of entries) {
    e.existing = known.has(e.capture.external_id)
    if (e.existing) e.capture = { ...e.capture, content_key: e.capture.kind === 'reaction' ? null : await messageContentPrefix(ctx.organizationId, e.capture.channel, e.capture.external_id) }
  }

  // (4) Chunk by what each message will store: an existing message stores nothing (its attachments stay pending).
  const { chunks, skipped } = captureChunks(entries, cap, (e) => ({
    addresses: [...new Set(e.capture.participants.map((p) => `${p.kind}:${p.value}`))],
    stored: e.existing || e.capture.kind === 'reaction' ? 0 : e.capture.attachments.filter((a) => a.size_bytes === null || a.size_bytes <= maxBytes).length,
  }))
  for (const s of skipped) skip(s.reason)

  // (5) Per chunk: store, record (drift retried in place), delete duplicates.
  const record = async (build: (env: PreparedEnv) => Program<CaptureResult>): Promise<CaptureResult> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await execute(binding, identity, operationOf('capture.record', build(makeEnv())))).value
      } catch (err) {
        if (err instanceof UnitDriftError && attempt < MAX_DRIFT_RETRIES) continue
        throw err
      }
    }
  }
  for (const [index, chunk] of chunks.entries()) {
    const messages: CaptureMessage[] = []
    for (const e of chunk) {
      if (e.existing) {
        messages.push(e.capture)
        continue
      }
      const stored = await storeMessageContent({ organizationId: ctx.organizationId, objects: ctx.objects, streams: ctx.streams, newId: ctx.newId, attachmentMaxBytes: maxBytes }, port, conn, e.channel)
      result.orphaned_objects += stored.orphaned_objects
      messages.push({ ...e.capture, content_key: stored.content_key, preview: stored.preview, attachments: stored.attachments })
    }
    const input = { connection_id: conn.id, messages }
    const last = index === chunks.length - 1
    const out = await record((env) => (last && opts.final ? withFinal(recordMessages(env, input), opts.final) : recordMessages(env, input)))

    result.captured += out.captured.length
    result.existing += out.existing.length
    const captured = new Set(out.captured.map((c) => c.external_id))
    for (const m of messages) {
      if (!captured.has(m.external_id)) continue
      for (const a of m.attachments) if (a.fetch_status !== 'pending') result.attachments[a.fetch_status]++
    }
    for (const prefix of out.duplicate_objects) {
      try {
        await ctx.objects.delete(fileBlobKey(prefix))
      } catch {
        result.orphaned_objects++
      }
    }
  }

  if (chunks.length === 0 && opts.final) {
    for (let attempt = 0; ; attempt++) {
      try {
        await execute(binding, identity, operationOf('capture.final', opts.final))
        break
      } catch (err) {
        if (err instanceof UnitDriftError && attempt < MAX_DRIFT_RETRIES) continue
        throw err
      }
    }
  }
  return result
}

/** An attachment as the message declares it, before anything is fetched. */
function pendingAttachments(cm: ChannelMessage): CaptureAttachment[] {
  const { message, facts } = cm
  if (facts.attachments.length !== message.attachments.length) throw new Error('facts.attachments must describe message.attachments one to one')
  return facts.attachments.map((f, i) => {
    const a = message.attachments[i]!
    return {
      position: f.position,
      type: a.type,
      name: a.name ?? null,
      mime_type: a.mimeType ?? null,
      size_bytes: a.size ?? null,
      inline: f.inline,
      content_id: f.content_id,
      fetch_status: 'pending' as const,
      fetch_metadata: a.fetchMetadata ?? null,
      fetch_error: null,
      file: null,
    }
  })
}

/** The batch's one pre-check ([[CORE69]] D8 step 3): split by the cap only so an oversize page cannot throw `SetLimitExceeded`. */
async function existingExternalIds(ctx: PipelineContext, identity: StorageIdentity, externalIds: readonly string[], cap: number): Promise<Set<string>> {
  const found = new Set<string>()
  for (let at = 0; at < externalIds.length; at += cap) {
    const ids = externalIds.slice(at, at + cap)
    const op = defineOperation<string[]>({
      name: 'capture.precheck',
      mutates: false,
      reads: (qc) => {
        boundIds(qc, ids)
        return {
          existing: readSet(
            sql`select "messages"."external_id" as "external_id" from "messages"
              where "messages"."organization_id" = ${ctx.organizationId} and "messages"."channel" = ${sql.lit('email')} and ${memberOf(qc, 'messages', 'external_id', ids)}`.compile(qc.db),
          ),
        }
      },
      build: (f) => unit({ steps: [], events: [], decode: () => f.all('existing').map((r) => r.external_id as string) }),
    })
    for (const id of (await execute(ctx.binding, identity, op)).value) found.add(id)
  }
  return found
}
