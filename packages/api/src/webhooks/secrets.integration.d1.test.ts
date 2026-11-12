import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openToken } from '../connections/credentials.js'
import { KEY_BYTES, NOW, URL_OK, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'

// API7 cycle 1 (D12): the signing secret is shown by create and rotate_secret only, stored sealed, appended on rotation, and never reaches a read, an event or the schema.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit({ version: 3 })
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const TASKS = ['tasks:read']
const secrets = () => k.all('select * from webhook_secrets order by created_at, id')

describe('what is shown (D12)', () => {
  it('create answers whsec_ + base64 of 32 random bytes; two creates differ', async () => {
    const a = await k.seedAgent(TASKS)
    const one = await k.create(a)
    const two = await k.create(a)
    for (const s of [one.secret, two.secret]) {
      expect(s).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
      expect(Buffer.from(s.slice('whsec_'.length), 'base64')).toHaveLength(32)
    }
    expect(one.secret).not.toBe(two.secret)
  })

  it('get and list never carry a secret; the record is exactly the read schema', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const got = await k.owner('GET', `${BASE}/${made.id}`)
    const listed = await k.owner('GET', BASE)
    for (const r of [got, listed]) {
      expect(r.text).not.toContain(made.secret)
      expect(r.text).not.toContain('whsec_')
      expect(r.text).not.toContain('sealed')
    }
    expect(Object.keys(got.body).sort()).toEqual(['agent_id', 'created_at', 'created_by', 'event_types', 'id', 'organization_id', 'status', 'updated_at', 'url'])
    expect(Object.keys(made).sort()).toEqual([...Object.keys(got.body), 'secret'].sort())
  })

  it('no event carries it or the sealed text, in before or after', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const rotated = (await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)).body.secret
    await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })
    await k.owner('DELETE', `${BASE}/${made.id}`)
    const events = await k.all("select type, \"before\", \"after\" from events where type like 'webhook.%'")
    expect(events.map((e) => e.type).sort()).toEqual(['webhook.created', 'webhook.deleted', 'webhook.secret_rotated', 'webhook.updated'])
    const text = JSON.stringify(events)
    for (const s of [made.secret, rotated, ...(await secrets()).map((r) => r.sealed as string)]) expect(text).not.toContain(s)
    expect(text).not.toContain('whsec_')
  })

  it('schema.get lists webhook_subscriptions and neither machinery table, and carries no secret', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const r = await k.owner('GET', '/meta/v1/schema')
    expect(r.status, r.text).toBe(200)
    const names = r.body.tables.map((t: any) => t.name)
    expect(names).toContain('webhook_subscriptions')
    expect(names).not.toContain('webhook_secrets')
    expect(names).not.toContain('webhook_dispatch_state')
    expect(r.text).not.toContain(made.secret)
    expect(r.text).not.toContain('sealed')
  })
})

describe('what is stored (D12)', () => {
  it('one row, sealed: it opens with the key to the secret, is not equal to it, and carries the version from the variable', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const stored = await secrets()
    expect(stored).toHaveLength(1)
    const row = stored[0]!
    expect(row.sealed).not.toBe(made.secret)
    expect(String(row.sealed)).not.toContain(made.secret)
    expect(await openToken(KEY_BYTES, String(row.sealed))).toBe(made.secret)
    expect(row.key_version).toBe(3)
    expect([row.subscription_id, row.organization_id, row.created_by]).toEqual([made.id, k.e.organizationId, k.e.userId])
  })

  it('each sealing has its own IV: the same plaintext twice would not seal alike, and the key version follows the variable', async () => {
    const a = await k.seedAgent(TASKS)
    await k.create(a)
    await k.create(a)
    const [x, y] = await secrets()
    expect(x!.sealed).not.toBe(y!.sealed)
    const other = await openWebhookKit({ version: 9 })
    try {
      const made = await other.create(await other.seedAgent(TASKS))
      expect(made.secret).toMatch(/^whsec_/)
      expect((await other.all('select key_version from webhook_secrets'))[0]!.key_version).toBe(9)
    } finally {
      await other.close()
    }
  })
})

