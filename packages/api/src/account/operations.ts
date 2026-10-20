import { z } from 'zod'
import type { AccountOperation } from '../registry.js'

const role = z.enum(['owner', 'member'])
const meResponse = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable(), email_verified: z.boolean() }),
  memberships: z.array(z.object({ organization_id: z.uuid(), organization_name: z.string(), role })),
  active_organization: z.object({ id: z.uuid(), role, scopes: z.array(z.string()) }).nullable(),
})

/** Account operations: for signed-in users, with no required organisation ([[CORE3]] D11). */
export function accountOperations(): AccountOperation[] {
  return [
    {
      kind: 'account',
      name: 'me.get',
      summary: 'Who am I: user, memberships and the active organisation',
      tags: ['account'],
      method: 'get',
      path: '/me',
      response: { status: 200, schema: meResponse },
      handler: async (ctx) => {
        const user = await ctx.trx
          .selectFrom('users')
          .select(['id', 'email', 'name', 'email_verified'])
          .where('id', '=', ctx.actor.id)
          .executeTakeFirstOrThrow()
        const rows = await ctx.trx
          .selectFrom('memberships')
          .innerJoin('organizations', 'organizations.id', 'memberships.organization_id')
          .select(['organizations.id as organization_id', 'organizations.name as organization_name', 'memberships.role'])
          .where('memberships.user_id', '=', ctx.actor.id)
          .where('memberships.deleted_at', 'is', null)
          .orderBy('organizations.name')
          .orderBy('organizations.id')
          .execute()
        const memberships = rows.map((r) => ({ ...r, role: r.role as 'owner' | 'member' }))
        const active = memberships.find((m) => m.organization_id === ctx.organizationId)
        return {
          user: { id: user.id, email: user.email, name: user.name, email_verified: user.email_verified },
          memberships,
          active_organization: active
            ? { id: active.organization_id, role: active.role, scopes: ctx.scopes.toStrings() }
            : null,
        }
      },
    },
  ]
}
