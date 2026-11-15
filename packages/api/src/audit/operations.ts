import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ControlOperation } from '../registry.js'
import type { AuditRuntime } from './port.js'

const listQuery = z.strictObject({
  action: z.string().min(1).max(200).optional().describe('Exact match on the action, for example invitation.created'),
  target_type: z.string().min(1).max(200).optional().describe('Exact match on the target type, for example invitation'),
  target_id: z.string().min(1).max(200).optional().describe('Exact match on the target id'),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const auditRecord = z.object({
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  actor_id: z.uuid(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  detail: z.record(z.string(), z.unknown()),
})

/**
 * [[CORE261]] P1-P6: the control plane's audit log on the meta surface. A control operation: where composition has no control store (`runtime` null: Clerk, unset) it answers
 * `501 provider_not_configured` after the scope check. Reading writes nothing and is not itself audited (P6).
 */
export function auditOperations(runtime: AuditRuntime | null): ControlOperation[] {
  return [
    {
      kind: 'control',
      surface: 'meta',
      tags: ['audit'],
      validation: 'adapter',
      name: 'audit.list',
      summary: 'Browse the control-plane audit log',
      description:
        'Owners, and agents an owner granted audit:read. A log to browse, not a feed: rows come oldest first by id, filtered by exact action, target_type and target_id (combinable), 50 per page by default (limit 1 to 200); pass next_cursor as after for the next page, null on the last. Rows are as stored (invitations created, revoked and accepted, sessions revoked on removal, reset links issued); detail is the stored object and never holds a token. Reading is not itself audited. The log has no sequence number, so a row written by a lagging clock can land behind a cursor already read. Answers 501 provider_not_configured when the deployment has no control-plane database.',
      method: 'get',
      path: '/audit',
      scope: { resource: 'audit', action: 'read' },
      request: { query: listQuery },
      response: {
        status: 200,
        schema: z.object({ data: z.array(auditRecord), next_cursor: z.uuid().nullable() }),
      },
      run: async (_env, input) => {
        if (!runtime)
          throw new ApiError(
            501,
            'provider_not_configured',
            'the audit log is held in the control-plane database (CONTROL_DB), which this deployment does not have',
          )
        const query = input.query as z.infer<typeof listQuery>
        const limit = query.limit ?? 50
        const rows = await runtime.port.list({
          ...(query.after ? { after: query.after } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.target_type ? { targetType: query.target_type } : {}),
          ...(query.target_id ? { targetId: query.target_id } : {}),
          limit: limit + 1,
        })
        const page = rows.slice(0, limit)
        return {
          data: page.map((r) => ({
            id: r.id,
            at: r.at,
            actor_id: r.actorId,
            action: r.action,
            target_type: r.targetType,
            target_id: r.targetId,
            detail: r.detail,
          })),
          next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
        }
      },
    },
  ]
}
