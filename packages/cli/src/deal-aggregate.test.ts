// [[CORE202]] D13: `vibase deals aggregate` comes to the CLI from the registry's OpenAPI like every other command; no CLI code is involved.
import { afterEach, expect, it } from 'vitest'
import { createVibaseRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })

it('deals aggregate --sum amount_minor --currency eq.USD calls GET /api/v1/deals/aggregate with the parameters as written', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const answer = { count: 2, sum: { amount_minor: 1000001 }, currency: { amount_minor: 'USD' } }
  const instance = fakeInstance({ api, routes: req => (new URL(req.url).pathname === '/api/v1/deals/aggregate' ? json(answer) : undefined) })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(['deals', 'aggregate', '--sum', 'amount_minor', '--currency', 'eq.USD', '--tag', 'consultancy'])
  expect(result.code, result.stderr).toBe(0)
  const sent = r.seen.filter(x => new URL(x.url).pathname === '/api/v1/deals/aggregate')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.method).toBe('GET')
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toEqual({ sum: 'amount_minor', currency: 'eq.USD', tag: 'consultancy' })
  expect(JSON.parse(result.stdout)).toEqual(answer)
})

it('there is no contacts aggregate command', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({ api, routes: () => undefined })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(['contacts', 'aggregate'])
  expect(result.code).not.toBe(0)
})