describe('rotation (D12)', () => {
  it('appends a second row and answers { secret, previous_valid_until } 24 hours after the injected clock; the new secret opens to the answer', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const r = await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    expect(r.status, r.text).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['previous_valid_until', 'secret'])
    expect(r.body.previous_valid_until).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString())
    expect(r.body.secret).toMatch(/^whsec_/)
    expect(r.body.secret).not.toBe(made.secret)
    const stored = await secrets()
    expect(stored).toHaveLength(2)
    expect(await openToken(KEY_BYTES, String(stored[0]!.sealed))).toBe(made.secret)
    expect(await openToken(KEY_BYTES, String(stored[1]!.sealed))).toBe(r.body.secret)
    await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    expect(await secrets()).toHaveLength(3)
  })

  it('does not touch the subscription row (updated_at stays)', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await k.all('select * from webhook_subscriptions')
    await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    expect(await k.all('select * from webhook_subscriptions')).toEqual(before)
  })

  it('an UPDATE of webhook_secrets aborts (append-only); inserts of later rows are untouched', async () => {
    await k.create(await k.seedAgent(TASKS))
    const err = await k.e.d1!.prepare("UPDATE webhook_secrets SET sealed = 'x'").run().then(() => null, (e: Error) => e.message)
    expect(err).toContain('append_only')
    const err2 = await k.e.d1!.prepare('UPDATE webhook_secrets SET key_version = 99').run().then(() => null, (e: Error) => e.message)
    expect(err2).toContain('append_only')
    expect((await secrets())[0]!.key_version).toBe(3)
  })
})

describe('configuration (D12)', () => {
  it('without the key, create and rotate_secret answer 501 webhooks_not_configured and write nothing, ahead of validation', async () => {
    const bare = await openWebhookKit({ key: null })
    try {
      const a = await bare.seedAgent(TASKS)
      const made = await bare.owner('POST', BASE, { url: URL_OK, agent_id: a, event_types: ['task.created'] })
      expect([made.status, made.body.error.code]).toEqual([501, 'webhooks_not_configured'])
      expect(made.text).not.toMatch(/[A-Za-z0-9+/]{40,}/)
      // the configuration is checked first: a body that would otherwise be refused is still 501
      const invalid = await bare.owner('POST', BASE, { url: 'http://example.com', agent_id: a })
      expect([invalid.status, invalid.body.error.code]).toEqual([501, 'webhooks_not_configured'])
      // a subscription that exists (inserted raw) cannot be rotated
      const id = '0190b2c4-0000-7000-8000-0000000000bb'
      const at = '2026-11-12T09:00:00.000Z'
      await bare.e.d1!.prepare("INSERT INTO webhook_subscriptions (id, created_at, updated_at, organization_id, created_by, agent_id, url, event_types, status) VALUES (?, ?, ?, ?, ?, ?, ?, '[\"task.created\"]', 'active')").bind(id, at, at, bare.e.organizationId, bare.e.userId, a, URL_OK).run()
      const rotated = await bare.owner('POST', `${BASE}/${id}/rotate-secret`)
      expect([rotated.status, rotated.body.error.code]).toEqual([501, 'webhooks_not_configured'])
      for (const table of ['webhook_secrets', 'webhook_dispatch_state']) expect(await bare.all(`select * from ${table}`), table).toEqual([])
      expect(await bare.all('select id from webhook_subscriptions')).toHaveLength(1)
      expect(await bare.all("select id from events where type like 'webhook.%'")).toEqual([])
      // reads, update and delete need no key
      expect((await bare.owner('GET', `${BASE}/${id}`)).status).toBe(200)
      expect((await bare.owner('PATCH', `${BASE}/${id}`, { status: 'paused' })).status).toBe(200)
      expect((await bare.owner('DELETE', `${BASE}/${id}`)).status).toBe(204)
    } finally {
      await bare.close()
    }
  })

  it('the operations are registered whatever the configuration (the tool lists do not change per deployment)', async () => {
    const bare = await openWebhookKit({ key: null })
    try {
      expect(bare.registry.operations().filter((o) => o.name.startsWith('webhooks.')).map((o) => o.name).sort()).toEqual(['webhooks.create', 'webhooks.delete', 'webhooks.get', 'webhooks.list', 'webhooks.rotate_secret', 'webhooks.update'])
      expect(k.registry.declaredScopes()).toEqual(bare.registry.declaredScopes())
    } finally {
      await bare.close()
    }
  })
})
