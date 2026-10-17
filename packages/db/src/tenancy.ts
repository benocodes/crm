import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './types.js'

export type TenancyContext = { principalId: string; organizationId: string }

export class TenancyContextError extends Error {
  override name = 'TenancyContextError'
  constructor(
    message: string,
    public code: 'missing_organization' | 'missing_principal' | 'invalid_id',
  ) {
    super(message)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validate(context: TenancyContext): void {
  if (!context.organizationId) throw new TenancyContextError('organization id is required', 'missing_organization')
  if (!context.principalId) throw new TenancyContextError('principal id is required', 'missing_principal')
  if (!UUID.test(context.organizationId) || !UUID.test(context.principalId)) {
    throw new TenancyContextError('organization and principal ids must be UUIDs', 'invalid_id')
  }
}

/**
 * Runs `fn` in a transaction as `vault_authenticated` with the tenant settings set
 * transaction-locally, so RLS scopes every query to the organisation. Together with
 * `withServiceRole`, the only code that sets session config or a role (AGENTS.md invariant 1).
 */
export async function withOrganization<T>(
  db: Kysely<Database>,
  context: TenancyContext,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  validate(context)
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.organization_id', ${context.organizationId}, true),
                     set_config('app.principal_id', ${context.principalId}, true)`.execute(trx)
    await sql`SET LOCAL ROLE vault_authenticated`.execute(trx)
    return fn(trx)
  })
}

/** Runs `fn` in a transaction as `vault_service` (BYPASSRLS), with no tenant settings. */
export async function withServiceRole<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE vault_service`.execute(trx)
    return fn(trx)
  })
}
