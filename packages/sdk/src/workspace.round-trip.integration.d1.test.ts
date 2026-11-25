import { applySchemaFile, defineCustomObject, parseSchemaFile } from '@vibase/api'
import { type ApiKeyKit, openApiKeyKit } from '@vibase/api/test/api-key'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { workspaceOperations } from './generate/fixtures/workspace/operations.js'
import { builtInOperations } from './generated/operations.js'
import { createClient } from './index.js'

// DX604 D6: a client built from the generated workspace map, against the real app on D1 with the same definitions and `extend`.
const file = parseSchemaFile(readFileSync(new URL('./generate/fixtures/workspace.schema.json', import.meta.url), 'utf8'))
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
    .bind(JSON.stringify(['projects__c:read', 'projects__c:write', 'contacts:read', 'contacts:write']), agentId)
    .run()
  key = (await k.ctlKey({ agent_id: agentId })).key
})
const fetchOf = ((url: string, init: RequestInit) => k.app.request(url, init)) as typeof fetch

describe('DX604 round trip on D1', () => {
  it('creates and lists a custom record, and updates a contact __c field, reading the values back', async () => {
    const vibase = createClient({ url: 'https://api.acme.example', auth: key, fetch: fetchOf, operations: workspaceOperations })
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

  it('absence mutation: a client built from the built-in table has no custom namespace', async () => {
    const vibase = createClient({ url: 'https://api.acme.example', auth: key, fetch: fetchOf, operations: builtInOperations }) as any
    expect(vibase.projects__c).toBeUndefined()
  })
})
