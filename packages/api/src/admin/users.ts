import { z } from 'zod'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'

export const userRecord = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type UserRecord = z.infer<typeof userRecord>

export const listUsersQuery = z.strictObject({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS = ['users.id', 'users.email', 'users.name', 'users.created_at', 'users.updated_at'] as const

type Row = { id: string; email: string; name: string | null; created_at: Date | string; updated_at: Date | string }
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d)
const toUser = (r: Row): UserRecord => userRecord.parse({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) })

/** Users with a live membership in the organisation (P8). */
export async function listUsers(
  ctx: ServiceContext,
  query: { after?: string; limit?: number },
): Promise<{ data: UserRecord[]; next_cursor: string | null }> {
  const limit = query.limit ?? 50
  let q = ctx.trx
    .selectFrom('users')
    .innerJoin('memberships as m', (j) =>
      j.onRef('m.user_id', '=', 'users.id').on('m.organization_id', '=', ctx.organizationId).on('m.deleted_at', 'is', null),
    )
    .select(COLUMNS)
  if (query.after) q = q.where('users.id', '>', query.after.toLowerCase())
  const rows = await q.orderBy('users.id').limit(limit + 1).execute()
  const page = rows.slice(0, limit)
  return { data: page.map(toUser), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null }
}

/** Any user the RLS policy shows: a removed member still resolves, so `created_by` and `actor_id` do (D13). */
export async function getUser(ctx: ServiceContext, id: string): Promise<UserRecord> {
  const notFound = () => new ApiError(404, 'not_found', 'user not found')
  if (!UUID.test(id)) throw notFound()
  const row = await ctx.trx.selectFrom('users').select(COLUMNS).where('users.id', '=', id.toLowerCase()).executeTakeFirst()
  if (!row) throw notFound()
  return toUser(row)
}

// RED-PHASE STUB (CORE40 Phase 1): replaced by the real program in Phase 3.
import type { PreparedOperation } from '@vault/storage'
import type { PreparedEnv } from '../storage/definition.js'
export function getUserOperation(_env: PreparedEnv, _id: string): PreparedOperation<UserRecord> {
  throw new Error('not implemented')
}
