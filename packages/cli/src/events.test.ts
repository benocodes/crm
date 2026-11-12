// [[API214]]: `vibase events list` and `vibase events get` come to the CLI from the registry's OpenAPI like every other command; no CLI code is involved.
import { afterEach, expect, it } from 'vitest'
import { createVaultRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })
const ID = '0190b2c4-0000-7000-8000-0000000000e1'

async function run(args: string[], answer: unknown) {
  const app = createApp({ storage: coldStorage(), registry: createVaultRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({ api, routes: req => (new URL(req.url).pathname.startsWith('/api/v1/events') ? json(answer) : undefined) })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(args)
  return { result, sent: r.seen.filter(x => new URL(x.url).pathname.startsWith('/api/v1/events')) }
}

it('events list --type task.updated --limit 5 calls GET /api/v1/events with the parameters as written', async () => {
  const answer = { data: [], next_cursor: null }
  const { result, sent } = await run(['events', 'list', '--type', 'task.updated', '--limit', '5', '--resource-type', 'task'], answer)
  expect(result.code, result.stderr).toBe(0)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.method).toBe('GET')
  expect(new URL(sent[0]!.url).pathname).toBe('/api/v1/events')
  expect(Object.fromEntries(new URL(sent[0]!.url).searchParams)).toEqual({ type: 'task.updated', limit: '5', resource_type: 'task' })
  expect(JSON.parse(result.stdout)).toEqual(answer)
})

it('events get <id> calls GET /api/v1/events/<id>', async () => {
  const { result, sent } = await run(['events', 'get', ID], { id: ID })
  expect(result.code, result.stderr).toBe(0)
  expect(new URL(sent[0]!.url).pathname).toBe(`/api/v1/events/${ID}`)
})
