import type { D1Like } from '@vibase/storage-d1'
import { adminOperations } from './admin/operations.js'
import { Registry } from './registry.js'
import { agents } from './resources/agents.js'
import { companies } from './resources/companies.js'
import { blockedSenders } from './resources/blocked-senders.js'
import { forms } from './resources/forms.js'
import { connections } from './resources/connections.js'
import { companyFiles } from './resources/company-files.js'
import { contactFiles } from './resources/contact-files.js'
import { files } from './resources/files.js'
import { interactions } from './resources/interactions.js'
import { messages } from './resources/messages.js'
import { threads } from './resources/threads.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { memberships } from './resources/memberships.js'
import { deals } from './resources/deals.js'
import { notes } from './resources/notes.js'
import { pipelineStages } from './resources/pipeline-stages.js'
import { pipelines } from './resources/pipelines.js'
import { tags } from './resources/tags.js'
import { tasks } from './resources/tasks.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { d1Backend } from './test/d1-backend.js'
import { PROJECTS, PROJECTS_KEY, projectsDefinition } from './test/custom-objects.js'
import { applySchemaFile } from './custom/apply.js'
import type { ExtendDeclarations } from './custom/extend.js'
import { createVibaseRegistry } from './operations.js'
import { describe, expect, it } from 'vitest'

// [[CORE555]] P7: the SAME contract suite as contract.integration.d1.test.ts on databases where every extension-field shape is applied to all four built-in tables (and a custom object they reference):
// their CRUD, events and errors answer exactly as with no extension, and `schema.get` lists the columns `exposed: false`. Dormant: nothing serves the fields until CORE559.
const SHAPES: NonNullable<ExtendDeclarations['contacts']> = {
  note__c: { kind: 'text' },
  tier__c: { kind: 'enum', values: ['a', 'b'], required: true },
  status__c: { kind: 'enum', values: ['new', 'won'], required: true, default: 'new' },
  ref_code__c: { kind: 'text', unique: true },
  company_ref__c: { kind: 'reference', target: 'companies' },
  proj__c: { kind: 'reference', target: PROJECTS_KEY },
}
const applyShapes = async (d1: D1Like) => {
  const r = await applySchemaFile(
    d1,
    { [PROJECTS_KEY]: PROJECTS },
    { contacts: SHAPES, companies: SHAPES, deals: SHAPES, tasks: SHAPES },
  )
  if (r.refused.length > 0) throw new Error(JSON.stringify(r.refused))
}

// The prepared resources through the same prepared path on a local D1 binding per tenant: the SAME assertions as the Postgres run
// in contract.integration.postgres.test.ts ([[CORE35]] D16, [[CORE36]] rule 9).
// The six messaging resources join in CORE72 (CORE69 D17), seeded by `kit.capture`.
// Administration joins the D1 run in CORE40 (P10). api_keys left it with the move of its operations to the control plane ([[CORE351]]): its suite is `admin/api-keys-control.integration.d1.test.ts`.
runContractSuite({
  registry: adminOperations().reduce(
    (r, op) => r.register(op),
    new Registry()
      .registerResource(tasks)
      .registerResource(notes)
      .registerResource(tags)
      .registerResource(connections)
      .registerResource(blockedSenders)
      .registerResource(forms)
      .registerResource(pipelines)
      .registerResource(pipelineStages)
      .registerResource(deals)
      .registerResource(companies)
      .registerResource(contacts)
      .registerResource(identities)
      .registerResource(memberships)
      .registerResource(agents)
      .registerResource(threads)
      .registerResource(messages)
      .registerResource(interactions)
      .registerResource(files)
      .registerResource(contactFiles)
      .registerResource(companyFiles)
      .registerResource(projectsDefinition()),
  ),
  fixtures: {
    tasks: fixtures.tasks!,
    notes: fixtures.notes!,
    tags: fixtures.tags!,
    connections: fixtures.connections!,
    blocked_senders: fixtures.blocked_senders!,
    forms: fixtures.forms!,
    pipelines: fixtures.pipelines!,
    pipeline_stages: fixtures.pipeline_stages!,
    deals: fixtures.deals!,
    companies: fixtures.companies!,
    contacts: fixtures.contacts!,
    identities: fixtures.identities!,
    memberships: fixtures.memberships!,
    agents: fixtures.agents!,
    threads: fixtures.threads!,
    messages: fixtures.messages!,
    interactions: fixtures.interactions!,
    files: fixtures.files!,
    contact_files: fixtures.contact_files!,
    company_files: fixtures.company_files!,
    // [[CORE315]]: a test-declared custom object, served by the generic layer; D1 only (its table is created per tenant by `setup`, nothing applies it in production yet).
    [PROJECTS_KEY]: { input: async () => ({ name: 'Contract project' }), patch: async () => ({ stage: 'active' }) },
  },
  backend: d1Backend({ setup: (d1) => applyShapes(d1) }),
})

describe('extension columns are dormant (P7)', () => {
  it('identities.resolve creates a contact and schema.get lists each extension column as not exposed', async () => {
    const registry = createVibaseRegistry()
    const s = await d1Backend({ setup: (d1) => applyShapes(d1) }).open(registry)
    try {
      const { a } = await s.reset()
      const res = await s.call(a, 'user', registry.declaredScopes(), 'POST', '/api/v1/identities/resolve', {
        identities: [{ kind: 'email', value: 'new@dormant.test', name: 'New' }],
      })
      expect(res.status).toBe(200)
      const out = (await res.json()) as { data: { created: boolean; contact: Record<string, unknown> }[] }
      expect(out.data[0]!.created).toBe(true)
      expect(Object.keys(out.data[0]!.contact).filter((k) => k.endsWith('__c'))).toEqual([])
      const doc = (await (await s.call(a, 'user', registry.declaredScopes(), 'GET', '/meta/v1/schema')).json()) as any
      for (const t of ['contacts', 'companies', 'deals', 'tasks']) {
        const cols = doc.tables.find((x: any) => x.name === t).columns.filter((c: any) => c.name.endsWith('__c'))
        expect(cols.map((c: any) => c.name).sort(), t).toEqual(Object.keys(SHAPES).sort())
        expect(
          cols.every((c: any) => c.exposed === false),
          t,
        ).toBe(true)
      }
    } finally {
      await s.close()
    }
  })
})
