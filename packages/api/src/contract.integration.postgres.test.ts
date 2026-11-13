import { createVibaseRegistry } from './operations.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'
import { postgresBackend } from './test/postgres-backend.js'

// The whole current surface, on Postgres (the behaviour oracle for the parked adapter). The D1 run is contract.integration.d1.test.ts.
runContractSuite({ registry: createVibaseRegistry(), fixtures, backend: postgresBackend() })
