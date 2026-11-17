import { sql, type SqlBool } from 'kysely'
import { z } from 'zod'
import {
  UnitDriftError,
  appliedPrev,
  assertStep,
  codecs,
  defineOperation,
  readAll,
  readMaybe,
  step,
  ts,
  unit,
  type PreparedOperation,
  type QueryContext,
  type Read,
  type Row,
  type Step,
  type Unit,
} from '@vibase/storage'
import { ApiError } from '../errors.js'
import { MAX_ORIGIN_LENGTH, normaliseOrigin } from '../forms/origins.js'
import { mintPublicId } from '../forms/public-id.js'
import { eventStatement } from '../outbox.js'
import {
  afterOf,
  beforeRead,
  columnsOf,
  deleteOperation,
  receipt,
  resultStep,
  toRecord,
  updateOperation,
} from '../storage/crud.js'
import { definePreparedResource, type Conflict, type PreparedEnv } from '../storage/definition.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { canonicalId, prepareCreate, prepareUpdate } from '../storage/prepare.js'
import { withColumnSorts } from '../storage/sorts.js'
import { agents, type AgentRecord } from './agents.js'

export type FormRecord = {
  id: string
  organization_id: string
  name: string
  public_id: string
  enabled: boolean
  email_field: string | null
  phone_field: string | null
  name_field: string | null
  consent_text: string | null
  allowed_origins: string[]
  tag_ids: string[]
  created_by: string
  created_at: string
  updated_at: string
}

// [[CHN420]] D7: a payload key, 1 to 64 characters of A-Za-z0-9_.[]-, matched exactly and case-sensitively by the ingress; the migration's CHECK holds the same shape.
const fieldKey = z
  .string()
  .regex(/^[A-Za-z0-9_.[\]-]{1,64}$/, 'a payload key: 1 to 64 characters of letters, digits, _ . [ ] and -')

const record = z.object({
  id: z
    .uuid()
    .describe("The form's id; also the id of the form's agent, which every capture from the form is attributed to."),
  organization_id: z.uuid(),
  name: z.string().describe('The form name, unique among live forms ignoring ASCII case.'),
  public_id: z
    .string()
    .describe('The id a website embeds: frm_ and 26 lowercase base32 characters. Minted by the vault, never changes.'),
  enabled: z.boolean().describe('Whether the form accepts submissions.'),
  email_field: z
    .string()
    .nullable()
    .describe('The submitted key holding the email address; at least one of email_field and phone_field is set.'),
  phone_field: z.string().nullable().describe('The submitted key holding the phone number.'),
  name_field: z.string().nullable().describe("The submitted key holding the submitter's name."),
  consent_text: z.string().nullable().describe('The consent wording shown beside the form (1 to 2000 characters).'),
  allowed_origins: z
    .array(z.string())
    .describe(
      'The browser origins allowed to post to the form, stored normalised (https://example.com, no path), sorted. Empty: no browser origin is admitted.',
    ),
  tag_ids: z
    .array(z.uuid())
    .describe(
      'The tags a submitter is given, sorted. Each was a live tag when written; a tag deleted since stays listed here and is skipped when a submission is applied.',
    ),
  created_by: z.uuid().describe('The owner who created the form.'),
  created_at: z.string(),
  updated_at: z.string(),
})

const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The form name (1 to 200 characters, unique among live forms ignoring ASCII case).')
const consentText = z.string().min(1).max(2000).describe('The consent wording shown beside the form.')

const allowedOrigins = z
  .array(z.string().max(2048))
  .max(20)
  .describe(
    'The browser origins allowed to post to the form (at most 20): https origins such as https://example.com, or http for localhost, 127.0.0.1 and [::1]; no path, query, fragment, userinfo or wildcard. Stored normalised and sorted; an update replaces the whole list.',
  )
const tagIds = z
  .array(z.uuid())
  .max(20)
  .describe(
    'The tags given to a submitter (at most 20 distinct ids), each a live tag when written. An update replaces the whole list.',
  )

