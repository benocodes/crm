import { sql } from 'kysely'
import type { ServiceContext } from '../context.js'
import type { IdentityKind } from './normalize.js'

/** Locks each distinct key for the rest of the transaction, in ascending hash order. */
export async function lockKeys(ctx: ServiceContext, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  await sql`
    SELECT pg_advisory_xact_lock(k) FROM (
      SELECT DISTINCT hashtextextended(key, 0) AS k FROM unnest(${[...keys]}::text[]) AS t(key) ORDER BY k
    ) AS s`.execute(ctx.trx)
}

export const addressKey = (organizationId: string, kind: IdentityKind, value: string) => `identity:${organizationId}:${kind}:${value}`
export const companyDomainKey = (organizationId: string, domain: string) => `company-domain:${organizationId}:${domain}`
