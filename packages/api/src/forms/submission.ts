import { sql } from 'kysely'
import {
  boundIds,
  CommitOutcomeUnknown,
  defineOperation,
  execute,
  exactly,
  jsonRows,
  memberOf,
  readMaybe,
  readSet,
  recordColumns,
  step,
  unit,
  UnitDriftError,
  StatementFailed,
  codecs,
  bind,
  type EventReceipt,
  type Found,
  type QueryContext,
  type Read,
  type StorageBinding,
  type StorageIdentity,
  type Unit,
  type Step,
} from '@vibase/storage'
import { ApiError } from '../errors.js'
import type { Program } from '../identity/program.js'
import { operationOf } from '../identity/program.js'
import { eventSetStatement } from '../outbox.js'
import type { ChannelPort } from '../channels/port.js'
import type { ObjectStore } from '../objects/store.js'
import { contacts, type ContactRecord } from '../resources/contacts.js'
import { ScopeSet } from '../scopes.js'
import { associations } from '../associations/definition.js'
import { afterOf, columnsOf, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { recordMessages, type CaptureMessage, type CaptureResult } from '../messaging/capture.js'
import { messageBodyKey, messageContentPrefix, messageOriginalKey } from '../messaging/r2-keys.js'
import { storeMessageContent } from '../messaging/store-content.js'
import type { StreamPrimitives } from '../messaging/streams.js'
import type { FormIngress } from './ingress-read.js'
import { formSubmitter, mapFormSubmission, type FormSubmissionInput, type FormSubmitter } from './map-submission.js'

// [[CHN428]]: the capture unit of a form submission ([[CHN421]] D8, D9, D14, D17, D18). Dormant: no non-test module calls it
// until [[CHN429]]'s route does (P5, 428.6). D1 only, as `formIngressRead` is.

export interface FormSubmissionContext {
  binding: StorageBinding
  organizationId: string
  objects: ObjectStore
  streams: StreamPrimitives
  clock: () => Date
  newId: () => string
  randomBytes: (n: number) => Uint8Array
}

export interface FormCaptureResult {
  message_id: string
  thread_id: string
  interaction_id: string
  new_thread: boolean
}

/** D18: "retried once" is two attempts (P4, 428.5). Not the pipeline's `MAX_DRIFT_RETRIES`, which allows three. */
const ATTEMPTS = 2

/**
 * What a concurrent writer causes ([[CORE36]] P4): drift, or a unique-index failure of the unit's own insert (two first submissions from one address both insert the
 * identity before either's assertion runs). Both are retried by planning again.
 */
const isRace = (err: unknown): boolean =>
  err instanceof UnitDriftError || (err instanceof StatementFailed && err.kind === 'unique')

const unavailable = () =>
  new ApiError(503, 'temporarily_unavailable', 'the submission could not be recorded; try again')

/** The unit's identity and actor are the form's principal (D18, [[CHN420]] D5): `{ id: form_id, kind: 'agent' }`. */
const identityOf = (ctx: FormSubmissionContext, form: FormIngress): StorageIdentity => ({
  kind: 'tenant',
  actorId: form.form_id,
  organizationId: ctx.organizationId,
})

// ---- the blocklist (D17, P2) -------------------------------------------------------------------------------

/** The address itself, then its domain and every parent domain: a blocked domain matches itself and its subdomains ([[CHN407]] D9). */
function blocklistCandidates(address: string): { address: string; domains: string[] } {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  const parts = domain.split('.')
  return { address, domains: parts.map((_, i) => parts.slice(i).join('.')) }
}

/**
 * D17: whether the submitter's address, or its domain by [[CHN407]]'s rule (the domain or a subdomain of it), is on the WORKSPACE blocklist's live
 * entries. A connection's own entries never apply (`connection_blocked_senders` is not read). A phone is never blocked. A read, made once before the
 * unit and not again inside it (P2, 428.3).
 */
export async function formSubmitterBlocked(
  ctx: FormSubmissionContext,
  form: FormIngress,
  submitter: FormSubmitter,
): Promise<boolean> {
  if (submitter.kind !== 'email') return false
  const { address, domains } = blocklistCandidates(submitter.value)
  const org = ctx.organizationId
  const op = defineOperation<boolean>({
    name: 'forms.submitter_blocked',
    mutates: false,
    reads: (qc) => {
      boundIds(qc, domains)
      const hit = sql`select 1 as "hit" from "blocked_senders"
        where "blocked_senders"."organization_id" = ${org} and "blocked_senders"."deleted_at" is null and (
          ("blocked_senders"."kind" = 'address' and "blocked_senders"."value" = ${address})
          or ("blocked_senders"."kind" = 'domain' and ${memberOf(qc, 'blocked_senders', 'value', domains)}))
        limit 1`.compile(qc.db)
      return { hit: readMaybe(hit) }
    },
    build: (found) => unit({ steps: [], events: [], decode: () => found.maybe('hit') !== null }),
  })
  return (await execute(ctx.binding, identityOf(ctx, form), op)).value
}

// ---- the program: recordMessages plus the contact additions (D14, P3) --------------------------------------

const contactColumns = columnsOf(contacts)
const C = 'c_'
const READ = { contact: 'form:contact', links: 'form:links' } as const

/**
 * `recordMessages` for one form message with the two additions of D14 composed after it in the same unit (428.4 P3): the name fill of an existing
 * contact whose name is null, and the form's live tags not yet linked. Event order: resolve's, capture's (thread, message, file, interaction), then
 * `contact.updated`, then each `association.created` in tag id order. Both additions are guarded in SQL and counted, so a concurrent writer between plan
 * and commit makes the unit fail as drift and the retry plans again: a name written meanwhile is never overwritten, a link added meanwhile is never doubled.
 */
function formUnitProgram(
  env: PreparedEnv,
  form: FormIngress,
  submitter: FormSubmitter,
  message: CaptureMessage,
): Program<CaptureResult> {
  const capture = recordMessages(env, {
    source: { kind: 'form', id: form.form_id },
    channel: 'form',
    messages: [message],
  })
  const org = env.organizationId
  const actor = env.actor.id
  const at = codecs.timestamp.write(env.now)
  return {
    reads(qc): Readonly<Record<string, Read>> {
      const contact = sql`
        select "identities"."own" as "own", "identities"."contact_id" as "contact_id", ${sql.join(recordColumns(qc, 'contacts', contactColumns, C))}
        from "identities"
        left join "contacts" on "contacts"."id" = "identities"."contact_id" and "contacts"."organization_id" = "identities"."organization_id"
          and "contacts"."deleted_at" is null and "contacts"."merged_into_id" is null
        where "identities"."organization_id" = ${org} and "identities"."kind" = ${submitter.kind} and "identities"."value" = ${submitter.value}
          and "identities"."deleted_at" is null`.compile(qc.db)
      boundIds(qc, form.tag_ids)
      const links = sql`
        select "associations"."b_id" as "tag_id" from "identities"
        join "associations" on "associations"."organization_id" = "identities"."organization_id" and "associations"."a_type" = 'contact'
          and "associations"."a_id" = "identities"."contact_id" and "associations"."b_type" = 'tag' and "associations"."relation" = 'related_to'
          and "associations"."deleted_at" is null and ${memberOf(qc, 'associations', 'b_id', form.tag_ids)}
        where "identities"."organization_id" = ${org} and "identities"."kind" = ${submitter.kind} and "identities"."value" = ${submitter.value}
          and "identities"."deleted_at" is null`.compile(qc.db)
      return { ...capture.reads(qc), [READ.contact]: readMaybe(contact), [READ.links]: readSet(links) }
    },
    build(found: Found, qc: QueryContext): Unit<CaptureResult> {
      const base = capture.build(found, qc)
      const row = found.maybe(READ.contact)
      const known =
        row !== null && row.own !== true && row.own !== 1 && row.contact_id !== null && row[`${C}id`] !== null
      const before: ContactRecord | null = known ? toRecord(contacts, contactRow(row!)) : null

      // Fill: an existing contact with a null name takes the submission's name; a promoted or new contact already got it from resolve.
      const fill = before !== null && before.name === null && submitter.name !== undefined ? before : null
      // Links: every live tag of the form the contact does not hold. A new, promoted or unattached-then-promoted contact holds none.
      const holds = new Set(known ? found.all(READ.links).map((r) => String(r.tag_id)) : [])
      const own = row !== null && (row.own === true || row.own === 1)
      const toLink = own ? [] : form.tag_ids.filter((t) => !holds.has(t)).map((tag_id) => ({ id: env.newId(), tag_id }))
      const fillEvent = fill ? env.newId() : null
      const linkEvents = toLink.map((l) => ({ eventId: env.newId(), resourceId: l.id, before: null }))

      const steps: Step[] = [...base.steps]
      const events: EventReceipt[] = [...base.events]
      if (fill && fillEvent) {
        steps.push(
          ...exactly(
            qc,
            step(
              // The guard is the whole point: `name is null` (never overwrite), the contact still the identity's live, unmerged one.
              sql`update "contacts" set "name" = ${bind(qc, 'text', submitter.name!)}, "updated_at" = ${bind(qc, 'timestamp', at)}
                where "contacts"."id" = ${bind(qc, 'uuid', fill.id)} and "contacts"."organization_id" = ${bind(qc, 'uuid', org)}
                  and "contacts"."name" is null and "contacts"."deleted_at" is null and "contacts"."merged_into_id" is null
                  and "contacts"."id" in (select "identities"."contact_id" from "identities" where "identities"."organization_id" = ${bind(qc, 'uuid', org)}
                    and "identities"."kind" = ${submitter.kind} and "identities"."value" = ${submitter.value} and "identities"."deleted_at" is null)`.compile(
                qc.db,
              ),
            ),
            1,
          ),
          step(
            eventSetStatement(qc, {
              at,
              organizationId: org,
              actorId: actor,
              type: 'contact.updated',
              resourceType: 'contact',
              after: { table: 'contacts', columns: contactColumns },
              rows: [{ eventId: fillEvent, resourceId: fill.id, before: fill as unknown as Record<string, unknown> }],
            }),
          ),
        )
        events.push({ id: fillEvent, type: 'contact.updated', resourceType: 'contact', resourceId: fill.id })
      }
      if (toLink.length > 0) {
        const set = jsonRows(qc, 'r', { id: 'uuid', tag_id: 'uuid' }, toLink)
        const R = (c: string) => sql.ref(`r.${c}`)
        // The contact is whichever the identity holds at commit (a new contact exists only inside this unit). `contact` sorts before `tag`, so the
        // contact is the `a` end ([[CORE62]] D2, canonical order by type). Skips a link that exists live or a tag no longer live; `exactly` then drifts.
        steps.push(
          ...exactly(
            qc,
            step(
              sql`insert into "associations" ("id", "created_at", "updated_at", "organization_id", "created_by", "a_type", "a_id", "b_type", "b_id", "relation")
                select ${R('id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', org)}, ${bind(qc, 'uuid', actor)}, 'contact', "i"."contact_id", 'tag', ${R('tag_id')}, 'related_to'
                from ${set}
                join "identities" as "i" on "i"."organization_id" = ${org} and "i"."kind" = ${submitter.kind} and "i"."value" = ${submitter.value}
                  and "i"."deleted_at" is null and "i"."contact_id" is not null
                where not exists (select 1 from "associations" as "a" where "a"."organization_id" = ${org} and "a"."a_type" = 'contact' and "a"."a_id" = "i"."contact_id"
                    and "a"."b_type" = 'tag' and "a"."b_id" = ${R('tag_id')} and "a"."relation" = 'related_to' and "a"."deleted_at" is null)
                  and exists (select 1 from "tags" where "tags"."id" = ${R('tag_id')} and "tags"."organization_id" = ${org} and "tags"."deleted_at" is null)
                order by ${R('ord')}`.compile(qc.db),
            ),
            toLink.length,
          ),
          step(
            eventSetStatement(qc, {
              at,
              organizationId: org,
              actorId: actor,
              type: 'association.created',
              resourceType: 'association',
              after: afterOf(associations),
              rows: linkEvents,
            }),
          ),
        )
        for (const e of linkEvents)
          events.push({
            id: e.eventId,
            type: 'association.created',
            resourceType: 'association',
            resourceId: e.resourceId,
          })
      }
      return unit({ steps, events, decode: base.decode })
    },
  }
}

const contactRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const c of contactColumns) out[c] = row[`${C}${c}`]
  return out
}

