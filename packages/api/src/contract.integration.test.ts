import { adminOperations } from './admin/operations.js'
import { createVaultRegistry } from './operations.js'
import { Registry } from './registry.js'
import { agents } from './resources/agents.js'
import { apiKeys } from './resources/api-keys.js'
import { companies } from './resources/companies.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { memberships } from './resources/memberships.js'
import { tasks } from './resources/tasks.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { d1Backend } from './test/d1-backend.js'

// The whole current surface, on Postgres (the behaviour oracle).
runContractSuite({ registry: createVaultRegistry(), fixtures })

// The prepared resources through the same prepared executor on a local D1 binding per tenant: the SAME assertions
// ([[CORE35]] D16, [[CORE36]] rule 9).
// Administration joins the D1 run in CORE40 (P10); api_keys' hand-written create must be routable for its fixture.
runContractSuite({
  registry: adminOperations().reduce(
    (r, op) => r.register(op),
    new Registry()
      .registerResource(tasks)
      .registerResource(companies)
      .registerResource(contacts)
      .registerResource(identities)
      .registerResource(memberships)
      .registerResource(agents)
      .registerResource(apiKeys),
  ),
  fixtures: {
    tasks: fixtures.tasks!,
    companies: fixtures.companies!,
    contacts: fixtures.contacts!,
    identities: fixtures.identities!,
    memberships: fixtures.memberships!,
    agents: fixtures.agents!,
    api_keys: fixtures.api_keys!,
  },
  backend: d1Backend(),
})
