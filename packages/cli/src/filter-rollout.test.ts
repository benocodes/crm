// [[CORE201]] D10: the filter parameters of a list other than deals come to the CLI from the registry's OpenAPI like every other flag.
import { afterEach, expect, it } from 'vitest'
import { createVaultRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })

it('tasks list --due-at lt.2026-12-01 --tag consultancy --title ilike.*quote* sends the parameters as written', async () => {
  const app = createApp({ storage: coldStorage(), registry: createVaultRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({ api, routes: req => (new URL(req.url).pathname === '/api/v1/tasks' ? json({ data: [], next_cursor: null }) : undefined) })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(['tasks', 'list', '--due-at', 'lt.2026-12-01', '--tag', 'consultancy', '--title', 'ilike.*quote*'])
  expect(result.code, result.stderr).toBe(0)
  const sent = r.seen.filter(x => new URL(x.url).pathname === '/api/v1/tasks')
  expect(sent).toHaveLength(1)
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toEqual({ due_at: 'lt.2026-12-01', tag: 'consultancy', title: 'ilike.*quote*' })
})
