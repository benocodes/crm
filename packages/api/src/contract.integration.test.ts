import { createVaultRegistry } from './operations.js'
import { Registry } from './registry.js'
import { tasks } from './resources/tasks.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { d1Backend } from './test/d1-backend.js'

// The whole current surface, on Postgres (the behaviour oracle).
runContractSuite({ registry: createVaultRegistry(), fixtures })

// `tasks` through the same prepared executor on a local D1 binding per tenant: the SAME assertions ([[CORE35]] D16).
runContractSuite({ registry: new Registry().registerResource(tasks), fixtures: { tasks: fixtures.tasks! }, backend: d1Backend() })
