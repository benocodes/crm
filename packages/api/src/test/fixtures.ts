import { randomUUID } from 'node:crypto'
import type { ContractFixture, FixtureKit } from './contract.js'
import { seedConversation } from './messaging-kit.js'

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
  // Messaging ([[CORE25]] C1): read-only resources, made by direct inserts until cycle 2's recordMessages (P9).
  threads: { make: async (kit) => ({ id: (await conversation(kit)).threadId }) },
  messages: { make: async (kit) => ({ id: (await conversation(kit)).messageId }) },
  interactions: {
    make: async (kit) => {
      const contact = await kit.post('/contacts', { name: 'Participant' })
      const identity = await kit.post('/identities', { kind: 'email', value: `p-${randomUUID()}@example.com`, contact_id: contact.id })
      return { id: (await conversation(kit, { participants: [{ identityId: identity.id, role: 'from' }] })).interactionId! }
    },
  },
  files: { make: async (kit) => ({ id: (await conversation(kit, { attachments: 1 })).fileIds[0]! }) },
  contact_files: {
    input: async (kit) => ({ contact_id: (await kit.post('/contacts', { name: 'Linked' })).id, file_id: (await conversation(kit, { attachments: 1 })).fileIds[0]! }),
  },
  company_files: {
    input: async (kit) => ({ company_id: (await kit.post('/companies', { name: 'Linked co', domain: `l-${randomUUID()}.example.com` })).id, file_id: (await conversation(kit, { attachments: 1 })).fileIds[0]! }),
  },
}

const conversation = (kit: FixtureKit, opts: Parameters<typeof seedConversation>[1] = {}) =>
  seedConversation((table, row) => kit.insert(table, row), { externalId: `c-${randomUUID()}@acme.test`, ...opts })
