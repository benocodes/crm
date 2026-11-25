import { sql } from 'kysely'
import type { BuiltIns } from '../resources/built-ins.js'
import {
  CASCADE_MAX_SET_SIZE,
  boundIds,
  coldDb,
  defineOperation,
  execute,
  memberOf,
  readSet,
  step,
  unit,
  UnitDriftError,
  type QueryContext,
  type StorageBinding,
  type StorageIdentity,
} from '@vibase/storage'
import type { ChannelMessage, ChannelPort, ConnectionRef } from '../channels/port.js'
import { operationOf, type Program } from '../identity/program.js'
import type { ObjectStore } from '../objects/store.js'
import { stringifyMarkdown } from '../channels/markdown.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import {
  recordMessages,
  type CaptureAttachment,
  type CaptureInput,
  type ContactCreation,
  type CaptureMessage,
  type CaptureParticipant,
  type CaptureResult,
} from './capture.js'
import { captureChunks, normalizeParticipants } from './capture-chunks.js'
import { messagePreview } from './preview.js'
import { fileBlobKey, messageContentPrefix } from './r2-keys.js'
import { ATTACHMENT_MAX_BYTES, storeMessageContent, type StoredContent } from './store-content.js'
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
  /** [[CORE559]] P2: the four built-ins' definitions of the deployment (the composed set of its `extend`), so the contact events of a capture carry the extension fields. Absent: the set with no `extend`. */
  builtIns?: BuiltIns
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

/** What the exclude hook sees of a read message ([[CHN407]] D5): its normalised participants and whether the connection sent it. */
export interface ExcludeFacts {
  participants: readonly CaptureParticipant[]
  sent_by_connection: boolean
}
/** Returns the skip reason that refuses the message, or null to keep it ([[CHN407]] D5, D10). */
export type ExcludeHook = (facts: ExcludeFacts) => string | null

export interface PipelineOptions {
  /** [[CHN407]] D5: judged after the message is read and normalised, before the pre-check; a reason skips the message and stores nothing. */
  exclude?: ExcludeHook
  /** [[CORE417]] D11: the connection's contact policy, passed to every capture unit of the batch; absent means `sent_and_received` (417.2). */
  contactCreation?: ContactCreation
  /** Prepared steps committed in the LAST chunk's unit, or alone when the batch yields no chunk ([[CORE69]] D10). */
  final?: Program<unknown>
}

const MAX_DRIFT_RETRIES = 2
const RESERVED_PREFIXES = ['capture:', 'resolve:']

/** One message of the batch. `read` is as the port returned it; `channel` and `capture` carry the id the batch decided for it ([[CORE574]] D6). */
interface Entry {
  read: ChannelMessage
  /** What storage sees: `read`, or `read` with the fallback id as its external id. */
  channel: ChannelMessage
  /** The capture message under its Message-ID with its fingerprint (null for a reaction). */
  base: CaptureMessage
  /** The adapter's fallback id, null when it has none or it is the Message-ID itself. */
  fallback: string | null
  capture: CaptureMessage
  existing: boolean
  /** The content stored for this entry, and the id it was stored under. */
  stored: { id: string; content: StoredContent } | null
}

/** [[CORE574]] D6: two fingerprints are the same mail unless both are known and differ. */
const sameContent = (a: string | null, b: string | null): boolean => a === null || b === null || a === b

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * [[CORE574]] D7, P1: the fingerprint of a captured message, from what the pipeline stores. The SHA-256 of the UTF-8 of
 * `JSON.stringify([subject, from, body])`: JSON tells a null subject from an empty one and cannot be split another way; `from` is the
 * first normalised from address, `body` is `stringifyMarkdown(formatted)`, the text stored as `body.md`. Lowercase hex.
 */
export async function contentFingerprint(subject: string | null, from: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([subject, from, body])))
  return hex(digest)
}

/** Where a message of the batch goes: the id it is recorded under, and whether a stored message already answers for it. */
interface Decision {
  id: string
  existing: boolean
  /** The fingerprint to store: null unless the message is new (an existing one stores nothing). */
  fingerprint: string | null
}

/**
 * [[CORE574]] D6, P4: the one fingerprint rule, applied wherever the pipeline decides a message exists. `known` is what the database holds
 * (external id to stored fingerprint), `seen` what earlier new messages of this pass will store. The Message-ID is an existing message when it
 * is known and the fingerprints are the same (or either is unknown). When they differ the mail is recorded under its fallback id, and when
 * that id is already known the mail is existing whatever the fingerprints say: within one connection a provider id is one mail.
 */
