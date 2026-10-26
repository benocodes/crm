import { createVaultRegistry } from './operations.js'
import { Registry } from './registry.js'
import { companies } from './resources/companies.js'
import { contacts } from './resources/contacts.js'
import { identities } from './resources/identities.js'
import { tasks } from './resources/tasks.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { d1Backend } from './test/d1-backend.js'

// The whole current surface, on Postgres (the behaviour oracle).
runContractSuite({ registry: createVaultRegistry(), fixtures })

// The prepared resources through the same prepared executor on a local D1 binding per tenant: the SAME assertions
// ([[CORE35]] D16, [[CORE36]] rule 9).
runContractSuite({
  registry: new Registry().registerResource(tasks).registerResource(companies).registerResource(contacts).registerResource(identities),
  fixtures: { tasks: fixtures.tasks!, companies: fixtures.companies!, contacts: fixtures.contacts!, identities: fixtures.identities! },
  backend: d1Backend(),
})
