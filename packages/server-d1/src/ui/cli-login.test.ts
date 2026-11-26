import { CLI_CLIENT_ID, LIMITED_LOGIN_SCOPE } from '@vibase/auth'
import * as api from '@vibase/api'
import { describe, expect, it } from 'vitest'
import * as page from './cli-login.js'

describe('the names the device page mirrors', () => {
  it('equal the provider package and the verifier (CORE630 D2)', () => {
    expect(page.CLI_CLIENT_ID).toBe(CLI_CLIENT_ID)
    expect(page.LIMITED_LOGIN_SCOPE).toBe(LIMITED_LOGIN_SCOPE)
    expect(api.LIMITED_LOGIN_SCOPE).toBe(LIMITED_LOGIN_SCOPE)
  })
})
