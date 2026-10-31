import { z } from 'zod'
import { codecs, defineOperation, readAll, readOne, unit, type PreparedOperation } from '@vault/storage'
import type { AccountEnv, AccountOperation } from '../registry.js'

const role = z.enum(['owner', 'member'])
const meResponse = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable(), email_verified: z.boolean() }),
  memberships: z.array(z.object({ organization_id: z.uuid(), organization_name: z.string(), role })),
  active_organization: z.object({ id: z.uuid(), role, scopes: z.array(z.string()) }).nullable(),
})
export type MeResponse = z.infer<typeof meResponse>

/**
 * `me.get` ([[CORE41]] C5, P12): a read-only prepared account operation. The user by the actor's id, their live memberships
 * joined to the organisations (ordered by name, then id), and the active organisation with the caller's scopes. On D1 it
 * lists only local data ([[CORE36]] D19).
 */
export function meOperation(env: AccountEnv): PreparedOperation<MeResponse> {
  return defineOperation<MeResponse>({
    name: 'me.get',
    mutates: false,
    reads: (qc) => ({
      user: readOne(qc.db.selectFrom('users').select(['users.id', 'users.email', 'users.name', 'users.email_verified']).where('users.id', '=', env.actor.id)),
      memberships: readAll(
        qc.db
          .selectFrom('memberships')
          .innerJoin('organizations', 'organizations.id', 'memberships.organization_id')
          .select(['organizations.id as organization_id', 'organizations.name as organization_name', 'memberships.role'])
          .where('memberships.user_id', '=', env.actor.id)
          .where('memberships.deleted_at', 'is', null)
          .orderBy('organizations.name')
          .orderBy('organizations.id'),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const user = found.one('user')
          const memberships = found.all('memberships').map((r) => ({
            organization_id: r.organization_id as string,
            organization_name: r.organization_name as string,
            role: r.role as 'owner' | 'member',
          }))
          const active = memberships.find((m) => m.organization_id === env.organizationId)
          return meResponse.parse({
            user: { id: user.id, email: user.email, name: user.name, email_verified: codecs.boolean.read(user.email_verified) },
            memberships,
            active_organization: active ? { id: active.organization_id, role: active.role, scopes: env.scopes.toStrings() } : null,
          })
        },
      }),
  })
}

/** Account operations: for signed-in users, with no required organisation ([[CORE3]] D11). */
export function accountOperations(): AccountOperation[] {
  return [
    {
      kind: 'account',
      surface: 'meta',
      name: 'me.get',
      summary: 'Who am I: user, memberships and the active organisation',
      tags: ['account'],
      method: 'get',
      path: '/me',
      response: { status: 200, schema: meResponse },
      prepare: (env) => meOperation(env),
    },
  ]
}
