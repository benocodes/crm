import { z } from 'zod'
import { deleteContactOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'
import { contactActivityFilters, contactDerived } from './contact-activity.js'
import { tagIdFilter } from './tag-filter.js'

export type ContactRecord = {
  id: string
  organization_id: string
  name: string | null
  company_id: string | null
  merged_into_id: string | null
  created_by: string
  created_at: string
  updated_at: string
  /** Derived ([[CORE131]]): present only for a caller holding `interactions:read`. */
  last_contacted_at?: string | null
  last_interacted_at?: string | null
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string().nullable(),
  company_id: z.uuid().nullable(),
  merged_into_id: z.uuid().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  last_contacted_at: z
    .string()
    .nullable()
    .optional()
    .describe("When the latest outbound interaction with any of the contact's identities happened; null if none. Derived, read-only; present only with interactions:read."),
  last_interacted_at: z
    .string()
    .nullable()
    .optional()
    .describe("When the latest interaction, in either direction, with any of the contact's identities happened; null if none. Derived, read-only; present only with interactions:read."),
})

const fields = {
  name: z.string().trim().min(1).max(500).nullable().optional(),
  company_id: z.uuid().nullable().optional(),
}
const create = z.strictObject(fields)
const update = create.partial()

/** Contacts on the prepared path ([[CORE36]]): the company must be a live company of this organisation; delete tombstones the identities as a set. */
export const contacts = definePreparedResource({
  surface: 'api',
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  associable: true,
  joinFilters: { tag_id: tagIdFilter('contacts'), ...contactActivityFilters },
  derived: contactDerived,
  record,
  create,
  update,
  filters: { company_id: { schema: z.uuid() } },
  references: { company_id: { table: 'companies', live: true } },
  override: { delete: (env, id) => deleteContactOperation(env, id as string) },
})
