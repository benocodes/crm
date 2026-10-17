import type { Kysely, Transaction } from 'kysely'
import { TenancyContextError, withOrganization, withServiceRole, type Database } from '@vault/db'
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

/** Account operations ([[CORE3]]): no organisation, service role, explicit organisation per event. */
export interface AccountContext {
  readonly trx: Transaction<Database>
  readonly actor: Actor
  emitFor(organizationId: string, event: EmitInput): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

export async function withAccountContext<T>(
  db: Kysely<Database>,
  principal: { actor: Actor },
  fn: (ctx: AccountContext) => Promise<T>,
): Promise<T> {
  const { actor } = principal
  return withServiceRole(db, (trx) =>
    fn({
      trx,
      actor,
      async emitFor(organizationId, event) {
        if (!UUID.test(organizationId)) {
          throw new TenancyContextError('organization id must be a UUID', 'invalid_id')
        }
        await writeEvent(trx, { ...event, organizationId, actorId: actor.id })
      },
    }),
  ).catch((err) => {
    throw mapDatabaseError(err)
  })
}
