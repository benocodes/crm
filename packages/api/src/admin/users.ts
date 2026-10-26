import { sql, type SqlBool } from 'kysely'
import { z } from 'zod'
import { defineOperation, readAll, readMaybe, ts, unit, type PreparedOperation, type QueryContext } from '@vault/storage'
import { ApiError } from '../errors.js'
import type { PreparedEnv } from '../storage/definition.js'

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

/** `users` has no organization_id, so the membership predicate is the only filter on D1 (and repeats RLS on Postgres, harmlessly): D11. */
function users(qc: QueryContext, env: PreparedEnv, opts: { liveOnly: boolean }) {
  return qc.db
    .selectFrom('users')
    .select([
      'users.id',
      'users.email',
      'users.name',
      ts.iso(qc, 'users.created_at').as('created_at'),
      ts.iso(qc, 'users.updated_at').as('updated_at'),
    ])
    .where(
      sql<SqlBool>`exists (select 1 from "memberships" where "memberships"."user_id" = "users"."id" and "memberships"."organization_id" = ${env.organizationId}${opts.liveOnly ? sql` and "memberships"."deleted_at" is null` : sql``})`,
    )
}

/** Users with a LIVE membership in the organisation ([[CORE27]] P8), keyset by id (P9). */
export function listUsersOperation(
  env: PreparedEnv,
  query: { after?: string; limit?: number },
): PreparedOperation<{ data: UserRecord[]; next_cursor: string | null }> {
  const limit = query.limit ?? 50
  const after = query.after?.toLowerCase()
  return defineOperation({
    name: 'users.list',
    mutates: false,
    reads: (qc) => {
      let q = users(qc, env, { liveOnly: true })
      if (after) q = q.where('users.id', '>', after)
      return { page: readAll(q.orderBy('users.id').limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = found.all('page')
          const page = rows.slice(0, limit)
          return { data: page.map((r) => userRecord.parse(r)), next_cursor: rows.length > limit ? (page[page.length - 1]!.id as string) : null }
        },
      }),
  })
}

/** A user with ANY membership row in the organisation, live or removed, so `created_by` and `actor_id` keep resolving (D13, [[CORE27]] P8). */
export function getUserOperation(env: PreparedEnv, rawId: string): PreparedOperation<UserRecord> {
  const notFound = () => new ApiError(404, 'not_found', 'user not found')
  if (!UUID.test(rawId)) throw notFound()
  const id = rawId.toLowerCase()
  return defineOperation({
    name: 'users.get',
    mutates: false,
    reads: (qc) => ({ row: readMaybe(users(qc, env, { liveOnly: false }).where('users.id', '=', id)) }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = found.maybe('row')
          if (!row) throw notFound()
          return userRecord.parse(row)
        },
      }),
  })
}
