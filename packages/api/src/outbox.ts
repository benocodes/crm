import type { Transaction } from 'kysely'
import type { Database } from '@vault/db'

export type EventInput = {
  organizationId: string
  actorId: string
  /** '<eventName>.<action>', e.g. 'task.created'. */
  type: string
  /** The definition's eventName, e.g. 'task'. */
  resourceType: string
  resourceId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

const json = (value: Record<string, unknown> | null): string | null => (value === null ? null : JSON.stringify(value))

/**
 * Appends one `events` row on the transaction it is given, so the event commits or rolls back with the
 * write. The only code that inserts into `events` (AGENTS.md invariant 5); callers use `ctx.emit`.
 */
export async function writeEvent(trx: Transaction<Database>, event: EventInput): Promise<{ id: string }> {
  return trx
    .insertInto('events')
    .values({
      organization_id: event.organizationId,
      actor_id: event.actorId,
      type: event.type,
      resource_type: event.resourceType,
      resource_id: event.resourceId,
      before: json(event.before),
      after: json(event.after),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}