// `public_id` and `id` are not fields: the schemas are strict, so sending either is 400 validation_error ([[CHN420]] D6, P5).
const create = z.strictObject({
  name,
  enabled: z.boolean().default(true).describe('Whether the form accepts submissions; default true.'),
  email_field: fieldKey
    .nullable()
    .default('email')
    .describe('The submitted key holding the email address; default "email".'),
  phone_field: fieldKey.nullable().default(null).describe('The submitted key holding the phone number; default none.'),
  name_field: fieldKey
    .nullable()
    .default('name')
    .describe('The submitted key holding the submitter name; default "name".'),
  consent_text: consentText
    .nullable()
    .default(null)
    .describe('The consent wording shown beside the form; default none.'),
  allowed_origins: allowedOrigins.default([]),
  tag_ids: tagIds.default([]),
})
const update = z
  .strictObject({
    name,
    enabled: z.boolean(),
    email_field: fieldKey.nullable(),
    phone_field: fieldKey.nullable(),
    name_field: fieldKey.nullable(),
    consent_text: consentText.nullable(),
    allowed_origins: allowedOrigins,
    tag_ids: tagIds,
  })
  .partial()

type Mapping = { email_field: string | null; phone_field: string | null; name_field: string | null }
/** [[CHN420]] D7: at least one identity field and no two fields equal, judged on the merged result (an update re-validates the whole mapping, not only the patch). */
export function checkMapping(m: Mapping): void {
  if (m.email_field === null && m.phone_field === null)
    throw new ApiError(
      400,
      'validation_error',
      'email_field or phone_field must be set: a form needs an identity field',
    )
  const set = [
    ['email_field', m.email_field],
    ['phone_field', m.phone_field],
    ['name_field', m.name_field],
  ] as const
  for (const [i, [a, av]] of set.entries())
    for (const [b, bv] of set.slice(i + 1))
      if (av !== null && av === bv)
        throw new ApiError(400, 'validation_error', `${a} and ${b} must name different fields`)
}

/** The two lists of a write, validated and normalised; a key is undefined when the body did not send it (an update then leaves its rows alone). */
type Lists = { origins: string[] | undefined; tags: string[] | undefined }

/**
 * [[CHN424]] P1, P2: origin normalisation and the duplicate checks, synchronously and before anything is read (a refusal names the later index). The body's shape (at most 20 entries, uuid tag ids) was parsed already.
 * Origins are stored as `new URL(x).origin`; tag ids lowercase. Liveness of the tags is a plan-time read, after the update's 404.
 */
function prepareLists(values: Record<string, unknown>): Lists {
  let origins: string[] | undefined
  if (Array.isArray(values.allowed_origins)) {
    origins = []
    for (const [i, raw] of (values.allowed_origins as string[]).entries()) {
      const origin = normaliseOrigin(raw)
      if (origin === null)
        throw new ApiError(
          400,
          'validation_error',
          `allowed_origins[${i}] is not an allowed origin: use https://host[:port] (http only for localhost, 127.0.0.1 and [::1]), with no path, query, fragment, userinfo or wildcard, at most ${MAX_ORIGIN_LENGTH} characters`,
        )
      const first = origins.indexOf(origin)
      if (first !== -1)
        throw new ApiError(
          400,
          'validation_error',
          `allowed_origins[${i}] repeats allowed_origins[${first}] (${origin})`,
        )
      origins.push(origin)
    }
    origins.sort()
  }
  let tags: string[] | undefined
  if (Array.isArray(values.tag_ids)) {
    tags = []
    for (const [i, raw] of (values.tag_ids as string[]).entries()) {
      const id = raw.toLowerCase()
      const first = tags.indexOf(id)
      if (first !== -1) throw new ApiError(400, 'validation_error', `tag_ids[${i}] repeats tag_ids[${first}] (${id})`)
      tags.push(id)
    }
    tags.sort()
  }
  return { origins, tags }
}

/** [[CHN424]] P3: the live tags among the ids, read at plan time only (no commit guard on the tag). */
const liveTagsRead = (qc: QueryContext, env: PreparedEnv, ids: string[]) =>
  readAll(
    qc.db
      .selectFrom('tags')
      .select('tags.id')
      .where('tags.organization_id', '=', env.organizationId)
      .where('tags.deleted_at', 'is', null)
      .where('tags.id', 'in', ids),
  )
