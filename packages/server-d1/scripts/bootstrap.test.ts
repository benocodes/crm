import { describe, expect, it } from 'vitest'
import { proxyOptions } from './bootstrap.js'

describe('the bootstrap CLI never reaches a remote (spec D7)', () => {
  it('opens the local persisted state and never a remote binding', () => {
    const o = proxyOptions('/x/wrangler.jsonc')
    expect(o.remoteBindings).toBe(false)
    expect(o.persist).toBe(true)
    expect(o.configPath).toBe('/x/wrangler.jsonc')
  })
})
