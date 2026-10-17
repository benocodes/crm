import { z } from 'zod'
import { deleteResource } from './crud.js'
import { defineResource } from './define.js'
import { identities } from './identities.js'

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

export const contacts = defineResource<ContactRecord>({
  name: 'contacts',
  eventName: 'contact',
  table: 'contacts',
  record,
  create,
  update,
  filters: { company_id: { schema: z.uuid() } },
  references: { company_id: { table: 'companies', live: true } },
  overrides: {
    async delete(ctx, id, generic) {
      await generic(id)
      const rows = await ctx.trx
        .selectFrom('identities')
        .select('id')
        .where('contact_id', '=', id)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .execute()
      for (const row of rows) await deleteResource(ctx, identities, row.id)
    },
  },
})
