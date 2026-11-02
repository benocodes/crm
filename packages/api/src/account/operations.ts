import { z } from 'zod'
import { codecs, defineOperation, readAll, readMaybe, readOne, unit, type PreparedOperation } from '@vault/storage'
import type { Role } from '../auth/roles.js'
import type { AccountEnv, AccountOperation } from '../registry.js'

const role = z.enum(['owner', 'member'])
const meResponse = z.object({
  principal: z.object({ id: z.uuid(), kind: z.enum(['user', 'agent']) }),
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable(), email_verified: z.boolean() }).nullable(),
  agent: z
    .object({
      id: z.uuid(),
      name: z.string(),
      delegated_by: z.uuid().nullable(),
      auth_client_id: z.string().nullable(),
      auth_subject: z.string().nullable(),
    })
    .nullable(),
  client_id: z.string().nullable(),
  memberships: z.array(z.object({ organization_id: z.uuid(), organization_name: z.string(), role })),
  active_organization: z.object({ id: z.uuid(), role: role.nullable(), scopes: z.array(z.string()) }).nullable(),
})
export type MeResponse = z.infer<typeof meResponse>

/**
 * `me.get` ([[CORE41]] C5, P12; [[CORE64]]): a read-only prepared account operation. Two answers.
 *
 * - The copy-based answer (Postgres, and the Organizations authenticator on any engine): the user by the actor's id, their live
 *   memberships joined to the organisations (ordered by name, then id), and the active organisation with the caller's scopes.
 * - The workspace answer (a single-workspace composition, `env.workspace` set, [[CORE64]] D10): no membership row is read. The one
 *   membership is synthesised from the role in the token and the deployment's organisation; an agent has none and no role. `agent` carries the principal links
 *   ([[CORE77]] D23, null for an API-key agent) and `client_id` is the token's OAuth client, null for a session token and an API key.
 */
export function meOperation(env: AccountEnv): PreparedOperation<MeResponse> {
  if (env.workspace) return workspaceMeOperation(env, env.workspace)
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
            principal: { id: env.actor.id, kind: 'user' },
            user: { id: user.id, email: user.email, name: user.name, email_verified: codecs.boolean.read(user.email_verified) },
            agent: null,
            client_id: null,
            memberships,
            active_organization: active ? { id: active.organization_id, role: active.role, scopes: env.scopes.toStrings() } : null,
          })
        },
      }),
  })
}

function workspaceMeOperation(env: AccountEnv, workspace: { role: Role | null; clientId: string | null }): PreparedOperation<MeResponse> {
  const isUser = env.actor.kind === 'user'
  return defineOperation<MeResponse>({
    name: 'me.get',
    mutates: false,
    reads: (qc) => ({
      org: readMaybe(qc.db.selectFrom('organizations').select(['organizations.id', 'organizations.name']).where('organizations.id', '=', env.organizationId ?? '')),
      ...(isUser
        ? { user: readOne(qc.db.selectFrom('users').select(['users.id', 'users.email', 'users.name', 'users.email_verified']).where('users.id', '=', env.actor.id)) }
        : { agent: readOne(qc.db.selectFrom('agents').select(['agents.id', 'agents.name', 'agents.delegated_by', 'agents.auth_client_id', 'agents.auth_subject']).where('agents.id', '=', env.actor.id)) }),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const org = found.maybe('org')
          const role = isUser ? workspace.role : null
          const memberships = isUser && org && role ? [{ organization_id: org.id as string, organization_name: org.name as string, role }] : []
          const user = isUser ? found.one('user') : null
          const agent = isUser ? null : found.one('agent')
          return meResponse.parse({
            principal: { id: env.actor.id, kind: env.actor.kind },
            user: user ? { id: user.id, email: user.email, name: user.name, email_verified: codecs.boolean.read(user.email_verified) } : null,
            agent: agent ? { id: agent.id, name: agent.name, delegated_by: agent.delegated_by, auth_client_id: agent.auth_client_id, auth_subject: agent.auth_subject } : null,
            client_id: workspace.clientId,
            memberships,
            active_organization: org ? { id: org.id, role, scopes: env.scopes.toStrings() } : null,
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
      summary: 'Who am I: the principal (user or agent), memberships and the active organisation',
      agents: true,
      tags: ['account'],
      method: 'get',
      path: '/me',
      response: { status: 200, schema: meResponse },
      prepare: (env) => meOperation(env),
    },
  ]
}
