import { extendDefinition, type ExtensionFields } from '../custom/extension-fields.js'
import { createSchema, filterOptions, recordSchema, updateSchema } from '../declarations/builtin.js'
import { contactsDeclaration } from '../declarations/contacts.js'
import { deleteContactOperation } from '../identity/cascades.js'
import type { Bag } from '../storage/additional-props.js'
import { definePreparedResource } from '../storage/definition.js'
import { withPropertyBag } from '../storage/bag-filter.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withAggregate } from '../storage/aggregate.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { defaultBuiltIns, type BuiltInLookup } from './built-ins.js'
import { contactActivityFilters, contactDerived } from './contact-activity.js'
import { tagIdFilter, tagNameFilter } from './tag-filter.js'

export type ContactRecord = {
  id: string
  organization_id: string
  name: string | null
  company_id: string | null
  merged_into_id: string | null
  additional_props: Bag
  created_by: string
  created_at: string
  updated_at: string
  /** Derived ([[CORE131]]): present only for a caller holding `interactions:read`. */
  last_contacted_at?: string | null
  last_interacted_at?: string | null
}

// [[CORE554]]: the record, create and update schemas, the filters and the sorts are derived from the declaration (`declarations/contacts.ts`).
const record = recordSchema<ContactRecord>(contactsDeclaration)
const create = createSchema(contactsDeclaration)
const update = updateSchema(contactsDeclaration)

/**
 * Contacts on the prepared path ([[CORE36]]): the company must be a live company of this organisation; delete tombstones the identities as a set. [[CORE559]]: `ext` is the contacts' `extend` entry (absent: the definition of a deployment
 * without one); `builtIns` is the set this definition belongs to, which its delete cascade reads when it runs.
 */
export function defineContacts(ext: ExtensionFields | undefined, builtIns: () => BuiltInLookup) {
  const contactsBase = withColumnFilters(
    withColumnSorts(
      extendDefinition(
        definePreparedResource({
          surface: 'api',
          name: 'contacts',
          eventName: 'contact',
          table: 'contacts',
          associable: true,
          customFilters: { tag_id: tagIdFilter('contacts'), tag: tagNameFilter('contacts'), ...contactActivityFilters },
          derived: contactDerived,
          record,
          create,
          update,
          filters: filterOptions(contactsDeclaration),
          references: { company_id: { table: 'companies', live: true } },
          override: { delete: (env, id) => deleteContactOperation(env, id as string, builtIns()) },
        }),
        ext,
      ),
      contactsDeclaration.sorts,
    ),
  )
  /** [[CORE549]] D10: the list takes the bag filter, `additional_props=<key>.<condition>`. */
  return withPropertyBag(withAggregate(contactsBase))
}

export const contacts = defineContacts(undefined, defaultBuiltIns)
