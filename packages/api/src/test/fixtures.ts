import { randomUUID } from 'node:crypto'
import type { ContractFixture, FixtureKit } from './contract.js'

export const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  notes: { input: async () => ({ title: 'Contract note', content: '# Contract\n\nA note.' }), patch: async () => ({ content: 'Edited' }) },
  tags: { input: async () => ({ name: `Contract tag ${randomUUID()}`, description: 'A contract list' }), patch: async () => ({ description: 'Edited' }) },
  // Deals and pipelines (CORE130): a stage needs a pipeline and a deal needs a stage, created through the public API as prerequisites.
  pipelines: { input: async () => ({ name: `Contract pipeline ${randomUUID()}` }), patch: async () => ({ name: `Renamed pipeline ${randomUUID()}` }) },
  pipeline_stages: {
    input: async (kit) => ({ pipeline_id: (await kit.post('/meta/v1/pipelines', { name: `P ${randomUUID()}` })).id, name: 'Researched', kind: 'open', position: 10 }),
    patch: async () => ({ name: `Renamed stage ${randomUUID()}`, position: 20 }),
  },
  deals: {
    input: async (kit) => ({ name: 'Contract deal', stage_id: await stageId(kit) }),
    patch: async () => ({ name: 'Renamed deal', amount_minor: 1500, currency: 'usd' }),
  },
  companies: {
    input: async () => ({ name: 'Contract company', domain: `c-${randomUUID()}.example.com` }),
    patch: async () => ({ name: 'Renamed company' }),
  },
  contacts: { input: async () => ({ name: 'Contract contact' }), patch: async () => ({ name: 'Renamed' }) },
  identities: {
    input: async (kit) => {
      const c = await kit.post('/api/v1/contacts', { name: 'Owner' })
      return { kind: 'email', value: `c-${randomUUID()}@example.com`, contact_id: c.id }
    },
    patch: async (kit) => ({ contact_id: (await kit.post('/api/v1/contacts', {})).id }),
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
      const agent = await kit.post('/meta/v1/agents', { name: 'k' })
      return kit.post('/meta/v1/api-keys', { agent_id: agent.id })
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
    input: async (kit) => ({ contact_id: (await kit.post('/api/v1/contacts', { name: 'Linked' })).id, file_id: await storedFileId(kit) }),
  },
  company_files: {
    input: async (kit) => ({ company_id: (await kit.post('/api/v1/companies', { name: 'Linked co', domain: `l-${randomUUID()}.example.com` })).id, file_id: await storedFileId(kit) }),
  },
}

/** A fresh pipeline with one open stage, through the public API; returns the stage id. */
async function stageId(kit: FixtureKit): Promise<string> {
  const p = await kit.post('/meta/v1/pipelines', { name: `P ${randomUUID()}` })
  return (await kit.post('/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Researched', kind: 'open', position: 10 })).id
}

/** Captures a message with one stored attachment and returns the id of its file (read back through the public message). */
async function storedFileId(kit: FixtureKit): Promise<string> {
  const { message_id } = (await kit.capture({ attachments: 1 })).captured[0]!
  return (await kit.get(`/api/v1/messages/${message_id}`)).attachments[0].file_id as string
}