const tagReads = (qc: QueryContext, env: PreparedEnv, lists: Lists): Record<string, Read> =>
  lists.tags && lists.tags.length > 0 ? { tags: liveTagsRead(qc, env, lists.tags) } : {}
/** 400 invalid_reference when a listed tag is not live (unknown, deleted or another organisation's). */
function checkTagsLive(found: { all(key: string): readonly Readonly<Record<string, unknown>>[] }, lists: Lists): void {
  if (!lists.tags || lists.tags.length === 0) return
  const live = new Set(found.all('tags').map((r) => String(r.id)))
  if (lists.tags.some((t) => !live.has(t)))
    throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
}

/**
 * The child-row statements of a write ([[CHN424]] P5): a list present in the body is written whole (`replace`: delete-all then insert, since a child row's id is not exposed and the sets are at most 20 rows); an absent list writes nothing.
 * A create inserts only.
 */
function childSteps(
  qc: QueryContext,
  env: PreparedEnv,
  id: string,
  at: string,
  lists: Lists,
  replace: boolean,
): Step[] {
  const steps: Step[] = []
  const org = env.organizationId
  if (lists.origins) {
    if (replace)
      steps.push(
        step(qc.db.deleteFrom('form_allowed_origins').where('form_id', '=', id).where('organization_id', '=', org)),
      )
    if (lists.origins.length > 0)
      steps.push(
        step(
          qc.db.insertInto('form_allowed_origins').values(
            lists.origins.map((origin) => ({
              id: env.newId(),
              organization_id: org,
              form_id: id,
              origin,
              created_at: at,
            })) as never,
          ),
        ),
      )
  }
  if (lists.tags) {
    if (replace)
      steps.push(step(qc.db.deleteFrom('form_tags').where('form_id', '=', id).where('organization_id', '=', org)))
    if (lists.tags.length > 0)
      steps.push(
        step(
          qc.db.insertInto('form_tags').values(
            lists.tags.map((tag_id) => ({
              id: env.newId(),
              organization_id: org,
              form_id: id,
              tag_id,
              created_at: at,
            })) as never,
          ),
        ),
      )
  }
  return steps
}

/** [[CHN420]] P4: a live form of the same name, ASCII case-insensitively (SQLite NOCASE, the same fold as the live-name index), other than the form being changed. */
const nameConflicts = ({
  qc,
  env,
  op,
  id,
  values,
}: Parameters<NonNullable<Parameters<typeof definePreparedResource>[0]['conflicts']>>[0]): Conflict[] =>
  typeof values.name !== 'string'
    ? []
    : [
        {
          read: readMaybe(
            qc.db
              .selectFrom('forms')
              .select('forms.id')
              .where('forms.organization_id', '=', env.organizationId)
              .where(sql<boolean>`${sql.ref('forms.name')} = ${values.name} collate nocase`)
              .where('forms.deleted_at', 'is', null)
              .$if(op === 'update' && id !== null, (q) => q.where('forms.id', '<>', id as string))
              .limit(1),
          ),
          refuse: (row) => {
            if (row)
              throw new ApiError(
                409,
                'form_name_exists',
                `a form named ${String(values.name)} already exists (${String(row.id)})`,
              )
          },
        },
      ]

/**
 * Forms ([[CHN420]]): the website forms of the workspace, configuration on `/meta` (D11). Created, changed and deleted by an owner, signed in (`humanOnly`; `forms:write` is owner-only and not
 * agent-grantable, D12); anyone holding `forms:read` reads them. Each form is created with its own credential-less agent principal (D3), an `agents` row sharing the form's id, in the same unit.
 * The allowed origins and tags (D8, D9, [[CHN424]]) are child tables written whole in the form's unit and carried in the record and its events. The principal is managed by its form (D4, [[CHN423]]): a rename renames the agent, a delete disables it, each in the form's unit with its `agent.updated`;
 * `agents.update` and `api_keys.create` refuse it (`409 form_principal`).
 * A live duplicate name is refused in the plan (`409 form_name_exists`, P4); the partial unique index is the commit-time backstop. Delete is soft. D1 only: `501 not_implemented` elsewhere.
 */
