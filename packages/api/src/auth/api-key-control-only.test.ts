import { describe, expect, it } from 'vitest'
import type { StorageBinding } from '@vibase/storage'
import { generateApiKey } from './api-keys.js'
import { createApiKeyAuthenticator, type ApiKeyControlPort } from './api-key-control.js'

// [[CORE329]] P2 ([[CORE259]] D17): API-key authentication reads the control plane only. A storage binding that throws on any touch stands for "no CRM key read": a control miss is `null`, with no port every key is `null`.
const NOW = new Date('2026-11-16T10:00:00.000Z')
const env = { now: NOW, newId: () => '0190b2c4-0000-7000-8000-000000000001' }
const touched: string[] = []
const storage = new Proxy(
  {},
  {
    get(_t, prop) {
      touched.push(String(prop))
      throw new Error(`storage read (${String(prop)}): the authenticator must not read CRM keys`)
    },
  },
) as unknown as StorageBinding
const newKey = () => generateApiKey((k) => crypto.getRandomValues(new Uint8Array(k)))

describe('key authentication is control only (CORE329 P2)', () => {
  it('a hash control does not hold is null, cold and with a vanished cached state, and no storage is touched', async () => {
    touched.length = 0
    const calls: string[] = []
    const port: ApiKeyControlPort = {
      async findByHash() {
        calls.push('find')
        return null
      },
      async readState() {
        calls.push('state')
        return null
      },
      async stampUsed() {
        return false
      },
    }
    const { key } = await newKey()
    const auth = createApiKeyAuthenticator({ port })
    expect(await auth(storage, key, env)).toBeNull()
    expect(await auth(storage, key, env)).toBeNull()
    expect(calls).toEqual(['find', 'find'])
    expect(touched).toEqual([])
  })

  it('with no port every key is null and storage is not read', async () => {
    touched.length = 0
    const { key } = await newKey()
    expect(await createApiKeyAuthenticator({ port: null })(storage, key, env)).toBeNull()
    expect(touched).toEqual([])
  })
})
