import { z } from 'zod'
import { readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { deleteTagOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'

export type TagRecord = {
  id: string
  organization_id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CORE129]] D3-D5: no colour (a presentation concern); the name is trimmed, 1-100 characters; `created_by` and `organization_id` are never input.
const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).nullable().optional(),
}
const create = z.strictObject(fields)
const update = create.partial()

/** The records a tag can label ([[CORE129]] D8); `associations.create` refuses any other neighbour for a tag. */
export const TAGGABLE = ['companies', 'contacts', 'deals', 'tasks', 'notes'] as const

/**
 * Tags ([[CORE129]]): a named list on the generic CRUD core, shaped like notes. The name is unique among live tags,
 * case-insensitively (the column's NOCASE collation): a live duplicate refuses the write in the plan (`409 tag_exists`),
 * the partial unique index is the commit-time backstop. Delete cascades the tag's live edges (`identity/cascades.ts`).
 */
export const tags = withColumnSorts(definePreparedResource({
  surface: 'api',
  name: 'tags',
  eventName: 'tag',
  table: 'tags',
  associable: true,
  neighbours: TAGGABLE,
  override: { delete: (env, id) => deleteTagOperation(env, id as string) },
  record,
  create,
  update,
  filters: { name: { schema: z.string().trim().min(1).max(100) }, created_by: { schema: z.uuid() } },
  conflicts: ({ qc, env, id, values }) => {
    const name = values.name
    if (typeof name !== 'string') return []
    let q = qc.db
      .selectFrom('tags')
      .select('tags.id')
      .where('tags.organization_id', '=', env.organizationId)
      .where('tags.name', '=', name)
      .where('tags.deleted_at', 'is', null)
    if (id) q = q.where('tags.id', '!=', id)
    return [
      {
        read: readMaybe(q.limit(1)),
        refuse: (row) => {
          if (row) throw new ApiError(409, 'tag_exists', `a tag named "${name}" already exists (${String(row.id)})`)
        },
      },
    ]
  },
}), ['name'])