function decide(e: Entry, known: ReadonlyMap<string, string | null>, seen: Map<string, string | null>): Decision {
  const x = e.base.external_id
  const sha = e.base.content_sha256 ?? null
  const stored = known.has(x)
  const have = stored ? known.get(x)! : seen.has(x) ? seen.get(x)! : undefined
  if (have === undefined) {
    seen.set(x, sha)
    return { id: x, existing: false, fingerprint: sha }
  }
  if (sameContent(have, sha) || e.fallback === null) return { id: x, existing: stored, fingerprint: null }
  const f = e.fallback
  if (known.has(f)) return { id: f, existing: true, fingerprint: null }
  if (seen.has(f)) return { id: f, existing: false, fingerprint: null }
  seen.set(f, sha)
  return { id: f, existing: false, fingerprint: sha }
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
      const appended = extra.steps
        .filter((s) => s.label !== 'result')
        .map((s) => step(s.query, undefined, s.expect ? { expect: s.expect } : {}))
      return unit({
        steps: [...built.steps, ...appended],
        events: [...built.events, ...extra.events],
        decode: built.decode,
      })
    },
  }
}

function assertNoCollision(own: readonly string[], extra: readonly string[]): void {
  for (const key of extra) {
    if (own.includes(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p)))
      throw new Error(`the final program's read key "${key}" collides with the capture unit's`)
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
  const result: PipelineResult = {
    captured: 0,
    existing: 0,
    skipped: {},
    attachments: { stored: 0, failed: 0, skipped: 0 },
    orphaned_objects: 0,
  }
  const skip = (reason: string, n = 1) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + n
  }

  // A collision between `final`'s reads and the capture unit's is a bug in the caller: refuse it before a byte is read or stored.
  if (opts.final) {
    const qc: QueryContext = {
      db: coldDb(binding.runtime.dialect),
      dialect: binding.runtime.dialect,
      maxSetSize: binding.runtime.maxSetSize,
      maxCascadeSetSize: CASCADE_MAX_SET_SIZE,
    }
    assertNoCollision(
      Object.keys(
        recordMessages(
          makeEnv(),
          {
            source: { kind: 'connection', id: conn.id },
            channel: 'email',
            messages: [],
          },
          ctx.builtIns?.contacts,
        ).reads(qc),
      ),
      Object.keys(opts.final.reads(qc)),
    )
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
    const refusal =
      opts.exclude?.({ participants: norm.participants, sent_by_connection: facts.sent_by_connection }) ?? null
    if (refusal !== null) {
      skip(refusal)
      continue
    }
    const reaction = facts.kind === 'reaction'
    const base: CaptureMessage = {
      channel: facts.channel,
      kind: facts.kind,
      external_id: facts.external_id,
      in_reply_to: facts.in_reply_to,
      thread_hints: facts.thread_hints.slice(0, 20),
      provider_message_id: facts.provider_message_id,
      provider_thread_id: facts.provider_thread_id,
      occurred_at: facts.occurred_at,
      subject: facts.subject,
      author: {
        user_id: message.author.userId,
        user_name: message.author.userName,
        full_name: message.author.fullName,
        is_bot: message.author.isBot === true,
      },
      preview: messagePreview(message, facts.kind),
      content_key: null,
      sent_by_connection: facts.sent_by_connection,
      content_sha256: reaction
        ? null
        : await contentFingerprint(
            facts.subject,
            norm.participants.find((p) => p.role === 'from')!.value,
            stringifyMarkdown(message.formatted),
          ),
      participants: norm.participants,
      attachments: reaction ? [] : pendingAttachments(read),
    }
    entries.push({
      read,
      channel: read,
      base,
      fallback:
        facts.fallback_external_id === undefined || facts.fallback_external_id === facts.external_id
          ? null
          : facts.fallback_external_id,
      capture: base,
      existing: false,
      stored: null,
    })
  }

  // (3) One pre-check for the whole batch: which ids already exist, with their stored fingerprints (the Message-ID and the fallback id of
  // every message). Each message is then decided in input order by the one fingerprint rule ([[CORE574]] D6): a reused Message-ID with
  // other content, in the database or earlier in this batch, is captured under its fallback id.
  const known = await existingFingerprints(
    ctx,
    identity,
    [...new Set(entries.flatMap((e) => [e.base.external_id, ...(e.fallback === null ? [] : [e.fallback])]))],
    cap,
  )
  const apply = async (e: Entry, d: Decision): Promise<void> => {
    e.existing = d.existing
    e.channel =
      d.id === e.read.facts.external_id ? e.read : { ...e.read, facts: { ...e.read.facts, external_id: d.id } }
    e.capture = {
      ...e.base,
      external_id: d.id,
      content_sha256: d.fingerprint,
      ...(d.existing
        ? {
            content_key:
              e.base.kind === 'reaction' ? null : await messageContentPrefix(ctx.organizationId, e.base.channel, d.id),
          }
        : {}),
    }
  }
  const seen = new Map<string, string | null>()
  for (const e of entries) await apply(e, decide(e, known, seen))

  // (4) Chunk by what each message will store: an existing message stores nothing (its attachments stay pending).
  const { chunks, skipped } = captureChunks(entries, cap, (e) => ({
    addresses: [...new Set(e.capture.participants.map((p) => `${p.kind}:${p.value}`))],
    stored:
      e.existing || e.capture.kind === 'reaction'
        ? 0
        : e.capture.attachments.filter((a) => a.size_bytes === null || a.size_bytes <= maxBytes).length,
  }))
  for (const s of skipped) skip(s.reason)

  // Content stored for an entry whose decision then changed is no longer wanted: its attachment blobs go (the body and original sit at
  // keys derived from the id the entry no longer takes, and may now be another message's).
  const discardStored = async (e: Entry): Promise<void> => {
    if (e.stored === null) return
    for (const a of e.stored.content.attachments) {
      if (a.file === null) continue
      try {
        await ctx.objects.delete(fileBlobKey(a.file.storage_key))
      } catch {
        result.orphaned_objects++
      }
    }
    e.stored = null
  }

  // (5) Per chunk: store, record (drift retried in place, deciding the chunk's messages again), delete duplicates.
  const record = async (
    chunk: readonly Entry[],
    build: (env: PreparedEnv, messages: CaptureMessage[]) => Program<CaptureResult>,
  ): Promise<{ out: CaptureResult; messages: CaptureMessage[] }> => {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 || chunk.some((e) => !e.existing)) {
        // [[CORE574]] D6: the database may have moved since the batch was decided (a drift says it did): a message may have landed with the
        // id a chunk message is about to take, and content stored under that id would overwrite it. So before any content is stored, and
        // again on every retry, the fingerprint rule runs against what is there now.
        const fresh = await existingFingerprints(
          ctx,
          identity,
          [...new Set(chunk.flatMap((e) => [e.base.external_id, ...(e.fallback === null ? [] : [e.fallback])]))],
          cap,
        )
        const again = new Map<string, string | null>()
        for (const e of chunk) {
          const d = decide(e, fresh, again)
          if (d.id === e.capture.external_id && d.existing === e.existing) continue
          await discardStored(e)
          await apply(e, d)
        }
      }
      const messages: CaptureMessage[] = []
      for (const e of chunk) {
        if (e.existing) {
          messages.push(e.capture)
          continue
        }
        if (e.stored === null || e.stored.id !== e.capture.external_id) {
          await discardStored(e)
          const content = await storeMessageContent(
            {
              organizationId: ctx.organizationId,
              objects: ctx.objects,
              streams: ctx.streams,
              newId: ctx.newId,
              attachmentMaxBytes: maxBytes,
            },
            port,
            conn,
            e.channel,
          )
          result.orphaned_objects += content.orphaned_objects
          e.stored = { id: e.capture.external_id, content }
        }
        const { content } = e.stored
        messages.push({
          ...e.capture,
          content_key: content.content_key,
          preview: content.preview,
          attachments: content.attachments,
        })
      }
      try {
        return {
          out: (await execute(binding, identity, operationOf('capture.record', build(makeEnv(), messages)))).value,
          messages,
        }
      } catch (err) {
        if (err instanceof UnitDriftError && attempt < MAX_DRIFT_RETRIES) continue
        throw err
      }
    }
  }
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1
    const { out, messages } = await record(chunk, (env, messages) => {
      const input: CaptureInput = {
        source: { kind: 'connection', id: conn.id },
        channel: 'email',
        messages,
        ...(opts.contactCreation ? { contact_creation: opts.contactCreation } : {}),
      }
      return last && opts.final
        ? withFinal(recordMessages(env, input, ctx.builtIns?.contacts), opts.final)
        : recordMessages(env, input, ctx.builtIns?.contacts)
    })

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
  if (facts.attachments.length !== message.attachments.length)
    throw new Error('facts.attachments must describe message.attachments one to one')
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

