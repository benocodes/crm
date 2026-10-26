import type { Kysely, Transaction } from 'kysely'
import { withOrganization, type Database } from '@vault/db'
import { mapDatabaseError } from './errors.js'
import { writeEvent, type EventInput } from './outbox.js'
import type { ScopeSet } from './scopes.js'

export type Actor = { id: string; kind: 'user' | 'agent' }
export type EmitInput = Omit<EventInput, 'organizationId' | 'actorId'>

/**
 * What every tenant operation runs on: the transaction, the actor, the organisation and the granted
 * scopes. There is deliberately no `db` handle, so a handler cannot escape the transaction.
 */
export interface ServiceContext {
  readonly trx: Transaction<Database>
  readonly actor: Actor
  readonly organizationId: string
  readonly scopes: ScopeSet
  emit(event: EmitInput): Promise<void>
}

export async function withContext<T>(
  db: Kysely<Database>,
  principal: { actor: Actor; organizationId: string; scopes: ScopeSet },
  fn: (ctx: ServiceContext) => Promise<T>,
): Promise<T> {
  const { actor, organizationId, scopes } = principal
  return withOrganization(db, { principalId: actor.id, organizationId }, (trx) =>
    fn({
      trx,
      actor,
      organizationId,
      scopes,
      async emit(event) {
        await writeEvent(trx, { ...event, organizationId, actorId: actor.id })
      },
    }),
  ).catch((err) => {
    throw mapDatabaseError(err)
  })
}
