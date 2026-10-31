import { z } from 'zod'
import { readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { normalizeIdentityValue, type IdentityKind } from '../identity/normalize.js'
import { definePreparedResource } from '../storage/definition.js'

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

/**
 * Identities on the prepared path ([[CORE36]]). Pure preparation: the owner rule, then the normalised value (the
 * ASCII rule included, P6); the contact must be live (plan read and commit guard); a live address refuses a create in
 * the plan (`409 identity_exists`) and the partial unique index re-checks at commit. `kind` and `value` are immutable.
 */
export const identities = definePreparedResource({
  surface: 'api',
  name: 'identities',
  eventName: 'identity',
  table: 'identities',
  scopeResource: 'contacts',
  record,
  create,
  update,
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
    own: { schema: z.enum(['true', 'false']), normalize: (v) => v === 'true' },
  },
  prepare: ({ values, meta }) => {
    if (meta.op === 'update') return Object.keys(values).length === 0 ? {} : ownerColumns(values)
    const owner = ownerColumns(values)
    return { value: normalizeIdentityValue(values.kind as IdentityKind, values.value as string), ...owner }
  },
  conflicts: ({ qc, env, op, values }) => {
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
          throw new ApiError(409, 'identity_exists', own ? 'the address is already an own identity' : `the address already belongs to contact ${String(row.contact_id)}`)
        },
      },
    ]
  },
})
