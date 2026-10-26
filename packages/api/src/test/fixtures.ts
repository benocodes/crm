import { randomUUID } from 'node:crypto'
import type { ContractFixture } from './contract.js'

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
    make: async (kit) => ({ id: (await kit.seedMember('member')).membershipId }),
    actors: ['user'],
  },
  agents: {
    input: async () => ({ name: `agent-${randomUUID().slice(0, 8)}`, scopes: ['tasks:read'] }),
    patch: async () => ({ name: 'Renamed agent' }),
    actors: ['user'],
  },
  api_keys: {
    async make(kit) {
      const agent = await kit.post('/agents', { name: 'k' })
      return kit.post('/api-keys', { agent_id: agent.id })
    },
    handwritten: ['create'],
    actors: ['user'],
  },
}
