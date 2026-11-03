import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
beforeEach(async () => {
  await w.reset()
  hideOperation = undefined
  const b = await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'none', authOrgId: 'e2e', email: 'e2e@example.com', agentName: 'e2e-agent', scopes: ['contacts:read', 'contacts:write', 'schema:read'] })
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
    const probe = await r.run(['notes', 'create', '--data', '{}'])
    void probe
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
