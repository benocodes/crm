import { z } from 'zod'
import { readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { deleteStageOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export type PipelineStageRecord = {
  id: string
  organization_id: string
  pipeline_id: string
  name: string
  kind: 'open' | 'won' | 'lost'
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

const KINDS = ['open', 'won', 'lost'] as const

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  pipeline_id: z.uuid(),
  name: z.string(),
  kind: z.enum(KINDS),
  position: z.number().int(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CORE130]] D3, D4, D6: a stage is a name, a kind and a position. `kind` and `pipeline_id` are create-only; `position` is an integer >= 0 and need not be unique.
const create = z.strictObject({
  pipeline_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(KINDS),
  position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})
const update = create.pick({ name: true, position: true }).partial()

/**
 * Pipeline stages ([[CORE130]]): the steps of a pipeline, configuration on the `meta` surface under the `pipelines` scopes. The name is unique
 * among the live stages of ONE pipeline, case-insensitively (`409 stage_exists`; the partial unique index is the commit-time backstop). A stage
 * holding a live deal cannot be deleted (`409 stage_in_use`, `identity/cascades.ts`).
 */
export const pipelineStages = withColumnFilters(withColumnSorts(definePreparedResource({
  surface: 'meta',
  name: 'pipeline_stages',
  eventName: 'pipeline_stage',
  table: 'pipeline_stages',
  scopeResource: 'pipelines',
  override: { delete: (env, id) => deleteStageOperation(env, id as string) },
  record,
  create,
  update,
  createOnly: { kind: '', pipeline_id: '' },
  filters: { pipeline_id: { schema: z.uuid() }, kind: { schema: z.enum(KINDS) } },
  references: { pipeline_id: { table: 'pipelines', live: true } },
  conflicts: ({ qc, env, id, values }) => {
    const name = values.name
    if (typeof name !== 'string') return []
    let q = qc.db
      .selectFrom('pipeline_stages')
      .select('pipeline_stages.id')
      .where('pipeline_stages.organization_id', '=', env.organizationId)
      .where('pipeline_stages.name', '=', name)
      .where('pipeline_stages.deleted_at', 'is', null)
    // A create names its pipeline; an update does not (the pipeline is create-only), so it is the stage's own.
    if (id) {
      q = q
        .where('pipeline_stages.id', '!=', id)
        .where('pipeline_stages.pipeline_id', '=', (eb) => eb.selectFrom('pipeline_stages as own').select('own.pipeline_id').where('own.id', '=', id).where('own.organization_id', '=', env.organizationId))
    } else {
      q = q.where('pipeline_stages.pipeline_id', '=', values.pipeline_id as string)
    }
    return [
      {
        read: readMaybe(q.limit(1)),
        refuse: (row) => {
          if (row) throw new ApiError(409, 'stage_exists', `a stage named "${name}" already exists in this pipeline (${String(row.id)})`)
        },
      },
    ]
  },
}), ['position', 'name']))
