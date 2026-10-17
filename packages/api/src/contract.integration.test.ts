import { createVaultRegistry } from './operations.js'
import { fixtures } from './test/fixtures.js'
import { runContractSuite } from './test/contract.js'

runContractSuite({ registry: createVaultRegistry(), fixtures })
