// [[CORE605]] D6: a range through the CLI against the real D1 app, in process.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { bootstrapD1, composeD1Worker, openWorkerD1, type WorkerD1 } from '@vibase/server-d1/test'
import { rig, SERVER } from './test/harness.js'

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())

let key: string
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
beforeEach(async () => {
  await w.reset()
  const b = await bootstrapD1(w.d1, {
    organizationName: 'Acme',
    authProvider: 'none',
    authOrgId: 'e2e',
    email: 'e2e@example.com',
    agentName: 'e2e-agent',
    scopes: ['contacts:read', 'contacts:write', 'schema:read', 'deals:read', 'deals:write', 'pipelines:read', 'pipelines:write'],
  })
  key = b.key
})
const session = async () => {
  const worker = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' })
  const r = rig({ fetch: (req) => worker.fetch(req) })
  rigs.push(r)
  expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: key + '\n' })).code).toBe(0)
  return r
}

it('deals list with two --expected-close-date flags returns the in-range deals and sends two parameters', async () => {
  const r = await session()
  const j = async (argv: string[]) => {
    const res = await r.run(argv)
    expect(res.code, res.stderr).toBe(0)
    return JSON.parse(res.stdout)
  }
  const p = await j(['pipelines', 'create', '--name', 'Sales'])
  const stage = await j(['pipeline-stages', 'create', '--pipeline-id', p.id, '--name', 'S', '--kind', 'open', '--position', '10'])
  for (const [name, date] of [
    ['Oct', '2026-10-15'],
    ['Nov', '2026-11-10'],
    ['Dec', '2026-12-10'],
  ])
    await j(['deals', 'create', '--name', name!, '--stage-id', stage.id, '--expected-close-date', date!])
  const before = r.seen.length
  const page = await j(['deals', 'list', '--expected-close-date', 'gte.2026-11-01', '--expected-close-date', 'lt.2026-12-01'])
  expect(page.data.map((d: any) => d.name)).toEqual(['Nov'])
  const sent = r.seen.slice(before).filter((x) => new URL(x.url).pathname === '/api/v1/deals')
  expect([...new URL(sent[0]!.url).searchParams.entries()]).toEqual([
    ['expected_close_date', 'gte.2026-11-01'],
    ['expected_close_date', 'lt.2026-12-01'],
  ])
})

it('a timestamp range on another list (contacts --created-at) filters, and a fifth occurrence shows the server 400', async () => {
  const r = await session()
  const ok = async (argv: string[]) => {
    const res = await r.run(argv)
    expect(res.code, res.stderr).toBe(0)
    return JSON.parse(res.stdout)
  }
  await ok(['contacts', 'create', '--name', 'Now'])
  const day = 86_400_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const inside = await ok(['contacts', 'list', '--created-at', `gte.${iso(Date.now() - day)}`, '--created-at', `lt.${iso(Date.now() + day)}`])
  expect(inside.data.map((c: any) => c.name)).toEqual(['Now'])
  const outside = await ok(['contacts', 'list', '--created-at', `gte.${iso(Date.now() + day)}`, '--created-at', `lt.${iso(Date.now() + 2 * day)}`])
  expect(outside.data).toEqual([])
  const five = await r.run(['contacts', 'list', ...['1', '2', '3', '4', '5'].flatMap((n) => ['--created-at', `gte.2026-01-0${n}`])])
  expect(five.code).not.toBe(0)
  expect(five.stderr).toContain('at most 4 conditions (got 5)')
})