export const forms = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      surface: 'meta',
      name: 'forms',
      eventName: 'form',
      table: 'forms',
      d1Only: true,
      operations: ['list', 'get', 'create', 'update', 'delete'],
      notProposable: 'opening, changing or closing a public form is an owner decision and is not proposable',
      humanOnly: 'forms are set up by a signed-in workspace owner',
      descriptions: {
        list: 'The workspace forms: name, public id, enabled flag, field mapping, consent text, allowed origins and tag ids. Filter by enabled or by public_id (exact). Example: vibase forms list --enabled true',
        get: 'One form. Example: vibase forms get <id>',
        create:
          'Human only, and only an owner: create a form and its agent. The public id is minted and returned; name must be unique among live forms (409 form_name_exists); the mapping defaults to email and name and needs email_field or phone_field; allowed_origins (at most 20 normalised https origins, none by default: no browser origin is admitted) and tag_ids (at most 20 live tags) are optional; 400 invalid_reference for a tag that is not live; 403 user_required for an agent. Example: vibase forms create --name "Website contact" --allowed-origins \'["https://example.com"]\'',
        update:
          'Human only, and only an owner: change a form (name, enabled, the field mapping, consent text, allowed origins, tag ids). A list replaces the whole set ([] clears it) and an absent list is left as it is. A new name also renames the agent of the form (an agent.updated event before form.updated). At least one field; the merged mapping must still have an identity field and no two equal fields; the public id never changes. Example: vibase forms update <id> --enabled false',
        delete:
          'Human only, and only an owner: delete a form (soft delete; its public id is never reused) and disable its agent (an agent.updated event before form.deleted; the agent stays listed and can never be re-enabled). 404 for an unknown or already deleted form. Example: vibase forms delete <id>',
      },
      record,
      create,
      update,
      filters: {},
      embed: {
        allowed_origins: {
          table: 'form_allowed_origins',
          key: 'form_id',
          columns: ['origin'],
          orderBy: ['origin'],
          scalar: true,
        },
        tag_ids: { table: 'form_tags', key: 'form_id', columns: ['tag_id'], orderBy: ['tag_id'], scalar: true },
      },
      conflicts: nameConflicts,
      override: {
        create: (env, input) => createFormOperation(env, input),
        update: (env, input) => updateFormOperation(env, input as { id: string; body: unknown }),
        delete: (env, id) => deleteFormOperation(env, id as string),
      },
    }),
    ['name'],
  ),
)

/** The agent of the form as the plan phase read it, with the stamp of the read, for the write that follows the form's own. */
const agentRead = (env: PreparedEnv, qc: Parameters<PreparedOperation<unknown>['reads']>[0], id: string) =>
  beforeRead(agents, qc, env, id)

const agentBefore = (found: { maybe(key: string): unknown }): AgentRecord | null => {
  const row = found.maybe('agent') as Record<string, unknown> | null
  if (!row) return null
  const { __stamp: _stamp, ...rest } = row
  return toRecord(agents, rest) as AgentRecord
}

/**
 * Splices the agent's write into a form unit ([[CHN423]] P4, P5): after the form's own mutation (kept first, so a drift on the form gates everything after it, as `changes() > 0` chains on D1), the agent's UPDATE and its `agent.updated`, then
 * the form's event and result. The agent event therefore precedes the form event. The agent UPDATE carries no stamp guard of its own: the agent is written only through its form (`agents.update` refuses it), so the form's stamp is the guard,
 * and a drift on it applies nothing (the agent UPDATE is gated on the form's, the events chain on each other). `set` is the agent's patch beyond `updated_at`.
 */
function withAgentWrite<T>(
  inner: Unit<T>,
  qc: Parameters<PreparedOperation<unknown>['reads']>[0],
  env: PreparedEnv,
  id: string,
  agentEventId: string,
  at: string,
  set: Record<string, unknown>,
  agent: AgentRecord,
): Unit<T> {
  const update = qc.db
    .updateTable('agents')
    .set({ ...set, updated_at: at } as never)
    .where('agents.id', '=', id)
    .where('agents.organization_id', '=', env.organizationId)
    .where(appliedPrev(qc))
  const event = eventStatement(qc, {
    id: agentEventId,
    at,
    organizationId: env.organizationId,
    actorId: env.actor.id,
    type: 'agent.updated',
    resourceType: 'agent',
    resourceId: id,
    before: agent as unknown as Record<string, unknown>,
    after: { table: 'agents', columns: columnsOf(agents) },
  })
  const at0 = inner.steps.findIndex((s) => s.label === 'first-mutation')
  return unit({
    steps: [...inner.steps.slice(0, at0 + 1), step(update), step(event), ...inner.steps.slice(at0 + 1)],
    events: [receipt(agents, agentEventId, 'updated', id), ...inner.events],
    decode: inner.decode,
  })
}

