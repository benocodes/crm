import { z } from 'zod'
import { readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { definePreparedResource } from '../storage/definition.js'

const fields = { contact_id: z.uuid(), file_id: z.uuid() }

/**
 * The link between a contact and a file ([[CORE25]] D34): created and soft-deleted through the API, never updated, under the
 * `contacts` scopes (D25). Both ends must exist in this organisation (the contact live); a second LIVE link for the same pair is
 * `409 link_exists` from the plan, and the partial unique index is the commit-time backstop.
 */
export const contactFiles = definePreparedResource({
  surface: 'api',
  name: 'contact_files',
  eventName: 'contact_file',
  table: 'contact_files',
  scopeResource: 'contacts',
  operations: ['list', 'get', 'create', 'delete'],
  record: z.object({
    id: z.uuid(),
    contact_id: z.uuid(),
    file_id: z.uuid(),
    created_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  create: z.strictObject(fields),
  filters: { contact_id: { schema: z.uuid() }, file_id: { schema: z.uuid() } },
  references: { contact_id: { table: 'contacts', live: true }, file_id: { table: 'files' } },
  conflicts: ({ qc, env, values }) => {
    const contactId = values.contact_id
    const fileId = values.file_id
    if (typeof contactId !== 'string' || typeof fileId !== 'string') return []
    const q = qc.db
      .selectFrom('contact_files')
      .select('contact_files.id')
      .where('contact_files.organization_id', '=', env.organizationId)
      .where('contact_files.contact_id', '=', contactId)
      .where('contact_files.file_id', '=', fileId)
      .where('contact_files.deleted_at', 'is', null)
    return [
      {
        read: readMaybe(q.limit(1)),
        refuse: (row) => {
          if (row) throw new ApiError(409, 'link_exists', `a live link to file ${fileId} already exists (${String(row.id)})`)
        },
      },
    ]
  },
})
