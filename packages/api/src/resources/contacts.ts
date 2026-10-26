import { z } from 'zod'
import { deleteContactOperation } from '../identity/cascades.js'
import { definePreparedResource } from '../storage/definition.js'

export type ContactRecord = {
  id: string
  organization_id: string
  name: string | null
  company_id: string | null
  merged_into_id: string | null
  created_by: string
  created_at: string
  updated_at: string
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
})

const fields = {
  name: z.string().trim().min(1).max(500).nullable().optional(),
  company_id: z.uuid().nullable().optional(),
}
const create = z.strictObject(fields)
const update = create.partial()

/** Contacts on the prepared path ([[CORE36]]): the company must be a live company of this organisation; delete tombstones the identities as a set. */
export const contacts = definePreparedResource({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  record,
  create,
  update,
  filters: { company_id: { schema: z.uuid() } },
  references: { company_id: { table: 'companies', live: true } },
  override: { delete: (env, id) => deleteContactOperation(env, id as string) },
})
