import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, codecs, defineOperation, readMaybe, step, ts, unit, type PreparedOperation, type Row } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { deals, type DealRecord } from '../resources/deals.js'
import { afterOf, beforeRead, receipt, resultStep, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'

/**
 * `deals.move_stage` ([[CORE130]] D10, D11): the one write path of a deal's stage. Plan: the deal (without derived fields: it feeds the event, [[CORE131]] D2)
 * and the target stage. The target must be a live stage of the organisation (`400 invalid_reference`) in the deal's own pipeline (`400 validation_error`).
 * The current stage is a no-op: `200` with the record, no write, no event. Otherwise ONE stamp-guarded update sets `stage_id`, `closed_at` and `updated_at`
 * and emits `deal.stage_changed`, never `deal.updated`. The update re-checks the stage at commit (live, same pipeline), so a stage deleted since the plan
 * aborts the unit as drift.
 *
 * `closed_at` (D11), by the target kind: open -> null; won or lost -> unchanged when the deal is already in a stage of that kind (read from the stored row
 * in the update itself, where the right-hand side still sees the old `stage_id`), else the unit's clock.
 */
export function moveStageOperation(env: PreparedEnv, rawId: string, rawStageId: string): PreparedOperation<DealRecord> {
  const id = canonicalId(deals, rawId)
  const stageId = rawStageId.toLowerCase()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<DealRecord>({
    name: 'deals.move_stage',
    mutates: true,
    reads: (qc) => ({
      before: beforeRead(deals, qc, env, id),
      stage: readMaybe(
        qc.db
          .selectFrom('pipeline_stages')
          .select(['pipeline_stages.pipeline_id', 'pipeline_stages.kind'])
          .where('pipeline_stages.id', '=', stageId)
          .where('pipeline_stages.organization_id', '=', env.organizationId)
          .where('pipeline_stages.deleted_at', 'is', null),
      ),
    }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw new ApiError(404, 'not_found', 'deal not found')
      const target = found.maybe('stage')
      if (!target) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(deals, rest as Row)
      if (target.pipeline_id !== before.pipeline_id) throw new ApiError(400, 'validation_error', 'the stage belongs to another pipeline; a deal moves between the stages of its own pipeline')
      const kind = String(target.kind) as 'open' | 'won' | 'lost'
      // Already there: the answer is the record, with the status its stage gives (the kind is immutable, so the planned one is current).
      if (before.stage_id === stageId) return unit({ steps: [], events: [], decode: () => ({ ...before, status: kind }) })
      const closedAt =
        kind === 'open'
          ? null
          : sql<string>`case when (select "pipeline_stages"."kind" from "pipeline_stages" where "pipeline_stages"."id" = "deals"."stage_id") = ${kind} then "deals"."closed_at" else ${at} end`
      const update = qc.db
        .updateTable('deals')
        .set({ stage_id: stageId, closed_at: closedAt, updated_at: at })
        .where('deals.id', '=', id)
        .where('deals.organization_id', '=', env.organizationId)
        .where('deals.deleted_at', 'is', null)
        .where(sql<SqlBool>`${ts.exact(qc, 'deals.updated_at')} = ${String(__stamp)}`)
        .where(
          sql<SqlBool>`exists (select 1 from "pipeline_stages" where "pipeline_stages"."id" = ${stageId} and "pipeline_stages"."organization_id" = ${env.organizationId} and "pipeline_stages"."deleted_at" is null and "pipeline_stages"."pipeline_id" = "deals"."pipeline_id")`,
        )
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'deal.stage_changed',
              resourceType: 'deal',
              resourceId: id,
              before,
              after: afterOf(deals),
            }),
            'first-event',
          ),
          resultStep(deals, qc, env, id, eventId),
        ],
        events: [receipt(deals, eventId, 'stage_changed', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('deals.move_stage')
          return toRecord(deals, rows[0]!)
        },
      })
    },
  })
}
