import { logEmailFailure } from '../email/log.js'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { readAgentForInvitation } from './crm-reads.js'
import type { ControlOperation } from '../registry.js'
import type { InvitationRow, InvitationsRuntime } from './port.js'
import { invitationMessage } from './message.js'
import {
  INVITATION_TTL_MS,
  invitationStatus,
  invitationUrl,
  newInvitationToken,
  normaliseInvitationEmail,
} from './token.js'

const ROLE = z.enum(['owner', 'member', 'agent'])

const DELIVERY = z.enum(['email', 'link'])
const createBody = z.strictObject({
  email: z.string().max(254).describe('The address the invitation is for; trimmed and lowercased'),
  role: ROLE.optional().describe(
    'owner or member; agent only beside agent_id. Optional with agent_id (it implies agent), required without it.',
  ),
  agent_id: z
    .uuid()
    .optional()
    .describe(
      'The existing agent this invitation is for (create it first with agents.create). Implies role agent; the agent then signs up with the invitation and its account is linked to this agent.',
    ),
  delivery: DELIVERY.optional().describe(
    'email: the vault emails the link and does not return it (default when email is configured). link: the link is returned once, nothing is sent (default otherwise).',
  ),
})
const listQuery = z.strictObject({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** What list and revoke answer with: no token, no hash, no URL (the link is shown once, by create). `status` is derived from the clock. */
const invitationRecord = z.object({
  id: z.uuid(),
  email: z.string(),
  role: ROLE,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expires_at: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
  created_by: z.uuid(),
  accepted_at: z.iso.datetime({ offset: true }).nullable(),
  revoked_at: z.iso.datetime({ offset: true }).nullable(),
  delivery: DELIVERY,
  agent_id: z.uuid().nullable(),
})
/** `url` only for `delivery: link`: an emailed invitation's token leaves the vault only toward the mailbox ([[CORE248]] D3). */
const createdInvitation = z.object({
  id: z.uuid(),
  email: z.string(),
  role: ROLE,
  expires_at: z.iso.datetime({ offset: true }),
  delivery: DELIVERY,
  agent_id: z.uuid().nullable(),
  url: z.string().optional(),
})

const recordOf = (row: InvitationRow, now: Date): z.infer<typeof invitationRecord> => ({
  id: row.id,
  email: row.email,
  role: row.role,
  status: invitationStatus(row, now),
  expires_at: row.expiresAt,
  created_at: row.createdAt,
  created_by: row.createdBy,
  accepted_at: row.acceptedAt,
  revoked_at: row.revokedAt,
  delivery: row.delivery,
  agent_id: row.agentId,
})

const needsStore = (runtime: InvitationsRuntime | null): InvitationsRuntime => {
  if (!runtime)
    throw new ApiError(
      501,
      'provider_not_configured',
      'invitations need the built-in auth provider (AUTH_PROVIDER=better-auth); this deployment does not have one',
    )
  return runtime
}

/**
 * [[CORE245]] P2: invitation administration on the meta surface, held in the control plane. Control operations: the registry has them on every composition (one registry, one golden), and
 * where composition has no control store (`runtime` null: Clerk, unset) they answer `501 provider_not_configured`. Owner-held, human-only scopes (P1); not proposable.
 */
export function invitationOperations(runtime: InvitationsRuntime | null): ControlOperation[] {
  const base = {
    kind: 'control' as const,
    surface: 'meta' as const,
    tags: ['invitations'],
    validation: 'adapter' as const,
  }
  return [
    {
      ...base,
      name: 'invitations.create',
      summary: 'Invite someone to the workspace; the link is emailed or shown once',
      description:
        'Human only (owners). Creates an invitation for an email address with a role (owner, member or agent) that expires in 7 days, and either emails the link (delivery email, the default when the deployment has email configured; the answer has no url) or returns it once (delivery link, the default otherwise): the token in the link is never stored or shown again. Delivery email while email is not configured answers 501 email_not_configured; when the message cannot be sent the invitation is revoked and the answer is 502 email_send_failed (retry, or use delivery link); if that revoke also fails the invitation stays pending, inert, until it expires or an owner revokes it, and a retry answers 409 invitation_exists. One live invitation per address: a second answers 409 invitation_exists (revoke the first). An agent invitation names an existing agent with agent_id (which implies role agent; another role beside it answers 400 validation_error, and role agent without it answers 400 agent_id_required): the agent must exist (404 not_found) and may not be a form agent (409 form_principal), a delegated agent (409 delegated_agent), a disabled agent (409 agent_disabled) or one that already has a sign-in account (409 agent_has_account). Creating one revokes the other live invitations of that agent; a live invitation for the same address that is not for this agent answers 409 invitation_exists. The link is inert until sign-up accepts invitations. Answers 501 provider_not_configured when the deployment has no built-in auth provider.',
      method: 'post',
      path: '/invitations',
      scope: { resource: 'invitations', action: 'write' },
      request: { body: createBody },
      response: { status: 201, schema: createdInvitation },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const body = input.body as z.infer<typeof createBody>
        // [[AGT701]] D13 (ruling 701.24): agent_id implies the agent role; role agent alone is refused.
        if (body.agent_id === undefined && body.role === 'agent')
          throw new ApiError(
            400,
            'agent_id_required',
            'create the agent with `vibase agents create`, then invite it with its `agent_id`',
          )
        if (body.agent_id !== undefined && body.role !== undefined && body.role !== 'agent')
          throw new ApiError(400, 'validation_error', 'role must be agent, or omitted, beside agent_id')
        if (body.agent_id === undefined && body.role === undefined)
          throw new ApiError(400, 'validation_error', 'role is required without agent_id')
        const role = body.agent_id === undefined ? body.role! : 'agent'
        const email = normaliseInvitationEmail(body.email)
        if (email === null) throw new ApiError(400, 'validation_error', 'email is not a valid address')
        const delivery = body.delivery ?? (rt.email ? 'email' : 'link')
        if (delivery === 'email' && !rt.email)
          throw new ApiError(
            501,
            'email_not_configured',
            'email is not configured on this deployment (EMAIL binding and AUTH_EMAIL_FROM); use delivery link',
          )
        const agentId = body.agent_id?.toLowerCase()
        if (agentId !== undefined) {
          const agent = await env.read(readAgentForInvitation(env.organizationId, agentId))
          if (!agent) throw new ApiError(404, 'not_found', 'agent not found')
          if (agent.formId !== null)
            throw new ApiError(409, 'form_principal', `managed by form ${agent.formId}; change the form`)
          if (agent.delegated)
            throw new ApiError(
              409,
              'delegated_agent',
              "a delegated agent acts through its member's OAuth grant; create an agent of its own to invite",
            )
          if (agent.disabled)
            throw new ApiError(409, 'agent_disabled', 'the agent is disabled; enable it before inviting it')
          if (agent.hasAccount)
            throw new ApiError(
              409,
              'agent_has_account',
              'the agent already has a sign-in account; it cannot be invited again',
            )
        }
        const { token, hash } = await newInvitationToken(env.randomBytes)
        const id = env.newId()
        const expiresAt = new Date(env.now.getTime() + INVITATION_TTL_MS).toISOString()
        const insert = {
          id,
          auditId: env.newId(),
          organizationId: env.organizationId,
          email,
          role,
          tokenHash: hash,
          expiresAt,
          createdBy: env.actor.id,
          delivery,
          now: env.now.toISOString(),
        }
        // [[AGT701]] D15: an agent invitation replaces the agent's live ones in one batch; owner and member creation are as before.
        const made =
          agentId === undefined
            ? await rt.port.create(insert)
            : (await rt.port.reissueAgent({ ...insert, agentId, newAuditId: env.newId })).result === 'created'
              ? 'created'
              : 'live_exists'
        if (made === 'live_exists')
          throw new ApiError(
            409,
            'invitation_exists',
            'a live invitation already exists for that address; revoke it first',
          )
        const url = invitationUrl(rt.publicBaseUrl, token)
        const agent_id = agentId ?? null
        if (delivery === 'link') return { id, email, role, expires_at: expiresAt, delivery, agent_id, url }
        // The write came first (a 409 above sent nothing); now the send, awaited. A failure revokes the invitation so a failed send never leaves a live one the owner believes was delivered.
        try {
          await rt.email!.send({
            to: email,
            ...invitationMessage({ host: new URL(rt.publicBaseUrl).host, url, role, expiresAt }),
          })
        } catch (sendErr) {
          logEmailFailure('invitation_send_failed', sendErr)
          try {
            await rt.port.revoke({
              id,
              auditId: env.newId(),
              actorId: env.actor.id,
              now: env.now.toISOString(),
              reason: 'email_failed',
            })
          } catch (revokeErr) {
            // The invitation stays pending with a token nobody holds: inert, visible in invitations.list, expires in 7 days.
            logEmailFailure('invitation_revoke_failed', revokeErr)
          }
          throw new ApiError(
            502,
            'email_send_failed',
            'the invitation email could not be sent; the invitation may still be pending (see invitations.list). Retry, or create it with delivery link; if a retry answers invitation_exists, revoke the pending invitation first',
          )
        }
        return { id, email, role, expires_at: expiresAt, delivery, agent_id }
      },
    },
    {
      ...base,
      name: 'invitations.list',
      summary: 'List invitations and whether each is pending, accepted, revoked or expired',
      description:
        'Human only (owners). Never returns a token, its hash or the link: the link is shown once, by invitations.create.',
      method: 'get',
      path: '/invitations',
      scope: { resource: 'invitations', action: 'read' },
      request: { query: listQuery },
      response: {
        status: 200,
        schema: z.object({ data: z.array(invitationRecord), next_cursor: z.uuid().nullable() }),
      },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const query = input.query as z.infer<typeof listQuery>
        const limit = query.limit ?? 50
        const rows = await rt.port.list({ ...(query.after ? { after: query.after } : {}), limit: limit + 1 })
        const page = rows.slice(0, limit)
        return {
          data: page.map((r) => recordOf(r, env.now)),
          next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
        }
      },
    },
    {
      ...base,
      name: 'invitations.revoke',
      summary: 'Revoke a pending invitation',
      description:
        'Human only (owners). Only a pending invitation can be revoked: an accepted, revoked or expired one answers 409 invitation_not_pending; an unknown id 404.',
      method: 'post',
      path: '/invitations/{id}/revoke',
      scope: { resource: 'invitations', action: 'write' },
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: invitationRecord },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const out = await rt.port.revoke({
          id: input.params.id as string,
          auditId: env.newId(),
          actorId: env.actor.id,
          now: env.now.toISOString(),
        })
        if (out.result === 'not_found') throw new ApiError(404, 'not_found', 'invitation not found')
        if (out.result === 'not_live')
          throw new ApiError(
            409,
            'invitation_not_pending',
            `the invitation is ${invitationStatus(out.record, env.now)}: only a pending invitation can be revoked`,
          )
        return recordOf(out.record, env.now)
      },
    },
  ]
}
