import { sql } from 'kysely'
import { z } from 'zod'
import { SCOPE_POLICY, isAgentGrantable, type ScopePolicy } from '../auth/roles.js'
import { ApiError } from '../errors.js'
import { defineResource } from './define.js'

export const agentRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  disabled_at: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type AgentRecord = z.infer<typeof agentRecord>

/**
 * Validates scopes for an agent ([[CORE3]] D9): every one must be declared and agent-grantable. The first
 * offender in input order decides the error. Returns the de-duplicated, sorted list.
 */
export function normalizeAgentScopes(scopes: readonly string[], policy: ScopePolicy = SCOPE_POLICY): string[] {
  for (const s of scopes) {
    if (!Object.hasOwn(policy, s)) throw new ApiError(400, 'unknown_scope', `unknown scope: ${s}`)
    if (!isAgentGrantable(s, policy)) throw new ApiError(400, 'scope_not_grantable', `scope not grantable to an agent: ${s}`)
  }
  return [...new Set(scopes)].sort()
}

const name = z.string().trim().min(1).max(200)
const scopesField = z.array(z.string()).max(100)

export const agents = defineResource<AgentRecord>({
  name: 'agents',
  eventName: 'agent',
  table: 'agents',
  scopeResource: 'agents',
  operations: ['list', 'get', 'create', 'update'],
  softDelete: false,
  record: agentRecord,
  create: z.strictObject({ name, scopes: scopesField.default([]) }),
  update: z.strictObject({ name, scopes: scopesField, disabled: z.boolean() }).partial(),
  beforeWrite(_ctx, { input }) {
    const { disabled, ...rest } = input
    const written: Record<string, unknown> = { ...rest }
    if (Array.isArray(input.scopes)) written.scopes = normalizeAgentScopes(input.scopes as string[])
    // Disabling twice keeps the first timestamp.
    if (disabled === true) written.disabled_at = sql`coalesce(disabled_at, now())`
    else if (disabled === false) written.disabled_at = null
    return written
  },
  overrides: {
    async create(ctx, input, generic) {
      // The principal first, without RETURNING: no SELECT policy admits it until its agents row exists (P4).
      const { id } = (await sql<{ id: string }>`SELECT uuid_generate_v7() AS id`.execute(ctx.trx)).rows[0]!
      await ctx.trx.insertInto('principals').values({ id, kind: 'agent' }).execute()
      return generic({ ...input, id })
    },
  },
})
