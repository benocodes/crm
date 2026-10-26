import { sql, type SqlBool } from 'kysely'
import { assertStep, readMaybe, step, type QueryContext, type Read, type Row, type Step } from '@vault/storage'

/**
 * The one `system` principal that directory writes are attributed to ([[CORE3]] D22, [[CORE41]] P10). It stays lazy:
 * created only by a unit that writes an event and finds none, so it survives a test truncate and needs no seed.
 * Every directory unit plan-reads it; `systemPrincipalSteps` adds the creation when it is absent.
 */
export const SYSTEM_PRINCIPAL_READ = 'system:principal'

export function systemPrincipalRead(qc: QueryContext): Read {
  return readMaybe(qc.db.selectFrom('principals').select('principals.id').where('principals.kind', '=', 'system'))
}

/**
 * The id events are attributed to and the statements that make it exist: none when the plan found it. Otherwise
 * `INSERT ... ON CONFLICT DO NOTHING` (never a caught 23505: invariant 3) and an assertion that the system principal
 * IS the minted one, so two racing first uses cannot both proceed (the loser drifts and its retry finds the winner's).
 * The caller labels the unit's first statement; nothing gated on `changes()` may directly follow the assertion.
 */
export function systemPrincipalSteps(qc: QueryContext, found: Row | null, mint: string, now: string): { id: string; steps: Step[] } {
  if (found) return { id: found.id as string, steps: [] }
  const insert = qc.db.insertInto('principals').values({ id: mint, kind: 'system', created_at: now }).onConflict((oc) => oc.doNothing())
  const holds = sql<SqlBool>`exists (select 1 from "principals" where "principals"."kind" = 'system' and "principals"."id" = ${mint})`
  return { id: mint, steps: [step(insert), assertStep(qc, holds)] }
}
