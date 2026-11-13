import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createVibaseRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })
const CURSOR = Buffer.from(JSON.stringify(['occurred_at', 'desc', '2026-10-01T00:00:00.000Z', '0190b2c4-0000-7000-8000-000000000001'])).toString('base64url')
async function session() {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({ api, routes: req => {
    const u = new URL(req.url)
    if (u.pathname === '/api/v1/messages') return json(u.searchParams.has('after') ? { data: [{ id: 'older' }], next_cursor: null } : { data: [{ id: 'newer' }], next_cursor: CURSOR })
  } })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  return r
}

it('mail flags send occurred_at desc and limit 5; --all preserves parameters through opaque cursors', async () => {
  const r = await session()
  const one = await r.run(['messages', 'list', '--sort', 'occurred_at', '--order', 'desc', '--limit', '5'])
  expect(one.code, one.stderr).toBe(0)
  expect(JSON.parse(one.stdout).next_cursor).toBe(CURSOR)
  const before = r.seen.length
  const all = await r.run(['messages', 'list', '--sort', 'occurred_at', '--order', 'desc', '--limit', '5', '--all'])
  expect(all.code, all.stderr).toBe(0)
  expect(all.stdout.trim().split('\n').map(line => JSON.parse(line).id)).toEqual(['newer', 'older'])
  const sent = r.seen.filter(x => new URL(x.url).pathname === '/api/v1/messages')
  expect(sent).toHaveLength(3)
  for (const req of sent) expect(Object.fromEntries(new URL(req.url).searchParams)).toMatchObject({ sort: 'occurred_at', order: 'desc', limit: '5' })
  const pages = r.seen.slice(before).filter(x => new URL(x.url).pathname === '/api/v1/messages')
  expect(pages.map(x => new URL(x.url).searchParams.get('after'))).toEqual([null, CURSOR])
})

it('old mail cache refreshes exactly once for sort flags and never sends an unsorted request', async () => {
  const r = await session()
  expect((await r.run(['messages', 'list'])).code).toBe(0)
  const file = join(r.cacheDir, readdirSync(r.cacheDir).find(f => f.startsWith('discovery-'))!)
  const cache = JSON.parse(readFileSync(file, 'utf8'))
  const list = cache.ops.find((o: any) => o.id === 'messages.list')
  list.parameters = list.parameters.filter((p: any) => !['sort', 'order'].includes(p.name))
  list.parameters.find((p: any) => p.name === 'after').schema = { type: 'string', format: 'uuid' }
  writeFileSync(file, JSON.stringify(cache))
  const before = r.seen.length
  const result = await r.run(['messages', 'list', '--sort', 'occurred_at', '--order', 'desc', '--limit', '5'])
  expect(result.code, result.stderr).toBe(0)
  const sent = r.seen.slice(before)
  expect(sent.filter(x => new URL(x.url).pathname === '/.well-known/vibase')).toHaveLength(1)
  expect(sent.filter(x => new URL(x.url).pathname === '/api/v1/openapi.json')).toHaveLength(1)
  const lists = sent.filter(x => new URL(x.url).pathname === '/api/v1/messages')
  expect(lists).toHaveLength(1)
  expect(Object.fromEntries(new URL(lists[0]!.url).searchParams)).toMatchObject({ sort: 'occurred_at', order: 'desc', limit: '5' })
})
