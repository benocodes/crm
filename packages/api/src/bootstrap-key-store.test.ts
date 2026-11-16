import { describe, expect, it } from 'vitest'
import type { StorageBinding } from '@vibase/storage'
import { bootstrap } from './bootstrap.js'

// [[CORE329]] P3 ([[CORE259]] D17): `bootstrap` mints its key on the control plane on EVERY engine; without a key store it refuses before the CRM unit runs. The binding stub throws on any touch, so a run that got
// past the refusal into the unit would fail differently (and would have written to the CRM).
const touched: string[] = []
const storageOf = (kind: 'd1' | 'postgres') =>
  new Proxy(
    { kind, organizationId: '0190b2c4-0000-7000-8000-00000000a001', authProvider: 'none', authOrgId: 'x' },
    {
      get(t, prop) {
        if (prop in t) return t[prop as keyof typeof t]
        touched.push(String(prop))
        throw new Error(`storage touched (${String(prop)})`)
      },
    },
  ) as unknown as StorageBinding

describe('bootstrap needs a key store on every engine (CORE329 P3)', () => {
  it.each(['d1', 'postgres'] as const)(
    '%s: no keyStore refuses naming the control store, before the CRM unit',
    async (kind) => {
      touched.length = 0
      await expect(
        bootstrap(storageOf(kind), { organizationName: 'Acme', email: 'a@example.com', agentName: 'op' }),
      ).rejects.toThrow(/control/)
      expect(touched).toEqual([])
    },
  )
})
