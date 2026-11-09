import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE194]] cycle 1 (D4, D5): the search indexes follow the resources' real write paths (REST create, patch, delete), emit no
// event of their own, and are invisible to schema.get (the virtual tables and every FTS5 shadow table).
let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVaultRegistry()
const ALL = registry.declaredScopes()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})

const headers = () => ({ authorization: `Bearer ${mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes: ALL, kind: 'agent' })}`, 'content-type': 'application/json' })
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: res.status === 204 ? null : ((await res.json()) as any) }
}
const all = async (text: string, ...binds: unknown[]) => ((await e.d1!.prepare(text).bind(...binds).all()).results ?? []) as Record<string, any>[]
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`
const hit = async (table: string, term: string) =>
  (await all(`SELECT b.id AS id FROM "${table}" b WHERE b.deleted_at IS NULL AND b.id IN (SELECT id FROM "${table}_search" WHERE "${table}_search" MATCH ?)`, quote(term))).map((r) => r.id as string)

const CASES = [
  { table: 'companies', path: '/api/v1/companies', create: { name: 'Quokka Holdings', domain: 'quokka.example' }, patch: { name: 'Platypus Holdings' }, oldTerm: 'quokka', newTerm: 'platypus' },
  { table: 'notes', path: '/api/v1/notes', create: { title: 'Quokka plan', content: 'wombat renewal' }, patch: { content: 'numbat renewal' }, oldTerm: 'wombat', newTerm: 'numbat' },
  { table: 'tasks', path: '/api/v1/tasks', create: { title: 'Quokka call', notes: 'wombat follow up' }, patch: { notes: 'numbat follow up' }, oldTerm: 'wombat', newTerm: 'numbat' },
] as const

describe.each(CASES)('$table: index follows the real write paths and emits no event of its own', (c) => {
  it('create, patch and delete through REST', async () => {
    const before = (await e.events()).length
    const created = await call('POST', c.path, c.create)
    expect(created.status).toBe(201)
    const id = created.json.id as string
    expect(await hit(c.table, 'quokka')).toEqual([id])
    const patched = await call('PATCH', `${c.path}/${id}`, c.patch)
    expect(patched.status).toBe(200)
    expect(await hit(c.table, c.oldTerm)).toEqual([])
    expect(await hit(c.table, c.newTerm)).toEqual([id])
    expect((await call('DELETE', `${c.path}/${id}`)).status).toBe(204)
    expect(await hit(c.table, c.newTerm)).toEqual([])
    expect(await all(`SELECT id FROM "${c.table}_search"`)).toEqual([])
    // three writes, three events, none for the index (resource_type is always the resource's own)
    const events = (await e.events()).slice(before)
    expect(events).toHaveLength(3)
    expect([...new Set(events.map((x) => x.resource_id))]).toEqual([id])
    expect(events.filter((x) => /search/.test(String(x.type) + String(x.resource_type)))).toEqual([])
  })
})

describe('schema.get does not show the search machinery', () => {
  it('lists no *_search table and no FTS5 shadow table, but still lists the resources', async () => {
    const res = await call('GET', '/meta/v1/schema')
    expect(res.status).toBe(200)
    const names = res.json.tables.map((t: any) => t.name) as string[]
    expect(names.filter((n) => /_search(_|$)/.test(n))).toEqual([])
    for (const resource of ['companies', 'notes', 'tasks']) expect(names).toContain(resource)
    // the real database does hold them, so the exclusion is doing work
    const real = (await all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%\\_search%' ESCAPE '\\'")).map((r) => r.name as string)
    expect(real).toEqual(expect.arrayContaining(['companies_search', 'companies_search_data', 'notes_search_idx', 'tasks_search_docsize']))
  })
})
