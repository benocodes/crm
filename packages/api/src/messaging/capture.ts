import { sql, type SqlBool } from 'kysely'
import {
  assertStep,
  bind,
  boundIds,
  codecs,
  exactly,
  jsonRows,
  memberOf,
  readSet,
  step,
  unit,
  type EventReceipt,
  type Found,
  type PreparedOperation,
  type QueryContext,
  type Read,
  type Row,
  type Step,
  type Unit,
} from '@vault/storage'
import { cleanName, resolveProgram, type ResolveEntry } from '../identity/resolve.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import { operationOf, type Program } from '../identity/program.js'
import { eventSetStatement } from '../outbox.js'
import { files } from '../resources/files.js'
import { interactions } from '../resources/interactions.js'
import { messages } from '../resources/messages.js'
import { threads } from '../resources/threads.js'
import { afterOf } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { rankedHints, resolveThreads } from './thread-resolution.js'

export type CaptureRole = 'from' | 'to' | 'cc' | 'bcc'
export interface CaptureParticipant {
  kind: 'email' | 'phone'
  value: string
  name?: string
  role: CaptureRole
}
export interface CaptureFile {
  storage_key: string
  sha256: string
  size_bytes: number
  name: string
  mime_type: string
}
export interface CaptureAttachment {
  position: number
  type: 'image' | 'file' | 'video' | 'audio'
  name: string | null
  mime_type: string | null
  size_bytes: number | null
  inline: boolean
  content_id: string | null
  fetch_status: 'stored' | 'pending' | 'failed' | 'skipped'
  fetch_metadata: Record<string, string> | null
  fetch_error: string | null
  /** Non-null iff `fetch_status === 'stored'`: the fresh object. */
  file: CaptureFile | null
}
export interface CaptureMessage {
  channel: 'email'
  kind: 'message' | 'reaction'
  external_id: string
  in_reply_to: string | null
  /** At most 20, nearest first (D28). */
  thread_hints: readonly string[]
  provider_message_id: string
  provider_thread_id: string
  /** Any ISO instant; written canonical via `codecs.timestamp.write`. */
  occurred_at: string
  subject: string | null
  author: { user_id: string; user_name: string; full_name: string; is_bot: boolean }
  /** At most 200 characters (computed by the pipeline, D37). */
  preview: string
  /** Null iff `kind === 'reaction'`. */
  content_key: string | null
  sent_by_connection: boolean
  /** Normalised; at least one `from`. */
  participants: readonly CaptureParticipant[]
  attachments: readonly CaptureAttachment[]
}
export interface CaptureInput {
  connection_id: string
  messages: readonly CaptureMessage[]
}
export interface CaptureResult {
  /** In sorted order. */
  captured: Array<{ external_id: string; message_id: string; thread_id: string; interaction_id: string; new_thread: boolean }>
  /** In input order of first occurrence. */
  existing: Array<{ external_id: string; message_id: string }>
  /** `storage_key` prefixes the caller deletes (`<key>/blob`) after commit. */
  duplicate_objects: string[]
}


const KEY = (p: { kind: string; value: string }) => `${p.kind}:${p.value}`
const EMAIL = sql.lit('email')

