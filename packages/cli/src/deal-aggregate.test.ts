// [[CORE202]] D13: `vibase deals aggregate` comes to the CLI from the registry's OpenAPI like every other command; no CLI code is involved.
import { afterEach, expect, it } from 'vitest'
import { createVibaseRegistry } from '../../api/src/operations.js'
import { defineCustomObject } from '../../api/src/custom/resource.js'
import { PROJECTS, PROJECTS_KEY } from '../../api/src/test/custom-objects.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

it('deals aggregate --sum amount_minor --currency eq.USD calls GET /api/v1/deals/aggregate with the parameters as written', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const answer = { count: 2, sum: { amount_minor: 1000001 }, currency: { amount_minor: 'USD' } }
  const instance = fakeInstance({
    api,
    routes: (req) => (new URL(req.url).pathname === '/api/v1/deals/aggregate' ? json(answer) : undefined),
  })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run([
    'deals',
    'aggregate',
    '--sum',
    'amount_minor',
    '--currency',
    'eq.USD',
    '--tag',
    'consultancy',
  ])
  expect(result.code, result.stderr).toBe(0)
  const sent = r.seen.filter((x) => new URL(x.url).pathname === '/api/v1/deals/aggregate')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.method).toBe('GET')
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toEqual({
    sum: 'amount_minor',
    currency: 'eq.USD',
    tag: 'consultancy',
  })
  expect(JSON.parse(result.stdout)).toEqual(answer)
})

it('contacts aggregate --min created_at calls GET /api/v1/contacts/aggregate; there is no --sum (CORE615 D1, D5)', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const answer = { count: 3 }
  const instance = fakeInstance({
    api,
    routes: (req) => (new URL(req.url).pathname === '/api/v1/contacts/aggregate' ? json(answer) : undefined),
  })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(['contacts', 'aggregate', '--min', 'created_at'])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(answer)
  const op = (api.paths['/api/v1/contacts/aggregate'].get.parameters as Array<{ name: string }>).map((p) => p.name)
  expect(op).toContain('min')
  expect(op).not.toContain('sum')
  expect((await r.run(['contacts', 'aggregate', '--sum', 'x'])).code).not.toBe(0)
})

it('companies, tasks and a custom object each have an aggregate command (CORE615 D1)', async () => {
  const registry = createVibaseRegistry({
    definitions: [defineCustomObject(PROJECTS_KEY, PROJECTS)],
  })
  const app = createApp({ storage: coldStorage(), registry })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  for (const list of ['companies', 'tasks', PROJECTS_KEY]) {
    const instance = fakeInstance({
      api,
      routes: (req) => (new URL(req.url).pathname === `/api/v1/${list}/aggregate` ? json({ count: 7 }) : undefined),
    })
    const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
    rigs.push(r)
    const result = await r.run([list, 'aggregate'])
    expect(result.code, `${list} ${result.stderr}`).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ count: 7 })
  }
})

it('there is no notes aggregate command', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({ api, routes: () => undefined })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(['notes', 'aggregate'])
  expect(result.code).not.toBe(0)
})
