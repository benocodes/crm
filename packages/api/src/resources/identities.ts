import { z } from 'zod'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { addressKey, lockKeys } from '../identity/locks.js'
import { normalizeIdentityValue, type IdentityKind } from '../identity/normalize.js'
import { emitResourceEvent } from './crud.js'
import { defineResource, toRecord } from './define.js'

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
 * Inserts a live identity, or returns null when the address is already taken (ON CONFLICT DO NOTHING on
 * the partial unique index). Does not emit: callers emit. Callers hold the address lock.
 */
export async function insertIdentity(
  ctx: ServiceContext,
  v: { kind: IdentityKind; value: string; contact_id: string | null; own: boolean },
): Promise<IdentityRecord | null> {
  const row = await ctx.trx
    .insertInto('identities')
    .values({ ...v, organization_id: ctx.organizationId, created_by: ctx.actor.id })
    .onConflict((oc) => oc.columns(['organization_id', 'kind', 'value']).where('deleted_at', 'is', null).doNothing())
    .returning(Object.keys(record.shape) as never[])
    .executeTakeFirst()
  return row ? toRecord(identities, row as Record<string, unknown>) : null
}

export const identities = defineResource<IdentityRecord>({
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
  beforeWrite: (_ctx, { op, input }) => (op === 'update' ? { ...input, ...ownerColumns(input) } : input),
  overrides: {
    async create(ctx, input) {
      const owner = ownerColumns(input)
      const kind = input.kind as IdentityKind
      const value = normalizeIdentityValue(kind, input.value as string)
      await lockKeys(ctx, [addressKey(ctx.organizationId, kind, value)])
      const created = await insertIdentity(ctx, { kind, value, ...owner })
      if (!created) {
        const existing = await ctx.trx
          .selectFrom('identities')
          .select(['contact_id', 'own'])
          .where('kind', '=', kind)
          .where('value', '=', value)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow()
        throw new ApiError(
          409,
          'identity_exists',
          existing.own ? 'the address is already an own identity' : `the address already belongs to contact ${existing.contact_id}`,
        )
      }
      await emitResourceEvent(ctx, identities, 'created', null, created, created.id)
      return created
    },
  },
})
