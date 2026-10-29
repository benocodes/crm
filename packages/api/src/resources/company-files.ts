import { z } from 'zod'
import { readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { definePreparedResource } from '../storage/definition.js'

const fields = { company_id: z.uuid(), file_id: z.uuid() }

/**
 * The link between a company and a file ([[CORE25]] D34): created and soft-deleted through the API, never updated, under the
 * `companies` scopes (D25). Both ends must exist in this organisation (the company live); a second LIVE link for the same pair is
 * `409 link_exists` from the plan, and the partial unique index is the commit-time backstop.
 */
export const companyFiles = definePreparedResource({
  name: 'company_files',
  eventName: 'company_file',
  table: 'company_files',
  scopeResource: 'companies',
  operations: ['list', 'get', 'create', 'delete'],
  record: z.object({
    id: z.uuid(),
    company_id: z.uuid(),
    file_id: z.uuid(),
    created_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  create: z.strictObject(fields),
  filters: { company_id: { schema: z.uuid() }, file_id: { schema: z.uuid() } },
  references: { company_id: { table: 'companies', live: true }, file_id: { table: 'files' } },
  conflicts: ({ qc, env, values }) => {
    const companyId = values.company_id
    const fileId = values.file_id
    if (typeof companyId !== 'string' || typeof fileId !== 'string') return []
    const q = qc.db
      .selectFrom('company_files')
      .select('company_files.id')
      .where('company_files.organization_id', '=', env.organizationId)
      .where('company_files.company_id', '=', companyId)
      .where('company_files.file_id', '=', fileId)
      .where('company_files.deleted_at', 'is', null)
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
