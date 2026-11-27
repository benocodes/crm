import { randomUUID } from 'node:crypto'
import type { ContractFixture, FixtureKit } from './contract.js'

export const fixtures: Record<string, ContractFixture> = {
  tasks: { input: async () => ({ title: 'Contract task' }), patch: async () => ({ title: 'Renamed' }) },
  notes: {
    input: async () => ({ title: 'Contract note', content: '# Contract\n\nA note.' }),
    patch: async () => ({ content: 'Edited' }),
  },
  tags: {
    input: async () => ({ name: `Contract tag ${randomUUID()}`, description: 'A contract list' }),
    patch: async () => ({ description: 'Edited' }),
  },
  // Connections (CHN140): read plus delete; a connection exists only through the OAuth callback, so the fixture seeds one the way a connect leaves it
  // (an own identity, the connection, its four machinery rows). `delete` is human-only (connections:write is not agent-grantable).
  connections: {
    async make(kit) {
      const own = await kit.insert('identities', {
        kind: 'email',
        value: `own-${randomUUID()}@contract.test`,
        contact_id: null,
        own: true,
      })
      const c = await kit.insert('connections', {
        provider: 'google',
        account_id: `sub-${randomUUID()}`,
        identity_id: own.id,
        owner_id: kit.tenant.userId,
        status: 'active',
        granted_scopes: ['openid', 'email'],
        connected_at: '2026-11-05T09:00:00.000Z',
      })
      await kit.insert('connection_credentials', {
        connection_id: c.id,
        refresh_token_ciphertext: 'c2VhbGVk',
        key_version: 1,
      })
      await kit.insert('connection_sync_state', { connection_id: c.id })
      await kit.insert('connection_sync_cursors', { connection_id: c.id, cursor: '1' })
      return { id: c.id as string }
    },
    actors: ['user'],
  },
  // The workspace blocklist (CHN410): create and delete are owner-only and human-only (`blocked_senders:write` is not agent-grantable); there is no update.
  blocked_senders: {
    input: async () => ({ kind: 'domain', value: `contract-${randomUUID()}.example` }),
    actors: ['user'],
  },
  // Forms (CHN420): writes are owner-only and human-only (`forms:write` is not agent-grantable); each create also creates the form's agent principal.
  forms: {
    input: async (kit) => ({
      name: `Contract form ${randomUUID()}`,
      allowed_origins: ['https://contract.example'],
      tag_ids: [(await kit.post('/api/v1/tags', { name: `Form tag ${randomUUID()}` })).id],
    }),
    patch: async () => ({
      name: 'Renamed form',
      enabled: false,
      allowed_origins: ['https://renamed.example'],
      tag_ids: [],
    }),
    createAlsoEmits: ['agent.created'],
    // the patch renames the form, which renames its agent; a delete disables it ([[CHN423]] D4, D13)
    updateAlsoEmits: ['agent.updated'],
    deleteAlsoEmits: ['agent.updated'],
    actors: ['user'],
  },
  // Deals and pipelines (CORE130): a stage needs a pipeline and a deal needs a stage, created through the public API as prerequisites.
  pipelines: {
    input: async () => ({ name: `Contract pipeline ${randomUUID()}` }),
    patch: async () => ({ name: `Renamed pipeline ${randomUUID()}` }),
  },
  pipeline_stages: {
    input: async (kit) => ({
      pipeline_id: (await kit.post('/meta/v1/pipelines', { name: `P ${randomUUID()}` })).id,
      name: 'Researched',
      kind: 'open',
      position: 10,
    }),
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
    // [[CORE288]]: update and delete exist (owner-held `members:write`); a role change is the only patch.
    patch: async () => ({ role: 'owner' }),
    actors: ['user'],
  },
  agents: {
    input: async () => ({ name: `agent-${randomUUID().slice(0, 8)}`, scopes: ['tasks:read'] }),
    patch: async () => ({ name: 'Renamed agent' }),
    actors: ['user'],
  },
  // Messaging ([[CORE25]] C1): read-only resources, made by the capture unit ([[CORE68]] P15), the only writer they have.
  threads: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.thread_id }) },
  messages: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.message_id }) },
  interactions: { make: async (kit) => ({ id: (await kit.capture()).captured[0]!.interaction_id }) },
  files: { make: async (kit) => ({ id: await storedFileId(kit) }) },
  contact_files: {
    input: async (kit) => ({
      contact_id: (await kit.post('/api/v1/contacts', { name: 'Linked' })).id,
      file_id: await storedFileId(kit),
    }),
  },
  company_files: {
    input: async (kit) => ({
      company_id: (await kit.post('/api/v1/companies', { name: 'Linked co', domain: `l-${randomUUID()}.example.com` }))
        .id,
      file_id: await storedFileId(kit),
    }),
  },
}

/** A fresh pipeline with one open stage, through the public API; returns the stage id. */
async function stageId(kit: FixtureKit): Promise<string> {
  const p = await kit.post('/meta/v1/pipelines', { name: `P ${randomUUID()}` })
  return (
    await kit.post('/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Researched', kind: 'open', position: 10 })
  ).id
}

/** Captures a message with one stored attachment and returns the id of its file (read back through the public message). */
async function storedFileId(kit: FixtureKit): Promise<string> {
  const { message_id } = (await kit.capture({ attachments: 1 })).captured[0]!
  return (await kit.get(`/api/v1/messages/${message_id}`)).attachments[0].file_id as string
}
