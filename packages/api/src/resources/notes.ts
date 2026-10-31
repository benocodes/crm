import { z } from 'zod'
import { deleteNoteOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'

export type NoteRecord = {
  id: string
  organization_id: string
  title: string | null
  content: string
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  title: z.string().nullable(),
  content: z.string(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CORE62]] D17: a Markdown note. The body is stored as written (no trimming); `created_by` and `organization_id` are never input.
const fields = {
  title: z.string().trim().min(1).max(500).nullable().optional(),
  content: z.string().min(1).max(100_000),
}
const create = z.strictObject(fields)
const update = create.partial()

export const notes = definePreparedResource({
  surface: 'api',
  name: 'notes',
  eventName: 'note',
  table: 'notes',
  associable: true,
  override: { delete: (env, id) => deleteNoteOperation(env, id as string) },
  record,
  create,
  update,
  filters: { created_by: { schema: z.uuid() } },
})