/**
 * `forms.update`: the generic update, refusing an empty body, with the merged mapping re-validated against the stored row (D7). A `name` that differs exactly (case-sensitive) from the stored agent's name also renames the agent in the same unit,
 * emitting `agent.updated` before `form.updated`; any other update leaves the agent alone ([[CHN423]] P4).
 */
export function updateFormOperation(
  env: PreparedEnv,
  input: { id: string; body: unknown },
): PreparedOperation<FormRecord> {
  const values = prepareUpdate(forms, env.actor, input.body)
  if (Object.keys(values).length === 0) throw new ApiError(400, 'validation_error', 'send at least one field to change')
  const lists = prepareLists(values) // [[CHN424]] P2: normalisation and duplicates before the 404
  const agentEventId = env.newId() // before the form event's id, so the two sort in write order
  const at = codecs.timestamp.write(env.now)
  const id = canonicalId(forms, input.id)
  const inner = updateOperation(forms, env, input.id, input.body, (before) => {
    checkMapping({
      email_field: 'email_field' in values ? (values.email_field as string | null) : before.email_field,
      phone_field: 'phone_field' in values ? (values.phone_field as string | null) : before.phone_field,
      name_field: 'name_field' in values ? (values.name_field as string | null) : before.name_field,
    })
    return {}
  }) as PreparedOperation<FormRecord>
  const renames = typeof values.name === 'string'
  if (!renames && !lists.origins && !lists.tags) return inner
  return defineOperation<FormRecord>({
    ...inner,
    reads: (qc) => ({
      ...inner.reads(qc),
      ...(renames ? { agent: agentRead(env, qc, id) } : {}),
      ...tagReads(qc, env, lists),
    }),
    build: (found, qc) => {
      let built = inner.build(found, qc) // the 404, the name conflict, the merged mapping
      checkTagsLive(found, lists)
      const agent = renames ? agentBefore(found) : null
      if (agent && agent.name !== values.name)
        built = withAgentWrite(built, qc, env, id, agentEventId, at, { name: values.name }, agent)
      if (!lists.origins && !lists.tags) return built
      return withChildWrites(built, qc, env, id, at, lists, String((found.maybe('before') as Row).__stamp))
    },
  })
}

/**
 * Child-row writes of an update ([[CHN424]] P3, P5): before the form's own UPDATE, as the capture-settings update does ([[CHN409]]), so the event renders `after` from the rows written and the UPDATE stays the statement the event's `appliedPrev` gate reads.
 * They ride the form's stamp guard: a commit-time assertion that the form is still live and untouched since the plan read aborts the whole unit as drift, so a drifted update applies no child-row change.
 */
function withChildWrites<T>(
  inner: Unit<T>,
  qc: QueryContext,
  env: PreparedEnv,
  id: string,
  at: string,
  lists: Lists,
  stamp: string,
): Unit<T> {
  const unchanged = qc.db
    .selectFrom('forms')
    .select(sql<number>`1`.as('one'))
    .where('forms.id', '=', id)
    .where('forms.organization_id', '=', env.organizationId)
    .where('forms.deleted_at', 'is', null)
    .where(sql<SqlBool>`${ts.exact(qc, 'forms.updated_at')} = ${stamp}`)
  const at0 = inner.steps.findIndex((s) => s.label === 'first-mutation')
  return unit({
    steps: [
      ...inner.steps.slice(0, at0),
      assertStep(qc, sql<SqlBool>`exists ${unchanged}`),
      ...childSteps(qc, env, id, at, lists, true),
      ...inner.steps.slice(at0),
    ],
    events: inner.events,
    decode: inner.decode,
  })
}