/** Programmer errors, thrown before anything is read: the pipeline guarantees these, so a breach is a bug, not data. */
function validate(input: CaptureInput): void {
  for (const m of input.messages) {
    if (m.thread_hints.length > 20) throw new Error('thread_hints holds at most 20 entries')
    if (m.kind === 'message' && m.content_key === null) throw new Error('a message needs a content_key')
    if (m.kind === 'reaction' && m.content_key !== null) throw new Error('a reaction has no content_key')
    for (const a of m.attachments) {
      if ((a.fetch_status === 'stored') !== (a.file !== null)) throw new Error('an attachment has a file if and only if it is stored')
    }
    if (!m.participants.some((p) => p.role === 'from')) throw new Error('a message needs a from participant')
    for (const p of m.participants) {
      if (normalizeIdentityValue(p.kind, p.value) !== p.value) throw new Error('capture participants must be normalised')
    }
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * `recordMessages`: the capture unit ([[CORE25]] "Capture write path" step 5, [[CORE68]]). One prepared program per chunk that
 * composes `resolveProgram` (P7) and writes threads, files, messages, attachment links, interactions, participants and the
 * provider sources with their events in ONE atomic unit, as a constant number of set statements (D46). The plan reads what it
 * needs in one batch; the unit begins with ONE commit-time assertion (P10) that the plan still describes the database, so a
 * concurrent writer makes the unit fail as drift (`409`) and a retry plans again. Messages are sorted by `(occurred_at,
 * external_id)` so an in-chunk parent precedes its reply (D16).
 */
export function recordMessages(env: PreparedEnv, input: CaptureInput): Program<CaptureResult> {
  validate(input)
  const at = codecs.timestamp.write(env.now)
  const org = env.organizationId
  const actor = env.actor.id
  const connection = input.connection_id

  const sorted = input.messages
    .map((m, index) => ({ m, index, occurred: codecs.timestamp.write(m.occurred_at) }))
    .sort((a, b) => compareText(a.occurred, b.occurred) || compareText(a.m.external_id, b.m.external_id) || a.index - b.index)

  // The chunk's distinct addresses in first-occurrence order (the first non-blank name wins), and its stored files.
  const addresses = new Map<string, ResolveEntry>()
  for (const { m } of sorted) {
    for (const p of m.participants) {
      const k = KEY(p)
      const known = addresses.get(k)
      if (!known) addresses.set(k, { kind: p.kind, value: p.value, ...(cleanName(p.name) ? { name: p.name! } : {}) })
      else if (known.name === undefined && cleanName(p.name)) known.name = p.name!
    }
  }
  const resolve = resolveProgram(env, [...addresses.values()])
  const storedShas = input.messages.flatMap((m) => m.attachments.filter((a) => a.file !== null).map((a) => a.file!.sha256))
  const keys = input.messages.map((m) => m.external_id)
  const providerThreads = [...new Set(input.messages.map((m) => m.provider_thread_id))]

  const READ = { existing: 'capture:existing', aliases: 'capture:aliases', ancestors: 'capture:ancestors', files: 'capture:files', identities: 'capture:identities' } as const

  return {
    reads(qc: QueryContext): Readonly<Record<string, Read>> {
      boundIds(qc, keys)
      boundIds(qc, [...addresses.keys()])
      boundIds(qc, storedShas)
      const hintRows = sorted.flatMap(({ m }) => rankedHints(m).map((hint, rk) => ({ msg: m.external_id, rk, hint })))
      const hints = jsonRows(qc, 'h', { msg: 'text', rk: 'integer', hint: 'text' }, hintRows)
      const existing = sql`
        select "messages"."id" as "id", "messages"."thread_id" as "thread_id", "messages"."external_id" as "external_id" from "messages"
        where "messages"."organization_id" = ${org} and "messages"."channel" = ${EMAIL} and ${memberOf(qc, 'messages', 'external_id', keys)}`.compile(qc.db)
      const aliases = sql`
        select "thread_sources"."thread_id" as "thread_id", "thread_sources"."provider_thread_id" as "provider_thread_id" from "thread_sources"
        where "thread_sources"."organization_id" = ${org} and "thread_sources"."connection_id" = ${connection} and ${memberOf(qc, 'thread_sources', 'provider_thread_id', providerThreads)}`.compile(qc.db)
      // Per message the nearest hint that exists (lowest rank): a window function, portable to both dialects.
      const ancestors = sql`
        select "t"."msg" as "msg", "t"."rk" as "rk", "t"."thread_id" as "thread_id" from (
          select "h"."msg" as "msg", "h"."rk" as "rk", "m"."thread_id" as "thread_id",
            row_number() over (partition by "h"."msg" order by "h"."rk") as "rn"
          from ${hints}
          join "messages" as "m" on "m"."organization_id" = ${org} and "m"."channel" = ${EMAIL} and "m"."external_id" = "h"."hint"
        ) as "t" where "t"."rn" = 1`.compile(qc.db)
      const knownFiles = sql`
        select "files"."sha256" as "sha256", min("files"."storage_key") as "storage_key" from "files"
        where "files"."organization_id" = ${org} and ${memberOf(qc, 'files', 'sha256', storedShas)}
        group by "files"."sha256"`.compile(qc.db)
      const identities = sql`
        select "identities"."id" as "id", "identities"."kind" as "kind", "identities"."value" as "value", "identities"."own" as "own" from "identities"
        where "identities"."organization_id" = ${org} and "identities"."deleted_at" is null and ${memberOf(qc, 'identities', 'value', [...addresses.values()].map((a) => a.value))}`.compile(qc.db)
      return {
        ...resolve.reads(qc),
        [READ.existing]: readSet(existing),
        [READ.aliases]: readSet(aliases),
        [READ.ancestors]: readSet(ancestors),
        [READ.files]: readSet(knownFiles),
        [READ.identities]: readSet(identities),
      }
    },

    build(found: Found, qc: QueryContext): Unit<CaptureResult> {
      // resolve's statements first (its events precede ours, D16); its result select and decoder are not ours (P7).
      const resolved = resolve.build(found, qc)
      const resolveSteps: Step[] = resolved.steps.filter((s) => s.label !== 'result')

      const dbMessages = new Map<string, { id: string; thread_id: string }>()
      for (const r of found.all(READ.existing)) dbMessages.set(r.external_id as string, { id: r.id as string, thread_id: r.thread_id as string })
      const dbAliases = new Map<string, string>()
      for (const r of found.all(READ.aliases)) dbAliases.set(r.provider_thread_id as string, r.thread_id as string)
      const dbAncestors = new Map<string, { rank: number; thread_id: string }>()
      for (const r of found.all(READ.ancestors)) dbAncestors.set(r.msg as string, { rank: Number(r.rk), thread_id: r.thread_id as string })
      const dbFiles = new Map<string, string>()
      for (const r of found.all(READ.files)) dbFiles.set(r.sha256 as string, r.storage_key as string)
      const dbIdentities = new Map<string, { id: string; own: boolean }>()
      for (const r of found.all(READ.identities)) dbIdentities.set(KEY({ kind: r.kind as string, value: r.value as string }), { id: r.id as string, own: r.own === true || r.own === 1 })

      // Threads (D3).
      const resolution = resolveThreads(
        sorted.map(({ m }) => ({ external_id: m.external_id, in_reply_to: m.in_reply_to, thread_hints: m.thread_hints, provider_thread_id: m.provider_thread_id, subject: m.subject })),
        { existing: new Map([...dbMessages].map(([k, v]) => [k, v.thread_id])), aliases: dbAliases, ancestors: dbAncestors },
        () => env.newId(),
      )

      // Ids, messages and blobs, in sorted order.
      type Row_ = { m: CaptureMessage; occurred: string; index: number; thread_id: string; outcome: string; message_id: string; isNew: boolean; interaction_id: string }
      const chunkMessageIds = new Map<string, string>()
      const rows: Row_[] = sorted.map((s, i) => {
        const d = resolution.decisions[i]!
        const isNew = d.outcome !== 'existing'
        const message_id = isNew ? env.newId() : (dbMessages.get(s.m.external_id)?.id ?? chunkMessageIds.get(s.m.external_id)!)
        if (isNew) chunkMessageIds.set(s.m.external_id, message_id)
        return { m: s.m, occurred: s.occurred, index: s.index, thread_id: d.thread_id, outcome: d.outcome, message_id, isNew, interaction_id: isNew ? env.newId() : '' }
      })
      const fresh = rows.filter((r) => r.isNew)

      const duplicateObjects: string[] = []
      const assigned = new Map<string, string>() // sha256 -> the key this chunk's earlier file rows carry
      const newBlobShas: string[] = []
      const fileRows: Array<{ id: string; name: string; mime_type: string; size_bytes: number; sha256: string; storage_key: string }> = []
      const attachmentRows: Array<Record<string, unknown>> = []
      for (const r of rows) {
        const atts = [...r.m.attachments].sort((a, b) => a.position - b.position)
        if (!r.isNew) {
          for (const a of atts) if (a.file) duplicateObjects.push(a.file.storage_key)
          continue
        }
        for (const a of atts) {
          let fileId: string | null = null
          if (a.file) {
            const known = dbFiles.get(a.file.sha256) ?? assigned.get(a.file.sha256)
            let key = a.file.storage_key
            if (known !== undefined) {
              key = known
              duplicateObjects.push(a.file.storage_key)
            } else {
              assigned.set(a.file.sha256, key)
              newBlobShas.push(a.file.sha256)
            }
            fileId = env.newId()
            fileRows.push({ id: fileId, name: a.file.name, mime_type: a.file.mime_type, size_bytes: a.file.size_bytes, sha256: a.file.sha256, storage_key: key })
          }
          attachmentRows.push({
            id: env.newId(),
            message_id: r.message_id,
            position: a.position,
            file_id: fileId,
            type: a.type,
            name: a.name,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
            inline: a.inline,
            content_id: a.content_id,
            fetch_status: a.fetch_status,
            fetch_metadata: a.fetch_metadata,
            fetch_error: a.fetch_error,
          })
        }
      }

      // Direction (D9): the connection said so, else the sender's planned identity is one of ours.
      const direction = (m: CaptureMessage): 'inbound' | 'outbound' => {
        if (m.sent_by_connection) return 'outbound'
        const from = m.participants.find((p) => p.role === 'from')!
        return dbIdentities.get(KEY(from))?.own ? 'outbound' : 'inbound'
      }

      // Participants (D24): one row per (interaction, role, kind, value).
      const participantRows = fresh.flatMap((r) => {
        const seen = new Set<string>()
        const out: Array<{ id: string; interaction_id: string; role: string; kind: string; value: string }> = []
        for (const p of r.m.participants) {
          const k = `${p.role}|${KEY(p)}`
          if (seen.has(k)) continue
          seen.add(k)
          out.push({ id: env.newId(), interaction_id: r.interaction_id, role: p.role, kind: p.kind, value: p.value })
        }
        return out
      })

      const messageSourceRows = rows.map((r) => ({ id: env.newId(), message_id: r.message_id, pm: r.m.provider_message_id, pt: r.m.provider_thread_id }))
      const threadSourceRows = resolution.aliases_to_add.map((a) => ({ id: env.newId(), thread_id: a.thread_id, pt: a.provider_thread_id }))

      // Event ids, in the type order of the unit: thread, message, file, interaction (D16).
      const threadEvents = resolution.new_threads.map((t) => ({ eventId: env.newId(), resourceId: t.thread_id, before: null }))
      const messageEvents = fresh.map((r) => ({ eventId: env.newId(), resourceId: r.message_id, before: null }))
      const fileEvents = fileRows.map((f) => ({ eventId: env.newId(), resourceId: f.id, before: null }))
      const interactionEvents = fresh.map((r) => ({ eventId: env.newId(), resourceId: r.interaction_id, before: null }))

      const T = (kind: 'uuid' | 'timestamp', v: string) => bind(qc, kind, v)
      const stamp = () => T('timestamp', at)
      const orgP = () => T('uuid', org)
      const actorP = () => T('uuid', actor)

      // P10: the one commit-time assertion, before our first INSERT, holding every clause the plan relied on.
      const noneStillPresent = (table: 'messages' | 'files', column: 'external_id' | 'sha256', values: readonly string[]) =>
        sql<SqlBool>`not exists (select 1 from ${sql.table(table)} where ${sql.ref(`${table}.organization_id`)} = ${org} and ${table === 'messages' ? sql`${sql.ref('messages.channel')} = ${EMAIL} and ` : sql``}${memberOf(qc, table, column as never, values)})`
      const aliasesAsPlanned = sql<SqlBool>`not exists (
        select 1 from ${jsonRows(qc, 'a', { pt: 'text', thread_id: 'text' }, providerThreads.map((pt) => ({ pt, thread_id: dbAliases.get(pt) ?? null })))}
        where coalesce((select cast("thread_sources"."thread_id" as text) from "thread_sources"
          where "thread_sources"."organization_id" = ${org} and "thread_sources"."connection_id" = ${connection} and "thread_sources"."provider_thread_id" = "a"."pt"), '') <> coalesce("a"."thread_id", ''))`
      const plannedIdentities = [...dbIdentities.values()]
      const identitiesAsPlanned = sql<SqlBool>`(select count(*) from ${jsonRows(qc, 'p', { id: 'uuid', own: 'boolean' }, plannedIdentities)}
        join "identities" on "identities"."id" = "p"."id" and "identities"."organization_id" = ${org} and "identities"."deleted_at" is null and "identities"."own" = "p"."own") = ${sql.lit(plannedIdentities.length)}`
      const assertion = assertStep(
        qc,
        sql<SqlBool>`${noneStillPresent('messages', 'external_id', resolution.absent)} and ${aliasesAsPlanned} and ${noneStillPresent('files', 'sha256', newBlobShas)} and ${identitiesAsPlanned}`,
      )

      const firstMutation = resolveSteps.length === 0 ? ('first-mutation' as const) : undefined
      const firstEvent = resolveSteps.length === 0 ? ('first-event' as const) : undefined

      const threadSet = jsonRows(qc, 'r', { id: 'uuid', subject: 'text' }, resolution.new_threads.map((t) => ({ id: t.thread_id, subject: t.subject })))
      const fileSet = jsonRows(qc, 'r', { id: 'uuid', name: 'text', mime_type: 'text', size_bytes: 'integer', sha256: 'text', storage_key: 'text' }, fileRows)
      const messageSet = jsonRows(
        qc,
        'r',
        { id: 'uuid', thread_id: 'uuid', kind: 'text', external_id: 'text', in_reply_to: 'text', author: 'json', occurred_at: 'timestamp', preview: 'text', content_key: 'text' },
        fresh.map((r) => ({ id: r.message_id, thread_id: r.thread_id, kind: r.m.kind, external_id: r.m.external_id, in_reply_to: r.m.in_reply_to, author: r.m.author, occurred_at: r.occurred, preview: r.m.preview, content_key: r.m.content_key })),
      )
      const attachmentSet = jsonRows(
        qc,
        'r',
        { id: 'uuid', message_id: 'uuid', position: 'integer', file_id: 'uuid', type: 'text', name: 'text', mime_type: 'text', size_bytes: 'integer', inline: 'boolean', content_id: 'text', fetch_status: 'text', fetch_metadata: 'json', fetch_error: 'text' },
        attachmentRows,
      )
      const interactionSet = jsonRows(
        qc,
        'r',
        { id: 'uuid', kind: 'text', direction: 'text', occurred_at: 'timestamp', thread_id: 'uuid', message_id: 'uuid' },
        fresh.map((r) => ({ id: r.interaction_id, kind: r.m.kind, direction: direction(r.m), occurred_at: r.occurred, thread_id: r.thread_id, message_id: r.message_id })),
      )
      const participantSet = jsonRows(qc, 'r', { id: 'uuid', interaction_id: 'uuid', role: 'text', kind: 'text', value: 'text' }, participantRows)
      const messageSourceSet = jsonRows(qc, 'r', { id: 'uuid', message_id: 'uuid', pm: 'text', pt: 'text' }, messageSourceRows)
      const threadSourceSet = jsonRows(qc, 'r', { id: 'uuid', thread_id: 'uuid', pt: 'text' }, threadSourceRows)
      const R = (c: string) => sql.ref(`r.${c}`)

      const steps: Step[] = [
        ...resolveSteps,
        assertion,
        step(
          sql`insert into "threads" ("id", "created_at", "organization_id", "created_by", "channel", "subject")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${EMAIL}, ${R('subject')} from ${threadSet} order by ${R('ord')}`.compile(qc.db),
          firstMutation,
        ),
        step(
          sql`insert into "files" ("id", "created_at", "organization_id", "created_by", "name", "mime_type", "size_bytes", "sha256", "storage_key")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('name')}, ${R('mime_type')}, ${R('size_bytes')}, ${R('sha256')}, ${R('storage_key')} from ${fileSet} order by ${R('ord')}`.compile(qc.db),
        ),
        ...exactly(
          qc,
          step(
            sql`insert into "messages" ("id", "created_at", "organization_id", "created_by", "thread_id", "channel", "kind", "external_id", "in_reply_to", "author", "occurred_at", "preview", "content_key", "version", "retracted_at")
              select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('thread_id')}, ${EMAIL}, ${R('kind')}, ${R('external_id')}, ${R('in_reply_to')}, ${R('author')}, ${R('occurred_at')}, ${R('preview')}, ${R('content_key')}, ${bind(qc, 'integer', 1)}, ${bind(qc, 'timestamp', null)}
              from ${messageSet} where true order by ${R('ord')}
              on conflict ("organization_id", "channel", "external_id") do nothing`.compile(qc.db),
          ),
          fresh.length,
        ),
        step(
          sql`insert into "message_attachments" ("id", "created_at", "organization_id", "created_by", "message_id", "position", "file_id", "type", "name", "mime_type", "size_bytes", "inline", "content_id", "fetch_status", "fetch_metadata", "fetch_error")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('message_id')}, ${R('position')}, ${R('file_id')}, ${R('type')}, ${R('name')}, ${R('mime_type')}, ${R('size_bytes')}, ${R('inline')}, ${R('content_id')}, ${R('fetch_status')}, ${R('fetch_metadata')}, ${R('fetch_error')}
            from ${attachmentSet} order by ${R('ord')}`.compile(qc.db),
        ),
        step(
          sql`insert into "interactions" ("id", "created_at", "organization_id", "created_by", "kind", "channel", "direction", "occurred_at", "thread_id", "message_id")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('kind')}, ${EMAIL}, ${R('direction')}, ${R('occurred_at')}, ${R('thread_id')}, ${R('message_id')}
            from ${interactionSet} order by ${R('ord')}`.compile(qc.db),
        ),
        ...exactly(
          qc,
          step(
            sql`insert into "interaction_participants" ("id", "created_at", "organization_id", "created_by", "interaction_id", "identity_id", "role")
              select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('interaction_id')}, "i"."id", ${R('role')}
              from ${participantSet}
              join "identities" as "i" on "i"."organization_id" = ${org} and "i"."kind" = ${R('kind')} and "i"."value" = ${R('value')} and "i"."deleted_at" is null
              order by ${R('ord')}`.compile(qc.db),
          ),
          participantRows.length,
        ),
        step(
          sql`insert into "message_sources" ("id", "created_at", "organization_id", "created_by", "message_id", "connection_id", "provider_message_id", "provider_thread_id")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('message_id')}, ${T('uuid', connection)}, ${R('pm')}, ${R('pt')}
            from ${messageSourceSet} where true order by ${R('ord')}
            on conflict ("organization_id", "connection_id", "provider_message_id") do nothing`.compile(qc.db),
        ),
        step(
          sql`insert into "thread_sources" ("id", "created_at", "organization_id", "created_by", "thread_id", "connection_id", "provider_thread_id")
            select ${R('id')}, ${stamp()}, ${orgP()}, ${actorP()}, ${R('thread_id')}, ${T('uuid', connection)}, ${R('pt')}
            from ${threadSourceSet} where true order by ${R('ord')}
            on conflict ("organization_id", "connection_id", "provider_thread_id") do nothing`.compile(qc.db),
        ),
        ...(
          [
            ['thread', threads, threadEvents, firstEvent],
            ['message', messages, messageEvents, undefined],
            ['file', files, fileEvents, undefined],
            ['interaction', interactions, interactionEvents, undefined],
          ] as const
        ).map(([eventName, def, rowsOf, label]) =>
          step(eventSetStatement(qc, { at, organizationId: org, actorId: actor, type: `${eventName}.created`, resourceType: eventName, after: afterOf(def), rows: rowsOf }), label),
        ),
      ]

      const receipts = (type: string, resourceType: string, rowsOf: readonly { eventId: string; resourceId: string }[]): EventReceipt[] =>
        rowsOf.map((r) => ({ id: r.eventId, type, resourceType, resourceId: r.resourceId }))
      const events: EventReceipt[] = [
        ...resolved.events,
        ...receipts('thread.created', 'thread', threadEvents),
        ...receipts('message.created', 'message', messageEvents),
        ...receipts('file.created', 'file', fileEvents),
        ...receipts('interaction.created', 'interaction', interactionEvents),
      ]

      const byIndex = new Map(rows.map((r) => [r.index, r]))
      const value = ((): CaptureResult => {
        const existing: CaptureResult['existing'] = []
        const listed = new Set<string>()
        for (let i = 0; i < input.messages.length; i++) {
          const r = byIndex.get(i)!
          if (r.isNew || listed.has(r.m.external_id)) continue
          listed.add(r.m.external_id)
          existing.push({ external_id: r.m.external_id, message_id: r.message_id })
        }
        return {
          captured: fresh.map((r) => ({ external_id: r.m.external_id, message_id: r.message_id, thread_id: r.thread_id, interaction_id: r.interaction_id, new_thread: r.outcome === 'new' })),
          existing,
          duplicate_objects: duplicateObjects,
        }
      })()

      return unit({ steps, events, decode: (_rows: readonly Row[]) => value })
    },
  }
}

/** `recordMessages` as one prepared mutating unit (P18): not a registry operation, no route creates these rows (D26). */
export function recordMessagesOperation(env: PreparedEnv, input: CaptureInput): PreparedOperation<CaptureResult> {
  return operationOf('capture.record', recordMessages(env, input))
}
