import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker } from '@vault/server-d1/compose'
import { bootstrapD1 } from '@vault/server-d1/bootstrap'
import { openWorkerD1, type WorkerD1 } from '@vault/server-d1/test'
import { rig, SERVER } from './test/harness.js'

// [[API6]] cycle 1: the CLI against the real D1 app, in process, with an API-key profile (no auth provider).

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())

let key: string
let hideOperation: string | undefined
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
beforeEach(async () => {
  await w.reset()
  hideOperation = undefined
  const b = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'e2e', email: 'e2e@example.com', agentName: 'e2e-agent', scopes: ['contacts:read', 'contacts:write', 'schema:read', 'interactions:read', 'deals:read', 'deals:write', 'pipelines:read', 'pipelines:write', 'companies:read', 'companies:write', 'associations:read', 'associations:write'] })
  key = b.key
})
const session = async () => {
  const worker = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' })
  const r = rig({
    fetch: async (req) => {
      const res = await worker.fetch(req)
      if (hideOperation && new URL(req.url).pathname === '/api/v1/openapi.json') {
        const doc = (await res.json()) as any
        for (const methods of Object.values<any>(doc.paths)) for (const [m, op] of Object.entries<any>(methods)) if (op.operationId === hideOperation) delete methods[m]
        return new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } })
      }
      return res
    },
  })
  rigs.push(r)
  expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: key + '\n' })).code).toBe(0)
  return r
}
const ok = async (r: ReturnType<typeof rig>, argv: string[]) => {
  const res = await r.run(argv)
  expect(res.stderr).toBe('')
  expect(res.code).toBe(0)
  return res
}
const noKey = (x: { stdout: string; stderr: string }) => {
  expect(x.stdout).not.toContain(key)
  expect(x.stderr).not.toContain(key)
}

