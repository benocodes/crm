import { applySchemaFile, defineCustomObject, parseSchemaFile } from '@vibase/api'
import { type ApiKeyKit, openApiKeyKit } from '@vibase/api/test/api-key'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { workspaceOperations } from './fixtures/workspace/operations.js'
import { builtInOperations } from '../generated/operations.js'
import { createClient } from '../index.js'

// DX604 D6: a client built from the generated workspace map, against the real app on D1 with the same definitions and `extend`.
const file = parseSchemaFile(readFileSync(new URL('./fixtures/workspace.schema.json', import.meta.url), 'utf8'))
const definitions = Object.entries(file.objects).map(([key, declaration]) => defineCustomObject(key, declaration))

let k: ApiKeyKit
let key: string
beforeAll(async () => {
  k = await openApiKeyKit({ definitions, ...(file.extend ? { extend: file.extend } : {}) })
  const applied = await applySchemaFile(k.e.d1!, file.objects, file.extend)
  expect(applied.refused).toEqual([])
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  const agentId = await k.seedAgent()
  await k.e
    .d1!.prepare('update agents set scopes = ? where id = ?')
    .bind(JSON.stringify([
        'projects__c:read',
        'projects__c:write',
        'session_recordings__c:read',
        'session_recordings__c:write',
        'contacts:read',
        'contacts:write',
      ]), agentId)
    .run()
  key = (await k.ctlKey({ agent_id: agentId })).key
})
const fetchOf = ((url: string, init: RequestInit) => k.app.request(url, init)) as typeof fetch

describe('DX604 round trip on D1', () => {
  it('creates and lists a custom record, and updates a contact __c field, reading the values back', async () => {
    const vibase = createClient({
      url: 'https://api.acme.example',
      auth: key,
      fetch: fetchOf,
      operations: workspaceOperations,
    })
    const small = await vibase.projects__c.create({ name: 'Small', budget: 1000 })
    await vibase.projects__c.create({ name: 'Big', budget: 9000, stage: 'active' })
    expect(small.stage).toBe('planned')
    const page = await vibase.projects__c.list({ budget: { gte: 5000 } })
    expect(page.data.map((p) => p.name)).toEqual(['Big'])
    expect((await vibase.projects__c.get({ id: small.id })).budget).toBe(1000)

    const contact = await vibase.contacts.create({ name: 'Ada' })
    const updated = await vibase.contacts.update({ id: contact.id, tier__c: 'gold' })
    expect(updated.tier__c).toBe('gold')
    expect((await vibase.contacts.get({ id: contact.id })).tier__c).toBe('gold')
    expect((await vibase.contacts.list({ tier__c: 'gold' })).data.map((c) => c.id)).toEqual([contact.id])
    expect((await vibase.contacts.list({ tier__c: 'bronze' })).data).toEqual([])
  })

  it('CORE692: a multi-word custom object is sessionRecordings__c on the client and calls /api/v1/session-recordings__c', async () => {
    const urls: string[] = []
    const vibase = createClient({
      url: 'https://api.acme.example',
      auth: key,
      fetch: ((url: string, init: RequestInit) => {
        urls.push(new URL(url).pathname)
        return k.app.request(url, init)
      }) as typeof fetch,
      operations: workspaceOperations,
    })
    const made = await vibase.sessionRecordings__c.create({ title: 'Kick-off', length_seconds: 60 })
    expect((await vibase.sessionRecordings__c.get({ id: made.id })).title).toBe('Kick-off')
    expect((await vibase.sessionRecordings__c.list({ length_seconds: { gte: 30 } })).data.map((r) => r.title)).toEqual([
      'Kick-off',
    ])
    expect(urls).toEqual([
      '/api/v1/session-recordings__c',
      `/api/v1/session-recordings__c/${made.id}`,
      '/api/v1/session-recordings__c',
    ])
    const contact = await vibase.contacts.create({ name: 'Ada' })
    await vibase.contacts.update({ id: contact.id, referral_source__c: 'web' })
    expect((await vibase.contacts.list({ referral_source__c: 'web' })).data.map((c) => c.id)).toEqual([contact.id])
  })

  it('DX616: a typed aggregate on the custom object, ungrouped and grouped, equals the REST answer', async () => {
    const vibase = createClient({
      url: 'https://api.acme.example',
      auth: key,
      fetch: fetchOf,
      operations: workspaceOperations,
    })
    await vibase.projects__c.create({ name: 'Small', budget: 1000 })
    await vibase.projects__c.create({ name: 'Big', budget: 9000, stage: 'active' })
    await vibase.projects__c.create({ name: 'Huge', budget: 11000, stage: 'active' })
    const rest = async (query: string) =>
      (
        await k.app.request(`https://api.acme.example/api/v1/projects__c/aggregate?${query}`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json()
    const total = await vibase.projects__c.aggregate({ sum: 'budget', max: ['name', 'budget'] })
    expect(total).toEqual(await rest('sum=budget&max=name,budget'))
    expect([total.count, total.sum.budget, total.max.budget]).toEqual([3, 21000, 11000])
    const grouped = await vibase.projects__c.aggregate({ group_by: 'stage', sum: 'budget' })
    expect(grouped).toEqual(await rest('group_by=stage&sum=budget'))
    expect(grouped.groups.map((g) => [g.key.stage, g.count, g.sum.budget])).toEqual([
      ['active', 2, 20000],
      ['planned', 1, 1000],
    ])
  })

  it('absence mutation: a client built from the built-in table has no custom namespace', async () => {
    const vibase = createClient({
      url: 'https://api.acme.example',
      auth: key,
      fetch: fetchOf,
      operations: builtInOperations,
    }) as any
    expect(vibase.projects__c).toBeUndefined()
  })
})
