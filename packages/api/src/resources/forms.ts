import { sql } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, codecs, defineOperation, readMaybe, step, unit, type PreparedOperation } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { mintPublicId } from '../forms/public-id.js'
import { eventStatement } from '../outbox.js'
import { afterOf, columnsOf, receipt, resultStep, toRecord, updateOperation } from '../storage/crud.js'
import { definePreparedResource, type Conflict, type PreparedEnv } from '../storage/definition.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { prepareCreate, prepareUpdate } from '../storage/prepare.js'
import { withColumnSorts } from '../storage/sorts.js'
import { agents } from './agents.js'

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

// `public_id` and `id` are not fields: the schemas are strict, so sending either is 400 validation_error ([[CHN420]] D6, P5). `allowed_origins` and `tag_ids` arrive with CHN424 (P1).
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
})
const update = z
  .strictObject({
    name,
    enabled: z.boolean(),
    email_field: fieldKey.nullable(),
    phone_field: fieldKey.nullable(),
    name_field: fieldKey.nullable(),
    consent_text: consentText.nullable(),
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
 * Cycle 1 covers the scalar fields only: the allowed origins and tags (D8, D9) come with CHN424 and the principal's management (D4: rename sync, disable on delete, refusals) with CHN423.
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
        list: 'The workspace forms: name, public id, enabled flag, field mapping and consent text. Filter by enabled or by public_id (exact). Example: vibase forms list --enabled true',
        get: 'One form. Example: vibase forms get <id>',
        create:
          'Human only, and only an owner: create a form and its agent. The public id is minted and returned; name must be unique among live forms (409 form_name_exists); the mapping defaults to email and name and needs email_field or phone_field; 403 user_required for an agent. Example: vibase forms create --name "Website contact" --consent-text "We store your answer."',
        update:
          'Human only, and only an owner: change a form (name, enabled, the field mapping, consent text). At least one field; the merged mapping must still have an identity field and no two equal fields; the public id never changes. Example: vibase forms update <id> --enabled false',
        delete:
          'Human only, and only an owner: delete a form (soft delete; its public id is never reused). 404 for an unknown or already deleted form. Example: vibase forms delete <id>',
      },
      record,
      create,
      update,
      filters: {},
      conflicts: nameConflicts,
      override: {
        create: (env, input) => createFormOperation(env, input),
        update: (env, input) => updateFormOperation(env, input as { id: string; body: unknown }),
      },
    }),
    ['name'],
  ),
)

/** `forms.update`: the generic update, refusing an empty body, with the merged mapping re-validated against the stored row (D7). */
export function updateFormOperation(
  env: PreparedEnv,
  input: { id: string; body: unknown },
): PreparedOperation<FormRecord> {
  const values = prepareUpdate(forms, env.actor, input.body)
  if (Object.keys(values).length === 0) throw new ApiError(400, 'validation_error', 'send at least one field to change')
  return updateOperation(forms, env, input.id, input.body, (before) => {
    checkMapping({
      email_field: 'email_field' in values ? (values.email_field as string | null) : before.email_field,
      phone_field: 'phone_field' in values ? (values.phone_field as string | null) : before.phone_field,
      name_field: 'name_field' in values ? (values.name_field as string | null) : before.name_field,
    })
    return {}
  }) as PreparedOperation<FormRecord>
}

/**
 * `forms.create` (D3): in one unit the principal (inserted first, without RETURNING, as `agents.create` does), the agents row and its `agent.created`, the form row and `form.created`, then the result.
 * Shares `agents.create`'s `agent.created` shape, so feed consumers see one. The public id is minted here (D6) and a collision is not retried: the unique index fails the unit (P5).
 */
export function createFormOperation(env: PreparedEnv, input: unknown): PreparedOperation<FormRecord> {
  const values = prepareCreate(forms, env.actor, input)
  checkMapping(values as unknown as Mapping)
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
    reads: (qc) => Object.fromEntries(conflictsOf(qc).map((c, i) => [`conflict:${i}`, c.read])),
    build: (found, qc) => {
      conflictsOf(qc).forEach((c, i) => c.refuse(found.maybe(`conflict:${i}`)))
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