describe('against the D1 app', () => {
  it('me get and schema get answer as the agent; every success prints parseable JSON and no key', async () => {
    const r = await session()
    const me = await ok(r, ['me', 'get'])
    expect(JSON.parse(me.stdout)).toMatchObject({ principal: { kind: 'agent' }, agent: { name: 'e2e-agent' } })
    const schema = await ok(r, ['schema', 'get'])
    expect(schema.stdout).toContain('contacts')
    JSON.parse(schema.stdout)
    noKey(me)
    noKey(schema)
  })

  it('create, get and list a contact', async () => {
    const r = await session()
    const created = JSON.parse((await ok(r, ['contacts', 'create', '--name', 'E2E Person'])).stdout)
    expect(created).toMatchObject({ name: 'E2E Person' })
    const got = JSON.parse((await ok(r, ['contacts', 'get', created.id])).stdout)
    expect(got.id).toBe(created.id)
    const viaData = JSON.parse((await ok(r, ['contacts', 'create', '--data', '{"name":"Via Data"}'])).stdout)
    expect(viaData.name).toBe('Via Data')
    const page = JSON.parse((await ok(r, ['contacts', 'list'])).stdout)
    expect(page.data.map((c: any) => c.id).sort()).toEqual([created.id, viaData.id].sort())
    expect(page.next_cursor).toBeNull()
    const updated = JSON.parse((await ok(r, ['contacts', 'update', created.id, '--name', 'Renamed'])).stdout)
    expect(updated.name).toBe('Renamed')
  })

  it('list --all follows next_cursor across pages and prints one NDJSON line per record', async () => {
    const r = await session()
    const ids: string[] = []
    for (const name of ['A', 'B', 'C']) ids.push(JSON.parse((await ok(r, ['contacts', 'create', '--name', name])).stdout).id)
    const page = JSON.parse((await ok(r, ['contacts', 'list', '--limit', '1'])).stdout)
    expect(page.data).toHaveLength(1)
    expect(page.next_cursor).toBe(page.data[0].id)
    const all = await ok(r, ['contacts', 'list', '--all', '--limit', '1'])
    const lines = all.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).id).sort()).toEqual([...ids].sort())
    const gets = r.seen.filter((s) => s.url.includes('/api/v1/contacts?') && s.url.includes('limit=1'))
    expect(gets.length).toBeGreaterThanOrEqual(3)
  })

  it('derived activity ([[CORE131]] D12): the filter flags come from the registry and filter in process', async () => {
    const r = await session()
    const ids: string[] = []
    for (const name of ['A', 'B']) ids.push(JSON.parse((await ok(r, ['contacts', 'create', '--name', name])).stdout).id)
    const never = JSON.parse((await ok(r, ['contacts', 'list', '--never-contacted', 'true'])).stdout)
    expect(never.data.map((c: any) => c.id).sort()).toEqual([...ids].sort())
    expect(never.data[0]).toMatchObject({ last_contacted_at: null, last_interacted_at: null })
    const contacted = JSON.parse((await ok(r, ['contacts', 'list', '--contacted-since', '2026-01-01T00:00:00Z'])).stdout)
    expect(contacted.data).toEqual([])
    const stale = JSON.parse((await ok(r, ['contacts', 'list', '--not-contacted-since', '2026-01-01T00:00:00Z'])).stdout)
    expect(stale.data).toHaveLength(2)
    expect((await r.run(['contacts', 'list', '--never-contacted', 'maybe'])).code).toBe(2)
  })

  it('deals and pipelines ([[CORE130]] D17): pipelines, pipeline-stages and deals commands, and move-stage, derive from the two documents', async () => {
    const r = await session()
    const json = async (argv: string[]) => JSON.parse((await ok(r, argv)).stdout)
    const p = await json(['pipelines', 'create', '--name', 'Prospecting'])
    const open = await json(['pipeline-stages', 'create', '--pipeline-id', p.id, '--name', 'Researched', '--kind', 'open', '--position', '10'])
    const won = await json(['pipeline_stages', 'create', '--pipeline-id', p.id, '--name', 'Won', '--kind', 'won', '--position', '90'])
    expect((await json(['pipeline-stages', 'list', '--pipeline-id', p.id, '--kind', 'won'])).data.map((x: any) => x.id)).toEqual([won.id])
    const d = await json(['deals', 'create', '--name', 'Acme - pilot', '--stage-id', open.id, '--amount-minor', '5000', '--currency', 'usd'])
    expect(d).toMatchObject({ pipeline_id: p.id, status: 'open', currency: 'USD' })
    const moved = await json(['deals', 'move-stage', d.id, '--stage-id', won.id])
    expect(moved).toMatchObject({ id: d.id, stage_id: won.id, status: 'won' })
    expect((await json(['deals', 'move_stage', d.id, '--stage-id', open.id])).status).toBe('open')
    expect((await json(['deals', 'list', '--status', 'open', '--pipeline-id', p.id])).data.map((x: any) => x.id)).toEqual([d.id])
    const refused = await r.run(['deals', 'update', d.id, '--data', JSON.stringify({ stage_id: won.id })]) // create-only: the API refuses, naming deals.move_stage
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stderr).error.message).toContain('deals.move_stage')
    expect((await json(['pipelines', 'get', p.id])).name).toBe('Prospecting')
  })

  it('a cache that predates deals: `deals` alone refreshes and gives resource help, exit 2, no TypeError', async () => {
    const r = await session()
    await ok(r, ['contacts', 'list']) // writes the discovery cache
    const file = join(r.cacheDir, readdirSync(r.cacheDir).find((f) => f.startsWith('discovery-'))!)
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    cache.ops = cache.ops.filter((o: any) => !/^(deals|pipelines|pipeline_stages)\./.test(o.id))
    writeFileSync(file, JSON.stringify(cache))
    const res = await r.run(['deals'])
    expect(res.stderr).not.toMatch(/TypeError/)
    expect(res.code).toBe(2)
    expect(res.stdout).toContain('move-stage')
    expect(res.stdout).toContain('create')
  })

  it('a cache written before deals.list took company_id: --company-id refreshes once and filters, never sends the list unfiltered ([[CORE136]])', async () => {
    const r = await session()
    const json = async (argv: string[]) => JSON.parse((await ok(r, argv)).stdout)
    const p = await json(['pipelines', 'create', '--name', 'Sales'])
    const stage = await json(['pipeline-stages', 'create', '--pipeline-id', p.id, '--name', 'Researched', '--kind', 'open', '--position', '10'])
    const linked = await json(['deals', 'create', '--name', 'Linked', '--stage-id', stage.id])
    await json(['deals', 'create', '--name', 'Other', '--stage-id', stage.id])
    const co = await json(['companies', 'create', '--name', 'Acme'])
    await json(['associations', 'create', '--data', JSON.stringify({ a_type: 'companies', a_id: co.id, b_type: 'deals', b_id: linked.id })])
    const file = join(r.cacheDir, readdirSync(r.cacheDir).find((f) => f.startsWith('discovery-'))!)
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    const list = cache.ops.find((o: any) => o.id === 'deals.list')
    expect(list.parameters.map((x: any) => x.name)).toContain('company_id') // the fresh document has it
    list.parameters = list.parameters.filter((x: any) => !['company_id', 'contact_id', 'tag_id'].includes(x.name))
    writeFileSync(file, JSON.stringify(cache))
    const before = r.seen.length
    const res = await r.run(['deals', 'list', '--company-id', co.id])
    expect(res.stderr).not.toMatch(/TypeError/)
    if (res.code === 0) {
      expect(JSON.parse(res.stdout).data.map((d: any) => d.id)).toEqual([linked.id])
      expect(r.seen.slice(before).filter((s) => s.url.includes('/api/v1/deals?')).every((s) => s.url.includes('company_id='))).toBe(true)
    } else {
      expect(res.code).toBe(2)
      expect(res.stderr).toContain('company-id')
      expect(r.seen.slice(before).filter((s) => s.url.includes('/api/v1/deals?'))).toEqual([])
    }
    expect(res.code).toBe(0) // the chosen behaviour (decision): one refresh, then the filter
  })

  it('a genuine usage error on a cached (non-fresh) command line answers as on a fresh cache: stdin is read once, nothing is sent ([[CORE136]] review)', async () => {
    const r = await session()
    const fresh = await r.run(['contacts', 'create', '--data', '-'], { stdin: '{not json' }) // no cache yet: discovery is fresh
    expect(fresh.code).toBe(2)
    const before = r.seen.length
    const cached = await r.run(['contacts', 'create', '--data', '-'], { stdin: '{not json' }) // the cache written by the run above
    expect(cached.code).toBe(2)
    expect(cached.stderr).toBe(fresh.stderr)
    expect(cached.stderr).toContain('--data is not valid JSON')
    expect(r.seen.slice(before).filter((x) => x.method === 'POST')).toEqual([])
  })

  it('--all on an operation that is not a list is a usage error', async () => {
    const r = await session()
    expect((await r.run(['me', 'get', '--all'])).code).toBe(2)
  })

  it('an API error is { error: { code, message } } on stderr with exit 1; a usage error is exit 2', async () => {
    const r = await session()
    const missing = await r.run(['contacts', 'get', '00000000-0000-7000-8000-000000000000'])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: 'not_found' } })
    expect((await r.run(['contacts', 'frobnicate'])).code).toBe(2)
    expect((await r.run(['contacts', 'get'])).code).toBe(2)
    expect((await r.run(['contacts', 'create', '--size', '1'])).code).toBe(2)
  })

  it('a key without the scope gets the API 403 on stderr and exit 1', async () => {
    const r = await session()
    const res = await r.run(['notes', 'create', '--data', '{}'])
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(JSON.parse(res.stderr).error.code).toMatch(/forbidden|insufficient/)
  })

  it('commands are derived from the live document: an operation the server stops serving is no longer a command', async () => {
    const r = await session()
    const id = JSON.parse((await ok(r, ['contacts', 'create', '--name', 'X'])).stdout).id
    expect((await r.run(['contacts', 'list'])).code).toBe(0)
    hideOperation = 'contacts.list'
    const res = await r.run(['contacts', 'list', '--refresh'])
    expect(res.code).toBe(2)
    expect((await r.run(['contacts', 'get', id])).code).toBe(0)
  })
})
