import { randomUUID } from 'node:crypto'
import type { ContractFixture } from './contract.js'
import { createResource } from '../resources/crud.js'
import { contacts } from '../resources/contacts.js'

export const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  companies: {
    input: async () => ({ name: 'Contract company', domain: `c-${randomUUID()}.example.com` }),
    patch: async () => ({ name: 'Renamed company' }),
  },
  contacts: { input: async () => ({ name: 'Contract contact' }), patch: async () => ({ name: 'Renamed' }) },
  identities: {
    input: async (ctx) => {
      const c = await createResource(ctx, contacts, { name: 'Owner' })
      return { kind: 'email', value: `c-${randomUUID()}@example.com`, contact_id: c.id }
    },
    patch: async (ctx) => ({ contact_id: (await createResource(ctx, contacts, {})).id }),
  },
}
