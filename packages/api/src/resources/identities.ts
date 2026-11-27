import { z } from 'zod'
import { sql, type SqlBool } from 'kysely'
import { readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { normalizeIdentityValue, type IdentityKind } from '../identity/normalize.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export type IdentityRecord = {
  id: string
  organization_id: string
  kind: IdentityKind
  value: string
  contact_id: string | null
  own: boolean
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  kind: z.enum(['email', 'phone']),
  value: z.string(),
  contact_id: z.uuid().nullable(),
  own: z.boolean(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

const create = z.strictObject({
  kind: z.enum(['email', 'phone']),
  value: z.string().min(1).max(320),
  contact_id: z.uuid().optional(),
  own: z.literal(true).optional(),
})
const update = z.strictObject({ contact_id: z.uuid().optional(), own: z.literal(true).optional() })

const OWNER_MESSAGE = 'exactly one of contact_id or own: true is required'

/** The owner rule: exactly one of contact_id and own: true. Returns the columns to write. */
function ownerColumns(input: Record<string, unknown>): { contact_id: string | null; own: boolean } {
  const contactId = input.contact_id as string | undefined
  const own = input.own === true
  if ((contactId !== undefined) === own) throw new ApiError(400, 'validation_error', OWNER_MESSAGE)
  return own ? { contact_id: null, own: true } : { contact_id: contactId!, own: false }
}

const OWN_MESSAGE = 'saying which addresses are ours needs a signed-in person'
const HELD_MESSAGE = 'a connected mailbox uses this identity; disconnect the mailbox first'

/**
 * [[CORE573]] D12, D11: an identity write that decides which addresses are "ours" needs a human, and an identity a live channel connection
 * references (whatever its status) is held. `values` are the prepared patch: `{ own: true, contact_id: null }`, `{ contact_id, own: false }` or `{}`.
 * The 403 is decided before the 409, and a patch that leaves the stored `contact_id` and `own` as they are is not held.
 */
const changesOwner = (row: { own: unknown; contact_id: unknown }, values: Record<string, unknown>): boolean => {
  if (values.own === undefined) return false
  const own = row.own === true || row.own === 1
  return own !== values.own || (row.contact_id ?? null) !== (values.contact_id ?? null)
}
const heldBy = (id: string, organizationId: string) =>
  sql<SqlBool>`exists (select 1 from "connections" where "connections"."identity_id" = ${id} and "connections"."organization_id" = ${organizationId} and "connections"."deleted_at" is null)`

/**
 * Identities on the prepared path ([[CORE36]]). Pure preparation: the owner rule, then the normalised value (the
 * ASCII rule included, P6); the contact must be live (plan read and commit guard); a live address refuses a create in
 * the plan (`409 identity_exists`) and the partial unique index re-checks at commit. `kind` and `value` are immutable.
 */
export const identities = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      surface: 'api',
      name: 'identities',
      eventName: 'identity',
      table: 'identities',
      scopeResource: 'contacts',
      record,
      create,
      update,
      descriptions: {
        create:
          'Record an address, for a contact (contact_id) or as one of our own (own: true; a signed-in person only, 403 user_required for an agent). 409 identity_exists when the address is already live.',
        update:
          'Change which contact an address belongs to (contact_id), or mark it as one of our own (own: true). Marking an address own, or giving an own address a contact_id, needs a signed-in person: 403 user_required for an agent. 409 identity_in_use when a connected mailbox uses the identity and the change would alter its contact or own; disconnect the mailbox first.',
        delete:
          'Soft-delete an address. 409 identity_in_use while a connected mailbox uses the identity (any status); disconnect the mailbox first.',
      },
      references: { contact_id: { table: 'contacts', live: true } },
      filters: {
        kind: { schema: z.enum(['email', 'phone']) },
        value: {
          schema: z.string().min(1).max(320),
          normalize: (value, filters) => {
            const kind = filters.kind as IdentityKind | undefined
            if (!kind) throw new ApiError(400, 'validation_error', 'filter value requires kind')
            return normalizeIdentityValue(kind, value as string)
          },
        },
        contact_id: { schema: z.uuid() },
      },
      prepare: ({ values, meta }) => {
        if (meta.op === 'update') return Object.keys(values).length === 0 ? {} : ownerColumns(values)
        const owner = ownerColumns(values)
        return { value: normalizeIdentityValue(values.kind as IdentityKind, values.value as string), ...owner }
      },
      hold: ({ qc, env, op, id, values }) => ({
        read: readMaybe(
          qc.db
            .selectFrom('identities')
            .select(['identities.own', 'identities.contact_id', heldBy(id, env.organizationId).as('held')])
            .where('identities.id', '=', id)
            .where('identities.organization_id', '=', env.organizationId)
            .where('identities.deleted_at', 'is', null),
        ),
        refuse: (row) => {
          if (!row) return
          const own = row.own === true || row.own === 1
          if (
            op === 'update' &&
            env.actor.kind !== 'user' &&
            (values.own === true || (own && typeof values.contact_id === 'string'))
          )
            throw new ApiError(403, 'user_required', OWN_MESSAGE)
          const changes = op === 'delete' || changesOwner(row as never, values)
          if (changes && (row.held === true || row.held === 1)) throw new ApiError(409, 'identity_in_use', HELD_MESSAGE)
        },
        guard: (before) =>
          op === 'delete' || changesOwner(before as never, values)
            ? sql<SqlBool>`not ${heldBy(id, env.organizationId)}`
            : null,
      }),
      conflicts: ({ qc, env, op, values }) => {
        if (op === 'create' && values.own === true && env.actor.kind !== 'user')
          throw new ApiError(403, 'user_required', OWN_MESSAGE)
        if (op !== 'create') return []
        const q = qc.db
          .selectFrom('identities')
          .select(['identities.contact_id', 'identities.own'])
          .where('identities.organization_id', '=', env.organizationId)
          .where('identities.kind', '=', values.kind as IdentityKind)
          .where('identities.value', '=', values.value as string)
          .where('identities.deleted_at', 'is', null)
        return [
          {
            read: readMaybe(q.limit(1)),
            refuse: (row) => {
              if (!row) return
              const own = row.own === true || row.own === 1
              throw new ApiError(
                409,
                'identity_exists',
                own
                  ? 'the address is already an own identity'
                  : row.contact_id === null || row.contact_id === undefined
                    ? 'the address is already recorded without a contact'
                    : `the address already belongs to contact ${String(row.contact_id)}`,
              )
            },
          },
        ]
      },
    }),
    ['value'],
  ),
  {
    value:
      'Needs kind in the same call, as a plain equality (kind=email); each operand is normalised for that kind before it is compared.',
  },
)