/**
 * `forms.delete`: the generic soft delete, and the form's agent is disabled in the same unit (`disabled_at` with `coalesce`, so an earlier timestamp is kept) with its `agent.updated` before `form.deleted`; an agent already disabled is left
 * alone and emits nothing ([[CHN423]] P5). The agent stays in `agents.list` and `agents.get`, and `agents.update` refuses to re-enable it.
 */
export function deleteFormOperation(env: PreparedEnv, rawId: string): PreparedOperation<void> {
  const inner = deleteOperation(forms, env, rawId)
  const id = canonicalId(forms, rawId)
  const agentEventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<void>({
    ...inner,
    reads: (qc) => ({ ...inner.reads(qc), agent: agentRead(env, qc, id) }),
    build: (found, qc) => {
      const built = inner.build(found, qc)
      const agent = agentBefore(found)
      if (!agent || agent.disabled_at !== null) return built
      return withAgentWrite(
        built,
        qc,
        env,
        id,
        agentEventId,
        at,
        { disabled_at: sql`coalesce(${sql.ref('agents.disabled_at')}, ${at})` },
        agent,
      )
    },
  })
}

/**
 * `forms.create` (D3): in one unit the principal (inserted first, without RETURNING, as `agents.create` does), the agents row and its `agent.created`, the form row and `form.created`, then the result.
 * Shares `agents.create`'s `agent.created` shape, so feed consumers see one. The public id is minted here (D6) and a collision is not retried: the unique index fails the unit (P5).
 */
export function createFormOperation(env: PreparedEnv, input: unknown): PreparedOperation<FormRecord> {
  const values = prepareCreate(forms, env.actor, input)
  checkMapping(values as unknown as Mapping)
  const lists = prepareLists(values)
  const id = env.newId()
  const agentEventId = env.newId()
  const formEventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const publicId = mintPublicId((n) => env.randomBytes(n))
  const conflictsOf = (qc: Parameters<PreparedOperation<FormRecord>['reads']>[0]) =>
    nameConflicts({ qc, env, op: 'create', id: null, values })
  return defineOperation<FormRecord>({
    name: 'forms.create',
    mutates: true,
    reads: (qc) => ({
      ...Object.fromEntries(conflictsOf(qc).map((c, i) => [`conflict:${i}`, c.read])),
      ...tagReads(qc, env, lists),
    }),
    build: (found, qc) => {
      conflictsOf(qc).forEach((c, i) => c.refuse(found.maybe(`conflict:${i}`)))
      checkTagsLive(found, lists)
      return unit({
        steps: [
          step(qc.db.insertInto('principals').values({ id, kind: 'agent', created_at: at }), 'first-mutation'),
          step(
            qc.db.insertInto('agents').values({
              id,
              created_at: at,
              updated_at: at,
              organization_id: env.organizationId,
              name: values.name as string,
              scopes: [],
              disabled_at: null,
              created_by: env.actor.id,
            }),
          ),
          step(
            eventStatement(qc, {
              id: agentEventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'agent.created',
              resourceType: 'agent',
              resourceId: id,
              before: null,
              after: { table: 'agents', columns: columnsOf(agents) },
            }),
            'first-event',
          ),
          step(
            qc.db.insertInto('forms').values({
              id,
              created_at: at,
              updated_at: at,
              organization_id: env.organizationId,
              created_by: env.actor.id,
              name: values.name as string,
              public_id: publicId,
              enabled: values.enabled as boolean,
              email_field: values.email_field as string | null,
              phone_field: values.phone_field as string | null,
              name_field: values.name_field as string | null,
              consent_text: values.consent_text as string | null,
            }),
          ),
          ...childSteps(qc, env, id, at, lists, false),
          step(
            eventStatement(qc, {
              id: formEventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'form.created',
              resourceType: 'form',
              resourceId: id,
              before: null,
              after: afterOf(forms),
            }),
          ),
          resultStep(forms, qc, env, id, formEventId),
        ],
        events: [receipt(agents, agentEventId, 'created', id), receipt(forms, formEventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('forms.create')
          return toRecord(forms, rows[0]!) as FormRecord
        },
      })
    },
  })
}
