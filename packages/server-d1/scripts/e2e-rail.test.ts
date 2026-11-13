import { describe, expect, it } from 'vitest'
import { railKeyOf } from './e2e-rail.js'
import { RemoteRefusal } from './remote.js'

describe('railKeyOf ([[OPS265]] D15)', () => {
  it('prefers VIBASE_SMOKED1_RAIL_KEY, else VIBASE_SMOKED1_OPERATOR_KEY', () => {
    expect(railKeyOf({ VIBASE_SMOKED1_RAIL_KEY: 'r', VIBASE_SMOKED1_OPERATOR_KEY: 'o' })).toBe('r')
    expect(railKeyOf({ VIBASE_SMOKED1_OPERATOR_KEY: 'o' })).toBe('o')
  })
  it('refuses when only the old VAULT_ names are set, and the refusal names the new variables', () => {
    const old = { VAULT_SMOKED1_RAIL_KEY: 'r', VAULT_SMOKED1_OPERATOR_KEY: 'o' }
    expect(() => railKeyOf(old)).toThrow(RemoteRefusal)
    expect(() => railKeyOf(old)).toThrow('VIBASE_SMOKED1_RAIL_KEY or VIBASE_SMOKED1_OPERATOR_KEY must be set')
  })
})
