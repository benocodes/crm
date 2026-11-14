import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ControlOperation } from '../registry.js'
import type { InvitationRow, InvitationsRuntime } from './port.js'
import { INVITATION_TTL_MS, invitationStatus, invitationUrl, newInvitationToken, normaliseInvitationEmail } from './token.js'

const ROLE = z.enum(['owner', 'member', 'agent'])

const createBody = z.strictObject({ email: z.string().max(254).describe('The address the invitation is for; trimmed and lowercased'), role: ROLE })
const listQuery = z.strictObject({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() })

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
})
const createdInvitation = z.object({ id: z.uuid(), email: z.string(), role: ROLE, expires_at: z.iso.datetime({ offset: true }), url: z.string() })

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
})

const needsStore = (runtime: InvitationsRuntime | null): InvitationsRuntime => {
  if (!runtime) throw new ApiError(501, 'provider_not_configured', 'invitations need the built-in auth provider (AUTH_PROVIDER=better-auth); this deployment does not have one')
  return runtime
}

/**
 * [[CORE245]] P2: invitation administration on the meta surface, held in the control plane. Control operations: the registry has them on every composition (one registry, one golden), and
 * where composition has no control store (`runtime` null: Clerk, unset) they answer `501 provider_not_configured`. Owner-held, human-only scopes (P1); not proposable.
 */
export function invitationOperations(runtime: InvitationsRuntime | null): ControlOperation[] {
  const base = { kind: 'control' as const, surface: 'meta' as const, tags: ['invitations'], validation: 'adapter' as const }
  return [
    {
      ...base,
      name: 'invitations.create',
      summary: 'Invite someone to the workspace; the link is shown once',
      description:
        'Human only (owners). Creates an invitation for an email address with a role (owner, member or agent) that expires in 7 days, and returns its link once: the token in the link is never stored or shown again. One live invitation per address: a second answers 409 invitation_exists (revoke the first). The link is inert until sign-up accepts invitations. Answers 501 provider_not_configured when the deployment has no built-in auth provider.',
      method: 'post',
      path: '/invitations',
      scope: { resource: 'invitations', action: 'write' },
      request: { body: createBody },
      response: { status: 201, schema: createdInvitation },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const body = input.body as z.infer<typeof createBody>
        const email = normaliseInvitationEmail(body.email)
        if (email === null) throw new ApiError(400, 'validation_error', 'email is not a valid address')
        const { token, hash } = await newInvitationToken(env.randomBytes)
        const id = env.newId()
        const expiresAt = new Date(env.now.getTime() + INVITATION_TTL_MS).toISOString()
        const made = await rt.port.create({ id, auditId: env.newId(), organizationId: env.organizationId, email, role: body.role, tokenHash: hash, expiresAt, createdBy: env.actor.id, now: env.now.toISOString() })
        if (made === 'live_exists') throw new ApiError(409, 'invitation_exists', 'a live invitation already exists for that address; revoke it first')
        return { id, email, role: body.role, expires_at: expiresAt, url: invitationUrl(rt.publicBaseUrl, token) }
      },
    },
    {
      ...base,
      name: 'invitations.list',
      summary: 'List invitations and whether each is pending, accepted, revoked or expired',
      description: 'Human only (owners). Never returns a token, its hash or the link: the link is shown once, by invitations.create.',
      method: 'get',
      path: '/invitations',
      scope: { resource: 'invitations', action: 'read' },
      request: { query: listQuery },
      response: { status: 200, schema: z.object({ data: z.array(invitationRecord), next_cursor: z.uuid().nullable() }) },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const query = input.query as z.infer<typeof listQuery>
        const limit = query.limit ?? 50
        const rows = await rt.port.list({ ...(query.after ? { after: query.after } : {}), limit: limit + 1 })
        const page = rows.slice(0, limit)
        return { data: page.map((r) => recordOf(r, env.now)), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null }
      },
    },
    {
      ...base,
      name: 'invitations.revoke',
      summary: 'Revoke a pending invitation',
      description: 'Human only (owners). Only a pending invitation can be revoked: an accepted, revoked or expired one answers 409 invitation_not_pending; an unknown id 404.',
      method: 'post',
      path: '/invitations/{id}/revoke',
      scope: { resource: 'invitations', action: 'write' },
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: invitationRecord },
      run: async (env, input) => {
        const rt = needsStore(runtime)
        const out = await rt.port.revoke({ id: input.params.id as string, auditId: env.newId(), actorId: env.actor.id, now: env.now.toISOString() })
        if (out.result === 'not_found') throw new ApiError(404, 'not_found', 'invitation not found')
        if (out.result === 'not_live') throw new ApiError(409, 'invitation_not_pending', `the invitation is ${invitationStatus(out.record, env.now)}: only a pending invitation can be revoked`)
        return recordOf(out.record, env.now)
      },
    },
  ]
}
