import { z } from 'zod'
import { ApiError } from '../errors.js'
import { companyDomainKey, lockKeys } from '../identity/locks.js'
import { normalizeDomain } from '../identity/normalize.js'
import { contacts } from './contacts.js'
import { updateResource } from './crud.js'
import { defineResource } from './define.js'

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

export const companies = defineResource<CompanyRecord>({
  name: 'companies',
  eventName: 'company',
  table: 'companies',
  record,
  create,
  update,
  filters: { domain: { schema: z.string().max(253), normalize: (v) => normalizeDomain(v as string) } },
  async beforeWrite(ctx, { input, before }) {
    if (typeof input.domain !== 'string') return input
    const domain = normalizeDomain(input.domain)
    await lockKeys(ctx, [companyDomainKey(ctx.organizationId, domain)])
    let q = ctx.trx.selectFrom('companies').select('id').where('domain', '=', domain).where('deleted_at', 'is', null)
    if (before) q = q.where('id', '!=', before.id)
    const clash = await q.executeTakeFirst()
    if (clash) throw new ApiError(409, 'domain_exists', `a company with domain ${domain} already exists (${clash.id})`)
    return { ...input, domain }
  },
  overrides: {
    async delete(ctx, id, generic) {
      await generic(id)
      const rows = await ctx.trx
        .selectFrom('contacts')
        .select('id')
        .where('company_id', '=', id)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .execute()
      for (const row of rows) await updateResource(ctx, contacts, row.id, { company_id: null })
    },
  },
})
