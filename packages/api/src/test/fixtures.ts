import { randomUUID } from 'node:crypto'
import type { ContractFixture, FixtureKit } from './contract.js'

export const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  notes: { input: async () => ({ title: 'Contract note', content: '# Contract\n\nA note.' }), patch: async () => ({ content: 'Edited' }) },
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
  // Messaging ([[CORE25]] C1): read-only resources, made by the capture unit ([[CORE68]] P15), the only writer they have.
  threads: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.thread_id }) },
  messages: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.message_id }) },
  interactions: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.interaction_id }) },
  files: { make: async (kit) => ({ id: await storedFileId(kit) }) },
  contact_files: {
    input: async (kit) => ({ contact_id: (await kit.post('/contacts', { name: 'Linked' })).id, file_id: await storedFileId(kit) }),
  },
  company_files: {
    input: async (kit) => ({ company_id: (await kit.post('/companies', { name: 'Linked co', domain: `l-${randomUUID()}.example.com` })).id, file_id: await storedFileId(kit) }),
  },
}

/** Captures a message with one stored attachment and returns the id of its file (read back through the public message). */
async function storedFileId(kit: FixtureKit): Promise<string> {
  const { message_id } = (await kit.capture({ attachments: 1 })).captured[0]!
  return (await kit.get(`/messages/${message_id}`)).attachments[0].file_id as string
}
