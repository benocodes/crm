import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// API7 cycle 1 (D12, D13, Configuration): the Worker's composition is the only place CREDENTIALS_KEY and WEBHOOK_ALLOW_INSECURE_URLS reach the webhook operations, and
// they must do so with no Google variable set. The operations' own behaviour is proven in @vault/api with the configuration injected.
let w: WorkerD1
let key: string
const BASE = 'https://w.test'
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const SCOPES = ['webhooks:read', 'webhooks:write', 'tasks:read']
const worker = (extra: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '', ...extra }, { clock: () => NOW, newId: () => uuidv7(NOW) })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown) => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const create = (wk: ReturnType<typeof worker>, url = 'https://example.com/hook') => call(wk, 'POST', '/meta/v1/webhooks', { url, event_types: ['task.created'] })
const count = async (table: string) => ((await w.d1.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n

beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  key = (await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES }, { now: NOW, newId: () => uuidv7(NOW) })).key
})

describe('CREDENTIALS_KEY reaches the webhook operations on its own', () => {
  it('no key: create is 501 webhooks_not_configured and writes nothing; reads still work', async () => {
    const wk = worker()
    const r = await create(wk)
    expect([r.status, r.body.error.code]).toEqual([501, 'webhooks_not_configured'])
    expect([await count('webhook_subscriptions'), await count('webhook_secrets')]).toEqual([0, 0])
    expect((await call(wk, 'GET', '/meta/v1/webhooks')).body).toEqual({ data: [], next_cursor: null })
  })

  it('the key alone (no Google variable, no version) configures it: create answers 201 with a secret and the sealed row is stored with version 1', async () => {
    const wk = worker({ CREDENTIALS_KEY: KEY })
    const r = await create(wk)
    expect([r.status, r.body.secret?.slice(0, 6), r.body.status]).toEqual([201, 'whsec_', 'active'])
    const row = (await w.d1.prepare('select sealed, key_version from webhook_secrets').first()) as { sealed: string; key_version: number }
    expect(row.sealed).not.toContain(r.body.secret)
    expect(row.key_version).toBe(1)
    expect((await call(wk, 'POST', `/meta/v1/webhooks/${r.body.id}/rotate-secret`)).status).toBe(200)
  })

  it('CREDENTIALS_KEY_VERSION is the stored key_version', async () => {
    await create(worker({ CREDENTIALS_KEY: KEY, CREDENTIALS_KEY_VERSION: '4' }))
    expect(((await w.d1.prepare('select key_version from webhook_secrets').first()) as { key_version: number }).key_version).toBe(4)
  })

  it('a malformed key is 501 and the log names the variable, never its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bad = 'definitely not a 32 byte base64 key'
    const r = await create(worker({ CREDENTIALS_KEY: bad }))
    expect([r.status, r.body.error.code]).toEqual([501, 'webhooks_not_configured'])
    expect(await count('webhook_secrets')).toBe(0)
    const logged = warn.mock.calls.flat().join('\n')
    expect(logged).toContain('CREDENTIALS_KEY')
    expect(logged).not.toContain(bad)
    warn.mockRestore()
  })
})

describe('WEBHOOK_ALLOW_INSECURE_URLS reaches the operations', () => {
  it('without it http://localhost is 400 invalid_url; with it, 201; a private literal is still refused', async () => {
    const strict = worker({ CREDENTIALS_KEY: KEY })
    const refused = await create(strict, 'http://localhost:9999/hook')
    expect([refused.status, refused.body.error.code]).toEqual([400, 'invalid_url'])
    const loose = worker({ CREDENTIALS_KEY: KEY, WEBHOOK_ALLOW_INSECURE_URLS: 'true' })
    expect((await create(loose, 'http://localhost:9999/hook')).status).toBe(201)
    expect((await create(loose, 'http://10.0.0.1/hook')).body.error.code).toBe('invalid_url')
  })
})
