// [[CORE549]] D11: `vibase contacts property-keys` comes to the CLI from the registry's OpenAPI like every other command; no CLI code is involved. The list's `--additional-props` flag likewise.
import { afterEach, expect, it } from 'vitest'
import { createVibaseRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

it('contacts property-keys calls GET /api/v1/contacts/property-keys; contacts list --additional-props sends the parameter as written', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const answer = { data: [{ key: 'city', records: 2, types: ['string'] }], truncated: false }
  const instance = fakeInstance({
    api,
    routes: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/api/v1/contacts/property-keys') return json(answer)
      if (path === '/api/v1/contacts') return json({ data: [], next_cursor: null })
      return undefined
    },
  })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const keys = await r.run(['contacts', 'property-keys'])
  expect(keys.code, keys.stderr).toBe(0)
  expect(JSON.parse(keys.stdout)).toEqual(answer)
  const list = await r.run(['contacts', 'list', '--additional-props', 'city.eq.Paris'])
  expect(list.code, list.stderr).toBe(0)
  const sent = r.seen.filter((x) => new URL(x.url).pathname === '/api/v1/contacts')
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toMatchObject({ additional_props: 'city.eq.Paris' })
})
