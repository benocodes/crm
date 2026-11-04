import { adminOperations } from './admin/operations.js'
import { Registry } from './registry.js'
import { agents } from './resources/agents.js'
import { apiKeys } from './resources/api-keys.js'
import { companies } from './resources/companies.js'
import { companyFiles } from './resources/company-files.js'
import { contactFiles } from './resources/contact-files.js'
import { files } from './resources/files.js'
import { interactions } from './resources/interactions.js'
import { messages } from './resources/messages.js'
import { threads } from './resources/threads.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { memberships } from './resources/memberships.js'
import { notes } from './resources/notes.js'
import { tasks } from './resources/tasks.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { d1Backend } from './test/d1-backend.js'

// The prepared resources through the same prepared path on a local D1 binding per tenant: the SAME assertions as the Postgres run
// in contract.integration.postgres.test.ts ([[CORE35]] D16, [[CORE36]] rule 9).
// The six messaging resources join in CORE72 (CORE69 D17), seeded by `kit.capture`.
// Administration joins the D1 run in CORE40 (P10); api_keys' hand-written create must be routable for its fixture.
runContractSuite({
  registry: adminOperations().reduce(
    (r, op) => r.register(op),
    new Registry()
      .registerResource(tasks)
      .registerResource(notes)
      .registerResource(companies)
      .registerResource(contacts)
      .registerResource(identities)
      .registerResource(memberships)
      .registerResource(agents)
      .registerResource(apiKeys)
      .registerResource(threads)
      .registerResource(messages)
      .registerResource(interactions)
      .registerResource(files)
      .registerResource(contactFiles)
      .registerResource(companyFiles),
  ),
  fixtures: {
    tasks: fixtures.tasks!,
    notes: fixtures.notes!,
    companies: fixtures.companies!,
    contacts: fixtures.contacts!,
    identities: fixtures.identities!,
    memberships: fixtures.memberships!,
    agents: fixtures.agents!,
    api_keys: fixtures.api_keys!,
    threads: fixtures.threads!,
    messages: fixtures.messages!,
    interactions: fixtures.interactions!,
    files: fixtures.files!,
    contact_files: fixtures.contact_files!,
    company_files: fixtures.company_files!,
  },
  backend: d1Backend(),
})
