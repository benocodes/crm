import { FULL_ACCESS_SCOPE } from '@vibase/auth'
import * as api from '@vibase/api'
import { describe, expect, it } from 'vitest'
import * as page from './cli-login.js'

describe('the wildcard name the device page mirrors', () => {
  it('equals the provider package and the verifier (CORE630 D1)', () => {
    expect(page.FULL_ACCESS_SCOPE).toBe(FULL_ACCESS_SCOPE)
    expect(api.FULL_ACCESS_SCOPE).toBe(FULL_ACCESS_SCOPE)
  })
})
