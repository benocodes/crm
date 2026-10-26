import { randomUUID } from 'node:crypto'
import type { ContractFixture } from './contract.js'
import { createResource } from '../resources/crud.js'
import { seedUser } from '@vault/db/test'
import { createApiKey } from '../auth/api-keys.js'
import { agents } from '../resources/agents.js'

export const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  companies: {
    input: async () => ({ name: 'Contract company', domain: `c-${randomUUID()}.example.com` }),
    patch: async () => ({ name: 'Renamed company' }),
  },
  contacts: { input: async () => ({ name: 'Contract contact' }), patch: async () => ({ name: 'Renamed' }) },
  identities: {
    input: async (kit) => {
      const c = await kit.post('/contacts', { name: 'Owner' })
      return { kind: 'email', value: `c-${randomUUID()}@example.com`, contact_id: c.id }
    },
    patch: async (kit) => ({ contact_id: (await kit.post('/contacts', {})).id }),
  },
  // Administration ([[CORE3]]): human-only scopes, so the suite runs these as a user.
  memberships: {
    async make(ctx, seed) {
      const user = await seedUser(seed.db, { organizationId: seed.tenant.organizationId, role: 'member' })
      return ctx.trx.selectFrom('memberships').select('id').where('user_id', '=', user.id).executeTakeFirstOrThrow()
    },
    actors: ['user'],
  },
  agents: {
    input: async () => ({ name: `agent-${randomUUID().slice(0, 8)}`, scopes: ['tasks:read'] }),
    patch: async () => ({ name: 'Renamed agent' }),
    actors: ['user'],
  },
  api_keys: {
    async make(ctx) {
      const agent = await createResource(ctx, agents, { name: 'k' })
      return createApiKey(ctx.trx, { organizationId: ctx.organizationId, agentId: agent.id, createdBy: ctx.actor.id })
    },
    handwritten: ['create'],
    actors: ['user'],
  },
}