// ---- the capture (D18) -------------------------------------------------------------------------------------

/** A form has no connection and no attachments: the content store never calls this port. */
const formPort: ChannelPort = {
  channel: 'form',
  readMessage: async () => ({ skip: 'not_readable' }),
  fetchAttachment: async () => {
    throw new Error('a form submission has no attachments')
  },
}

/**
 * Captures one accepted submission ([[CHN421]] D18). Derives the submitter (a refusal is `400 validation_error`, nothing stored), stores body and original at the
 * deterministic keys, then runs ONE unit as the form's principal, two attempts on drift that reuse the stored content (P4). A failure deletes the stored objects
 * best-effort (a failing delete never masks the error) and surfaces `503 temporarily_unavailable`; a commit of unknown outcome keeps them (the unit may have landed).
 */
export async function captureFormSubmission(
  ctx: FormSubmissionContext,
  input: FormSubmissionInput,
): Promise<FormCaptureResult> {
  const submitter = formSubmitter(input.form, input.fields)
  const cm = mapFormSubmission(input, submitter)
  const identity = identityOf(ctx, input.form)
  const makeEnv = (): PreparedEnv => ({
    actor: { id: input.form.form_id, kind: 'agent' },
    organizationId: ctx.organizationId,
    scopes: ScopeSet.parse([]),
    now: ctx.clock(),
    newId: ctx.newId,
    randomBytes: ctx.randomBytes,
  })
  // Known before anything is stored, so a store that fails half way still has its keys cleaned up.
  const contentKey = await messageContentPrefix(ctx.organizationId, 'form', input.submission_id)
  const cleanup = async () => {
    try {
      await ctx.objects.delete([messageBodyKey(contentKey, 1), messageOriginalKey(contentKey, 1, 'json')])
    } catch {
      // best effort: the objects are unreferenced, and the original error is the one that matters
    }
  }
  try {
    const stored = await storeMessageContent(
      { organizationId: ctx.organizationId, objects: ctx.objects, streams: ctx.streams, newId: ctx.newId },
      formPort,
      { id: input.form.form_id },
      cm,
    )
    const facts = cm.facts
    const message: CaptureMessage = {
      channel: 'form',
      kind: 'message',
      external_id: facts.external_id,
      in_reply_to: null,
      thread_hints: [],
      provider_message_id: facts.provider_message_id,
      provider_thread_id: facts.provider_thread_id,
      occurred_at: facts.occurred_at,
      subject: facts.subject,
      author: {
        user_id: cm.message.author.userId,
        user_name: cm.message.author.userName,
        full_name: cm.message.author.fullName,
        is_bot: false,
      },
      preview: stored.preview,
      content_key: stored.content_key,
      sent_by_connection: false,
      direction: 'inbound',
      participants: facts.participants,
      attachments: [],
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await execute(
          ctx.binding,
          identity,
          operationOf('forms.capture_submission', formUnitProgram(makeEnv(), input.form, submitter, message)),
        )
        const c = out.value.captured[0]
        if (!c) throw new Error('the form capture unit recorded no message')
        return {
          message_id: c.message_id,
          thread_id: c.thread_id,
          interaction_id: c.interaction_id,
          new_thread: c.new_thread,
        }
      } catch (err) {
        if (isRace(err) && attempt < ATTEMPTS) continue
        throw err
      }
    }
  } catch (err) {
    // The unit may have committed: its content must stay.
    if (!(err instanceof CommitOutcomeUnknown)) await cleanup()
    throw unavailable()
  }
}
