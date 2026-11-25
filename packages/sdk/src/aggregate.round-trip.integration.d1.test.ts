import { type ApiKeyKit, openApiKeyKit } from '@vibase/api/test/api-key'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type BuiltInOperations, type Client, createClient } from './index.js'

// DX616 P6: the typed aggregate against the real app on D1 with a real API key; the typed answer's values are what the REST operation returns for the same query.
let k: ApiKeyKit
let key: string
let vibase: Client<BuiltInOperations>
beforeAll(async () => {
  k = await openApiKeyKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  const agentId = await k.seedAgent()
  await k.e
    .d1!.prepare('update agents set scopes = ? where id = ?')
    .bind(JSON.stringify(['deals:read', 'deals:write', 'pipelines:read', 'pipelines:write']), agentId)
    .run()
  key = (await k.ctlKey({ agent_id: agentId })).key
  vibase = createClient({
    url: 'https://api.acme.example',
    auth: key,
    fetch: ((url: string, init: RequestInit) => k.app.request(url, init)) as typeof fetch,
  })
})
const rest = async (query: string) => {
  const res = await k.app.request(`https://api.acme.example/api/v1/deals/aggregate?${query}`, {
    headers: { authorization: `Bearer ${key}` },
  })
  expect(res.status).toBe(200)
  return res.json()
}
async function seed() {
  const pipeline = await vibase.pipelines.create({ name: 'Sales' })
  const stage = await vibase.pipelineStages.create({
    pipeline_id: pipeline.id,
    name: 'Open',
    kind: 'open',
    position: 10,
  })
  for (const [name, amount, currency] of [
    ['Acme', 600000, 'USD'],
    ['Beta', 400001, 'USD'],
    ['Gamma', 700000, 'EUR'],
  ] as const)
    await vibase.deals.create({ stage_id: stage.id, name, amount_minor: amount, currency })
  await vibase.deals.create({ stage_id: stage.id, name: 'Delta' })
  return stage
}

describe('DX616 round trip on D1', () => {
  it('an ungrouped call with arrays returns the REST answer, typed', async () => {
    await seed()
    const total = await vibase.deals.aggregate({ currency: 'USD', sum: 'amount_minor', min: ['name', 'amount_minor'] })
    expect(total).toEqual(await rest('currency=eq.USD&sum=amount_minor&min=name,amount_minor'))
    expect(total.count).toBe(2)
    expect(total.sum.amount_minor).toBe(1000001)
    expect(total.min).toEqual({ name: 'Acme', amount_minor: 400001 })
    expect(total.currency.amount_minor).toBe('USD')
  })

  it('a grouped call returns typed groups equal to the REST answer, with the null group last', async () => {
    const stage = await seed()
    const answer = await vibase.deals.aggregate({ group_by: ['stage_id', 'currency'], sum: 'amount_minor' })
    expect(answer).toEqual(await rest('group_by=stage_id,currency&sum=amount_minor'))
    expect(answer.count).toBe(4)
    expect(answer.groups.map((g) => [g.key.stage_id, g.key.currency, g.count, g.sum.amount_minor])).toEqual([
      [stage.id, 'EUR', 1, 700000],
      [stage.id, 'USD', 2, 1000001],
      [stage.id, null, 1, null],
    ])
    expect(answer.groups[0].currency.amount_minor).toBe('EUR')
  })

  it('a field the server refuses (cast past the types) comes back as the server 400', async () => {
    const error = await (vibase.deals.aggregate as any)({ sum: 'name' }).catch((e: unknown) => e)
    expect([error.status, error.code]).toEqual([400, 'validation_error'])
  })
})
