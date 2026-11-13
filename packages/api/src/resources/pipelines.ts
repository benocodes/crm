import { z } from 'zod'
import { readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { deletePipelineOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export type PipelineRecord = {
  id: string
  organization_id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CORE130]] D6: the name is trimmed, 1-100 characters; `created_by` and `organization_id` are never input.
const fields = { name: z.string().trim().min(1).max(100) }
const create = z.strictObject(fields)
const update = create.partial()

/**
 * Pipelines ([[CORE130]]): a named sales process, configuration on the `meta` surface. The name is unique among live pipelines,
 * case-insensitively (the column's NOCASE collation): a live duplicate refuses the write in the plan (`409 pipeline_exists`), the partial
 * unique index is the commit-time backstop. Delete is refused while a live deal is in the pipeline and otherwise cascades its stages.
 */
export const pipelines = withColumnFilters(withColumnSorts(definePreparedResource({
  surface: 'meta',
  name: 'pipelines',
  eventName: 'pipeline',
  table: 'pipelines',
  override: { delete: (env, id) => deletePipelineOperation(env, id as string) },
  record,
  create,
  update,
  filters: { name: { schema: z.string().trim().min(1).max(100) } },
  conflicts: ({ qc, env, id, values }) => {
    const name = values.name
    if (typeof name !== 'string') return []
    let q = qc.db
      .selectFrom('pipelines')
      .select('pipelines.id')
      .where('pipelines.organization_id', '=', env.organizationId)
      .where('pipelines.name', '=', name)
      .where('pipelines.deleted_at', 'is', null)
    if (id) q = q.where('pipelines.id', '!=', id)
    return [
      {
        read: readMaybe(q.limit(1)),
        refuse: (row) => {
          if (row) throw new ApiError(409, 'pipeline_exists', `a pipeline named "${name}" already exists (${String(row.id)})`)
        },
      },
    ]
  },
}), ['name']))
