import { readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { extendDefinition, type ExtensionFields } from '../custom/extension-fields.js'
import { companiesDeclaration } from '../declarations/companies.js'
import { createSchema, filterOptions, recordSchema, updateSchema } from '../declarations/builtin.js'
import { deleteCompanyOperation } from '../identity/cascades.js'
import { normalizeDomain } from '../identity/normalize.js'
import type { Bag } from '../storage/additional-props.js'
import { definePreparedResource } from '../storage/definition.js'
import { withPropertyBag } from '../storage/bag-filter.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { defaultBuiltIns, type BuiltInLookup } from './built-ins.js'
import { tagIdFilter, tagNameFilter } from './tag-filter.js'

export type CompanyRecord = {
  id: string
  organization_id: string
  name: string
  domain: string | null
  additional_props: Bag
  created_by: string
  created_at: string
  updated_at: string
}

// [[CORE554]]: the record, create and update schemas, the filters and the sorts are derived from the declaration (`declarations/companies.ts`).
const record = recordSchema<CompanyRecord>(companiesDeclaration)
const create = createSchema(companiesDeclaration)
const update = updateSchema(companiesDeclaration)

/**
 * Companies on the prepared path ([[CORE36]]). The domain is normalised in preparation; a live company with that
 * domain refuses the write in the plan (`409 domain_exists`); the partial unique index is the commit-time re-check.
 * Delete unlinks the company's live contacts as a set (`identity/cascades.ts`).
 */
export function defineCompanies(ext: ExtensionFields | undefined, builtIns: () => BuiltInLookup) {
  const companiesBase = withColumnFilters(
    withColumnSorts(
      extendDefinition(
        definePreparedResource({
          surface: 'api',
          name: 'companies',
          eventName: 'company',
          table: 'companies',
          associable: true,
          customFilters: { tag_id: tagIdFilter('companies'), tag: tagNameFilter('companies') },
          record,
          create,
          update,
          filters: filterOptions(companiesDeclaration),
          prepare: ({ values }) =>
            typeof values.domain === 'string' ? { domain: normalizeDomain(values.domain) } : {},
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
                  if (row)
                    throw new ApiError(
                      409,
                      'domain_exists',
                      `a company with domain ${domain} already exists (${String(row.id)})`,
                    )
                },
              },
            ]
          },
          override: { delete: (env, id) => deleteCompanyOperation(env, id as string, builtIns()) },
        }),
        ext,
      ),
      companiesDeclaration.sorts,
    ),
  )

  /** [[CORE549]] D10: the list takes the bag filter, `additional_props=<key>.<condition>`. */
  return withPropertyBag(companiesBase)
}

export const companies = defineCompanies(undefined, defaultBuiltIns)