/**
 * The batch's one pre-check ([[CORE69]] D8 step 3, [[CORE574]] D6): which `(channel, external_id)` already exist and the fingerprint each
 * stores (null when it has none). Split by the cap only so an oversize page cannot throw `SetLimitExceeded`.
 */
async function existingFingerprints(
  ctx: PipelineContext,
  identity: StorageIdentity,
  externalIds: readonly string[],
  cap: number,
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>()
  for (let at = 0; at < externalIds.length; at += cap) {
    const ids = externalIds.slice(at, at + cap)
    const op = defineOperation<Array<readonly [string, string | null]>>({
      name: 'capture.precheck',
      mutates: false,
      reads: (qc) => {
        boundIds(qc, ids)
        return {
          existing: readSet(
            sql`select "messages"."external_id" as "external_id", "messages"."content_sha256" as "content_sha256" from "messages"
              where "messages"."organization_id" = ${ctx.organizationId} and "messages"."channel" = ${sql.lit('email')} and ${memberOf(qc, 'messages', 'external_id', ids)}`.compile(
              qc.db,
            ),
          ),
        }
      },
      build: (f) =>
        unit({
          steps: [],
          events: [],
          decode: () =>
            f
              .all('existing')
              .map((r) => [r.external_id as string, (r.content_sha256 as string | null) ?? null] as const),
        }),
    })
    for (const [id, sha] of (await execute(ctx.binding, identity, op)).value as unknown as Array<
      readonly [string, string | null]
    >)
      found.set(id, sha)
  }
  return found
}
