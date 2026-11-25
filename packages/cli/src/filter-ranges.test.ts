// [[CORE605]] D6: a query flag whose parameter accepts a list of strings (a column filter) repeats; nothing else does.
import { afterEach, expect, it } from 'vitest'
import { createVibaseRegistry } from '../../api/src/operations.js'
import { createApp } from '../../api/src/rest/app.js'
import { coldStorage } from '../../api/src/test/storage.js'
import { fakeInstance, json, KEY, rig, SERVER } from './test/harness.js'

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

async function run(argv: string[]) {
  const app = createApp({ storage: coldStorage(), registry: createVibaseRegistry() })
  const api = await (await app.request('/api/v1/openapi.json')).json()
  const instance = fakeInstance({
    api,
    routes: (req) =>
      new URL(req.url).pathname.startsWith('/api/v1/') && !req.url.endsWith('openapi.json')
        ? json({ data: [], next_cursor: null })
        : undefined,
  })
  const r = rig({ fetch: instance.fetch, env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
  rigs.push(r)
  const result = await r.run(argv)
  const sent = r.seen.filter((x) => /^\/api\/v1\/(deals|contacts)$/.test(new URL(x.url).pathname))
  return { result, sent: sent.map((x) => [...new URL(x.url).searchParams.entries()]) }
}

it('a repeated column filter flag is sent as repeated parameters, in the order given', async () => {
  const { result, sent } = await run([
    'deals',
    'list',
    '--expected-close-date',
    'gte.2026-11-01',
    '--expected-close-date',
    'lt.2026-12-01',
  ])
  expect(result.code, result.stderr).toBe(0)
  expect(sent).toEqual([
    [
      ['expected_close_date', 'gte.2026-11-01'],
      ['expected_close_date', 'lt.2026-12-01'],
    ],
  ])
})

it('one occurrence sends one parameter; a text and an integer filter repeat too', async () => {
  const one = await run(['deals', 'list', '--amount-minor', 'gt.5'])
  expect(one.sent).toEqual([[['amount_minor', 'gt.5']]])
  const two = await run(['deals', 'list', '--amount-minor', 'gt.5', '--amount-minor', 'lt.9', '--name', 'ilike.*a*'])
  expect(two.sent[0]!.filter(([k]) => k === 'amount_minor')).toEqual([
    ['amount_minor', 'gt.5'],
    ['amount_minor', 'lt.9'],
  ])
  expect(two.sent[0]!.filter(([k]) => k === 'name')).toEqual([['name', 'ilike.*a*']])
})

it('a non-repeatable flag given twice sends one parameter, the last value (P2)', async () => {
  const tag = await run(['deals', 'list', '--tag', 'a', '--tag', 'b'])
  expect(tag.result.code, tag.result.stderr).toBe(0)
  expect(tag.sent).toEqual([[['tag', 'b']]])
  const limit = await run(['deals', 'list', '--limit', '5', '--limit', '7'])
  expect(limit.sent).toEqual([[['limit', '7']]])
})

it('a fifth occurrence is sent: the CLI does not enforce the cap (P1)', async () => {
  const { sent } = await run([
    'deals',
    'list',
    ...['1', '2', '3', '4', '5'].flatMap((n) => ['--amount-minor', `gt.${n}`]),
  ])
  expect(sent[0]).toHaveLength(5)
})

it('--help marks repeatable flags and only those', async () => {
  const { result } = await run(['deals', 'list', '--help'])
  const line = (flag: string) => result.stdout.split('\n').find((l) => l.trimStart().startsWith(`--${flag} `)) ?? ''
  expect(line('expected-close-date')).toMatch(/may repeat/)
  expect(line('amount-minor')).toMatch(/may repeat/)
  expect(line('tag')).not.toMatch(/repeat/)
  expect(line('limit')).not.toMatch(/repeat/)
})
