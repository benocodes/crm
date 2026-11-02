import { describe, it } from 'vitest'
import { Registry } from '../registry.js'
import { runContractSuite } from './contract.js'

// OPS92 D5: `runContractSuite` has no default backend. These calls are never executed; typecheck is the test.
describe('runContractSuite types (OPS92 D5)', () => {
  it('requires an explicit backend', () => {
    const never = (): void => {
      // @ts-expect-error `backend` is required: there is no Postgres default
      runContractSuite({ registry: new Registry(), fixtures: {} })
    }
    void never
  })
})
