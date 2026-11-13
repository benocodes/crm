import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { composeD1Worker } from '@vibase/server-d1/compose'
import { bootstrapD1 } from '@vibase/server-d1/bootstrap'
import { openWorkerD1, type WorkerD1 } from '@vibase/server-d1/test'
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
  const b = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'e2e', email: 'e2e@example.com', agentName: 'e2e-agent', scopes: ['contacts:read', 'contacts:write', 'schema:read', 'interactions:read', 'deals:read', 'deals:write', 'pipelines:read', 'pipelines:write', 'companies:read', 'companies:write', 'associations:read', 'associations:write', 'webhooks:read', 'webhooks:write', 'tasks:read'] })
  key = b.key
})
const session = async (env: { CREDENTIALS_KEY?: string } = {}) => {
  const worker = composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '', ...env })
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

  it('the execution reads are commands derived from the registry: action-executions list answers an empty page when nothing is enqueued, and get of any id is 404 ([[AGT8]] D57)', async () => {
    const r = await session()
    expect(JSON.parse((await ok(r, ['action-executions', 'list'])).stdout)).toEqual({ data: [], next_cursor: null })
    const missing = await r.run(['action-executions', 'get', '0190b2c4-0000-7000-8000-00000000dead'])
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('not_found')
    expect((await ok(r, ['action-executions', '--help'])).stdout).toMatch(/list|get/)
  })

  it('action-executions list --help carries the sort flags and the note naming the three times; the unsorted output keeps its shape ([[CORE188]] D2, D4)', async () => {
    const r = await session()
    const help = (await ok(r, ['action-executions', 'list', '--help'])).stdout
    expect(help).toContain('--sort')
    expect(help).toContain('--order')
    for (const pattern of [/queued at/i, /executed at/i, /done or failed/i, /unfinished/i, /sort=done_at&order=desc/, /approved at/i]) expect(help, String(pattern)).toMatch(pattern)
    // A sorted call with nothing readable answers the same empty page as an unsorted one.
    expect(JSON.parse((await ok(r, ['action-executions', 'list', '--sort', 'done_at', '--order', 'desc'])).stdout)).toEqual({ data: [], next_cursor: null })
    const bad = await r.run(['action-executions', 'list', '--sort', 'dispatched_at'])
    expect(bad.code).not.toBe(0)
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

  /** Three contacts that were all contacted, at known times, through the capture unit of the API (D14): the CLI cannot write interactions. */
  const seedSorted = async (r: ReturnType<typeof rig>) => {
    const ids: string[] = []
    for (const name of ['A', 'B', 'C']) ids.push(JSON.parse((await ok(r, ['contacts', 'create', '--name', name])).stdout).id)
    return ids
  }

  it('sort ([[CORE133]] D12): --sort and --order come from the registry and are sent as query parameters', async () => {
    const r = await session()
    const ids = await seedSorted(r)
    const before = r.seen.length
    const res = JSON.parse((await ok(r, ['contacts', 'list', '--sort', 'last_contacted_at', '--order', 'desc'])).stdout)
    const sent = r.seen.slice(before).filter((x) => x.url.includes('/api/v1/contacts?'))
    expect(sent.length).toBeGreaterThan(0)
    for (const x of sent) {
      expect(new URL(x.url).searchParams.get('sort')).toBe('last_contacted_at')
      expect(new URL(x.url).searchParams.get('order')).toBe('desc')
    }
    // all three never contacted: nulls tie, id descending
    expect(res.data.map((c: any) => c.id)).toEqual([...ids].sort().reverse())
    expect((await r.run(['contacts', 'list', '--sort', 'no_such_field'])).code).toBe(2) // the enum is the registry's (CORE175: name is a sort now)
    expect((await r.run(['contacts', 'list', '--order', 'desc'])).code).toBe(1) // the API refuses order without sort
  })

  it('sort: --all follows the opaque string cursors to the end and stops, each page sent with the same sort and order', async () => {
    const r = await session()
    const ids = await seedSorted(r)
    const before = r.seen.length
    const all = await ok(r, ['contacts', 'list', '--all', '--limit', '1', '--sort', 'last_interacted_at', '--order', 'asc'])
    const lines = all.stdout.trimEnd().split('\n')
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([...ids].sort())
    const gets = r.seen.slice(before).filter((x) => x.url.includes('/api/v1/contacts?'))
    expect(gets).toHaveLength(3)
    expect(gets.every((g) => new URL(g.url).searchParams.get('sort') === 'last_interacted_at' && new URL(g.url).searchParams.get('order') === 'asc')).toBe(true)
    const afters = gets.map((g) => new URL(g.url).searchParams.get('after'))
    expect(afters[0]).toBeNull()
    expect(afters[1]).not.toMatch(/^[0-9a-f]{8}-/) // opaque, not a bare id
  })

  it('a cache written before sort (no --sort/--order, after typed uuid): --sort refreshes once and sorts, never sends the list unsorted ([[CORE133]])', async () => {
    const r = await session()
    const ids = await seedSorted(r)
    await ok(r, ['contacts', 'list']) // writes the discovery cache
    const file = join(r.cacheDir, readdirSync(r.cacheDir).find((f) => f.startsWith('discovery-'))!)
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    const list = cache.ops.find((o: any) => o.id === 'contacts.list')
    expect(list.parameters.map((x: any) => x.name)).toContain('sort') // the fresh document has it
    list.parameters = list.parameters.filter((x: any) => !['sort', 'order'].includes(x.name))
    list.parameters.find((x: any) => x.name === 'after').schema = { type: 'string', format: 'uuid' }
    writeFileSync(file, JSON.stringify(cache))
    const before = r.seen.length
    const res = await r.run(['contacts', 'list', '--sort', 'last_contacted_at', '--order', 'desc'])
    expect(res.stderr).not.toMatch(/TypeError/)
    expect(res.code).toBe(0) // the chosen behaviour (decision): one refresh, then the sort
    expect(JSON.parse(res.stdout).data.map((c: any) => c.id)).toEqual([...ids].sort().reverse())
    const lists = r.seen.slice(before).filter((x) => x.url.includes('/api/v1/contacts?'))
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every((x) => new URL(x.url).searchParams.get('sort') === 'last_contacted_at')).toBe(true)
    expect(r.seen.slice(before).filter((x) => x.url.includes('/openapi.json')).length).toBeGreaterThan(0) // it refreshed
  })

  it('a cache that types after as uuid does not refuse an opaque --after locally: the server decides', async () => {
    const r = await session()
    await seedSorted(r)
    const first = JSON.parse((await ok(r, ['contacts', 'list', '--limit', '1', '--sort', 'last_contacted_at'])).stdout)
    expect(first.next_cursor).not.toBeNull()
    const file = join(r.cacheDir, readdirSync(r.cacheDir).find((f) => f.startsWith('discovery-'))!)
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    cache.ops.find((o: any) => o.id === 'contacts.list').parameters.find((x: any) => x.name === 'after').schema = { type: 'string', format: 'uuid' }
    writeFileSync(file, JSON.stringify(cache))
    const next = await r.run(['contacts', 'list', '--limit', '1', '--sort', 'last_contacted_at', '--after', first.next_cursor])
    expect(next.stderr).toBe('')
    expect(next.code).toBe(0)
    expect(JSON.parse(next.stdout).data).toHaveLength(1)
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

describe('webhook subscriptions through the CLI ([[API7]])', () => {
  const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')

  it('webhooks create, list, get, update, rotate-secret and delete, derived from the meta document', async () => {
    const r = await session({ CREDENTIALS_KEY: KEY })
    const created = JSON.parse((await ok(r, ['webhooks', 'create', '--url', 'https://example.com/hook', '--event-types', '["task.created"]'])).stdout)
    expect(created).toMatchObject({ url: 'https://example.com/hook', event_types: ['task.created'], status: 'active' })
    expect(created.secret).toMatch(/^whsec_/)
    const listed = JSON.parse((await ok(r, ['webhooks', 'list'])).stdout)
    expect(listed.data.map((s: any) => s.id)).toEqual([created.id])
    expect(JSON.stringify(listed)).not.toContain('whsec_')
    const got = JSON.parse((await ok(r, ['webhooks', 'get', created.id])).stdout)
    expect(got.id).toBe(created.id)
    const paused = JSON.parse((await ok(r, ['webhooks', 'update', created.id, '--status', 'paused'])).stdout)
    expect(paused.status).toBe('paused')
    const rotated = JSON.parse((await ok(r, ['webhooks', 'rotate-secret', created.id])).stdout)
    expect(Object.keys(rotated).sort()).toEqual(['previous_valid_until', 'secret'])
    expect((await ok(r, ['webhooks', 'delete', created.id])).stdout).toBe('')
    expect(JSON.parse((await ok(r, ['webhooks', 'list'])).stdout).data).toEqual([])
    noKey(await ok(r, ['webhooks', 'list']))
  })

  it('without the key the CLI reports the 501 as an error naming webhooks_not_configured', async () => {
    const r = await session()
    const res = await r.run(['webhooks', 'create', '--url', 'https://example.com/hook', '--event-types', '["task.created"]'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('webhooks_not_configured')
  })
})
