import { describe, expect, it } from 'vitest'
import { parseWebhooksConfig } from './config.js'

// API7 cycle 1 (D12, D13, Configuration): the webhook configuration is read from CREDENTIALS_KEY and CREDENTIALS_KEY_VERSION alone (no Google variable), and from
// WEBHOOK_ALLOW_INSECURE_URLS. A problem is a NAME, never a value.
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')

describe('parseWebhooksConfig', () => {
  it('the key alone configures it: no Google variable is needed; the version defaults to 1', () => {
    const { runtime, problems } = parseWebhooksConfig({ CREDENTIALS_KEY: KEY })
    expect(problems).toEqual([])
    expect(runtime.key?.version).toBe(1)
    expect([...runtime.key!.bytes]).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
    expect(runtime.allowInsecureUrls).toBe(false)
  })
  it('no key: unconfigured and no problem (webhooks are simply off); an empty key counts as absent', () => {
    for (const env of [{}, { CREDENTIALS_KEY: '' }, { CREDENTIALS_KEY: '   ' }]) expect(parseWebhooksConfig(env)).toEqual({ runtime: { key: null, allowInsecureUrls: false }, problems: [] })
  })
  it('a malformed key (not base64, or not 32 bytes) is unconfigured with CREDENTIALS_KEY named, and its value is not', () => {
    for (const bad of ['not base64!!', 'AAAA', Buffer.from(new Uint8Array(31)).toString('base64'), Buffer.from(new Uint8Array(33)).toString('base64')]) {
      const { runtime, problems } = parseWebhooksConfig({ CREDENTIALS_KEY: bad })
      expect(runtime.key, bad).toBeNull()
      expect(problems, bad).toEqual(['CREDENTIALS_KEY'])
      expect(JSON.stringify(problems)).not.toContain(bad)
    }
  })
  it('CREDENTIALS_KEY_VERSION: a positive integer is used; anything else names the variable and leaves webhooks off', () => {
    expect(parseWebhooksConfig({ CREDENTIALS_KEY: KEY, CREDENTIALS_KEY_VERSION: '7' }).runtime.key?.version).toBe(7)
    for (const bad of ['0', '-1', '1.5', 'x', '']) {
      const r = parseWebhooksConfig({ CREDENTIALS_KEY: KEY, CREDENTIALS_KEY_VERSION: bad })
      expect(r.problems, bad).toEqual(['CREDENTIALS_KEY_VERSION'])
      expect(r.runtime.key, bad).toBeNull()
    }
  })
  it('WEBHOOK_ALLOW_INSECURE_URLS is on only for exactly "true"', () => {
    expect(parseWebhooksConfig({ WEBHOOK_ALLOW_INSECURE_URLS: 'true' }).runtime.allowInsecureUrls).toBe(true)
    for (const v of ['false', '1', 'yes', 'TRUE', '']) expect(parseWebhooksConfig({ WEBHOOK_ALLOW_INSECURE_URLS: v }).runtime.allowInsecureUrls, v).toBe(false)
  })
})
