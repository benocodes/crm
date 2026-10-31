import { z } from 'zod'
import { readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { deleteCompanyOperation } from '../identity/cascades.js'
import { normalizeDomain } from '../identity/normalize.js'
import { definePreparedResource } from '../storage/definition.js'

export type CompanyRecord = {
  id: string
  organization_id: string
  name: string
  domain: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

const fields = {
  name: z.string().trim().min(1).max(500),
  domain: z.string().max(253).nullable().optional(),
}
const create = z.strictObject(fields)
const update = create.partial()

/**
 * Companies on the prepared path ([[CORE36]]). The domain is normalised in preparation; a live company with that
 * domain refuses the write in the plan (`409 domain_exists`); the partial unique index is the commit-time re-check.
 * Delete unlinks the company's live contacts as a set (`identity/cascades.ts`).
 */
export const companies = definePreparedResource({
  surface: 'api',
  name: 'companies',
  eventName: 'company',
  table: 'companies',
  associable: true,
  record,
  create,
  update,
  filters: { domain: { schema: z.string().max(253), normalize: (v) => normalizeDomain(v as string) } },
  prepare: ({ values }) => (typeof values.domain === 'string' ? { domain: normalizeDomain(values.domain) } : {}),
  conflicts: ({ qc, env, id, values }) => {
    const domain = values.domain
    if (typeof domain !== 'string') return []
    let q = qc.db
      .selectFrom('companies')
      .select('companies.id')
      .where('companies.organization_id', '=', env.organizationId)
      .where('companies.domain', '=', domain)
      .where('companies.deleted_at', 'is', null)
    if (id) q = q.where('companies.id', '!=', id)
    return [
      {
        read: readMaybe(q.limit(1)),
        refuse: (row) => {
          if (row) throw new ApiError(409, 'domain_exists', `a company with domain ${domain} already exists (${String(row.id)})`)
        },
      },
    ]
  },
  override: { delete: (env, id) => deleteCompanyOperation(env, id as string) },
})
