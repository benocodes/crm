import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// API214 (D4): which events a caller sees, per resource type and per association edge, in the list and in get.
const registry = createVaultRegistry()
const ALL = registry.declaredScopes()
const READS = ALL.filter((s) => s.endsWith(':read'))
const AT = '2026-11-12T10:00:00.000Z'
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const call = async (scopes: string[], path: string, init: { method?: string; body?: unknown } = {}) => {
  const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes, kind: 'user' })
  const res = await app.request(path, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null }
}
const must = async (path: string, init: Parameters<typeof call>[2]) => {
  const r = await call(ALL, path, init)
  expect(r.status, `${init?.method} ${path}: ${r.text}`).toBeLessThan(300)
  return r.body
}
const seen = async (scopes: string[], query = 'limit=200') => {
  const r = await call(scopes, `/api/v1/events?${query}`)
  expect(r.status, r.text).toBe(200)
  return r.body.data as { id: string; type: string; resource_type: string }[]
}
const rawEvent = async (type: string, resourceType: string, extra: { before?: unknown; after?: unknown } = {}) => {
  const id = uuidv7()
  await e
    .d1!.prepare('INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, AT, e.organizationId, type, resourceType, uuidv7(), e.userId, extra.before === undefined ? null : JSON.stringify(extra.before), extra.after === undefined ? null : JSON.stringify(extra.after))
    .run()
  return id
}

// Every resource type the code emits, the read scope it is shown under, and the event types it emits (D4). `null`: invisible by design (#217).
const MATRIX: [resourceType: string, readScope: string | null, types: string[]][] = [
  ['task', 'tasks:read', ['task.created', 'task.updated', 'task.deleted']],
  ['contact', 'contacts:read', ['contact.created', 'contact.updated', 'contact.deleted', 'contact.merged']],
  ['company', 'companies:read', ['company.created', 'company.updated', 'company.deleted']],
  ['identity', 'contacts:read', ['identity.created', 'identity.updated', 'identity.deleted']],
  ['note', 'notes:read', ['note.created', 'note.updated', 'note.deleted']],
  ['tag', 'tags:read', ['tag.created', 'tag.updated', 'tag.deleted']],
  ['pipeline', 'pipelines:read', ['pipeline.created', 'pipeline.updated', 'pipeline.deleted']],
  ['pipeline_stage', 'pipelines:read', ['pipeline_stage.created', 'pipeline_stage.updated', 'pipeline_stage.deleted']],
  ['deal', 'deals:read', ['deal.created', 'deal.updated', 'deal.deleted']],
  ['thread', 'messages:read', ['thread.created']],
  ['message', 'messages:read', ['message.created']],
  ['interaction', 'interactions:read', ['interaction.created']],
  ['file', 'files:read', ['file.created']],
  ['contact_file', 'contacts:read', ['contact_file.created', 'contact_file.deleted']],
  ['company_file', 'companies:read', ['company_file.created', 'company_file.deleted']],
  ['agent', 'agents:read', ['agent.created', 'agent.updated']],
  ['api_key', 'agents:read', ['api_key.created', 'api_key.revoked']],
  ['connection', 'connections:read', ['connection.created', 'connection.updated']],
  ['membership', 'members:read', ['membership.created', 'membership.updated', 'membership.deleted']],
  ['organization', 'members:read', ['organization.created', 'organization.updated']],
  ['action_request', null, ['action_request.created', 'action_request.executed', 'action_request.failed', 'action_request.expired', 'action_request.superseded']],
  ['action_execution', null, ['action_execution.created', 'action_execution.completed', 'action_execution.failed']],
]

describe('visibility per resource type (matrix)', () => {
  it.each(MATRIX)('%s events', async (resourceType, readScope, types) => {
    const made: string[] = []
    for (const type of types) made.push(await rawEvent(type, resourceType))
    const withScope = ['events:read', ...(readScope ? [readScope] : READS.filter((s) => s !== 'events:read'))]
    const without = ['events:read', ...READS.filter((s) => s !== 'events:read' && s !== readScope)]
    const bare = ['events:read']
    if (readScope) {
      expect((await seen(withScope)).map((x) => x.id), 'visible in list with events:read plus the read scope').toEqual(made)
      for (const id of made) expect((await call(withScope, `/api/v1/events/${id}`)).status, 'visible in get').toBe(200)
    }
    for (const scopes of [without, bare]) {
      expect(await seen(scopes), `hidden in list for ${scopes.length} scopes`).toEqual([])
      for (const id of made) expect((await call(scopes, `/api/v1/events/${id}`)).status, 'hidden in get').toBe(404)
    }
    if (readScope === null) {
      // Invisible by design: not even with every read scope (action requests and executions, #217).
      expect(await seen(['events:read', ...READS])).toEqual([])
    }
  })

  it('a resource type with no entry is invisible, whatever the caller holds', async () => {
    await rawEvent('widget.created', 'widget')
    expect(await seen(['events:read', ...READS])).toEqual([])
  })

  it('every resource type the code emits has an entry or a place on the named invisible list', () => {
    const emitted = new Set<string>()
    for (const def of registry.resources()) emitted.add(def.eventName)
    const root = join(__dirname, '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(f) && !/(\.test|\.suite)\.ts$/.test(f) && !p.includes('/test/') ? [p] : []
      })
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/resourceType: '([a-z_]+)'/g)) emitted.add(m[1]!)
    }
    // Events emitted for a resource whose definition or call site names it through a variable are covered by the definitions above.
    const decl = registry.eventTypes()
    const unplaced = [...emitted].filter((t) => !decl.has(t))
    expect(unplaced, 'emitted resource types with neither a scope entry nor an invisible entry').toEqual([])
    const invisible = [...decl].filter(([, d]) => 'invisible' in d).map(([t]) => t).sort()
    expect(invisible).toEqual(['action_execution', 'action_request'])
    for (const [, d] of decl) if ('invisible' in d) expect(d.invisible).toMatch(/#217/)
    for (const [t, readScope] of MATRIX.map(([t, s]) => [t, s] as const)) {
      const d = decl.get(t)
      expect(d, t).toBeDefined()
      if (readScope !== null) expect('scope' in d! && `${d.scope}:read`, t).toBe(readScope)
    }
  })

  it('the messaging split (CORE25): interactions:read alone sees the interaction and not the thread or message; files and contact files have their own scopes', async () => {
    await runCapture(e, { connection_id: uuidv7(), messages: [captureMessage(e.organizationId, { attachments: 1 })] })
    const types = async (scopes: string[]) => (await seen(['events:read', ...scopes])).map((x) => x.type)
    expect(await types(['interactions:read'])).toEqual(['interaction.created'])
    expect(await types(['messages:read'])).toEqual(['thread.created', 'message.created'])
    expect(await types(['files:read'])).toEqual(['file.created'])
    expect(await types(['messages:read', 'files:read', 'interactions:read'])).toEqual(['thread.created', 'message.created', 'file.created', 'interaction.created'])
    expect(await types(['tasks:read', 'contacts:read'])).toEqual([])
    await rawEvent('contact_file.created', 'contact_file')
    expect(await types(['contacts:read'])).toEqual(['contact_file.created'])
  })

  it('real writes are visible to their reader and to nobody else: task, contact, deal move', async () => {
    const task = await must('/api/v1/tasks', { method: 'POST', body: { title: 't' } })
    await must('/api/v1/contacts', { method: 'POST', body: { name: 'Ada' } })
    expect((await seen(['events:read', 'tasks:read'])).map((x) => x.type)).toEqual(['task.created'])
    expect((await seen(['events:read', 'contacts:read'])).map((x) => x.type)).toEqual(['contact.created'])
    expect(await seen(['events:read', 'notes:read'])).toEqual([])
    expect((await call(['events:read', 'tasks:read'], `/api/v1/events/${(await seen(['events:read', 'tasks:read']))[0]!.id}`)).body.resource_id).toBe(task.id)
  })
})

describe('the edge predicate (association events)', () => {
  const READ_SETS: string[][] = [
    ['events:read'],
    ['events:read', 'associations:read'],
    ['events:read', 'associations:read', 'contacts:read'],
    ['events:read', 'associations:read', 'companies:read'],
    ['events:read', 'associations:read', 'tasks:read'],
    ['events:read', 'associations:read', 'contacts:read', 'companies:read'],
    ['events:read', 'associations:read', 'contacts:read', 'tasks:read'],
    ['events:read', 'associations:read', 'contacts:read', 'companies:read', 'tasks:read'],
    ['events:read', 'contacts:read', 'companies:read', 'tasks:read'],
  ]
  /** Which association events a caller may see, computed from the stored rows: `associations:read` and both endpoint types readable. */
  const expected = async (scopes: string[]) => {
    const rows = await e.d1!.prepare("select id, coalesce(after, before) as rec from events where resource_type = 'association' order by seq").all<{ id: string; rec: string }>()
    const has = (resource: string) => scopes.includes(`${resource}:read`)
    return rows.results
      .filter((r) => {
        const rec = JSON.parse(r.rec)
        return has('associations') && has(rec.a_type) && has(rec.b_type)
      })
      .map((r) => r.id)
  }
  const edgeEvents = async (scopes: string[]) => (await seen(scopes)).filter((x) => x.resource_type === 'association').map((x) => x.id)
  const check = async (label: string) => {
    for (const scopes of READ_SETS) expect(await edgeEvents(scopes), `${label}: ${scopes.join(',')}`).toEqual(await expected(scopes))
  }
  const link = (a: [string, string], b: [string, string]) =>
    must('/api/v1/associations', { method: 'POST', body: { a_type: a[0], a_id: a[1], b_type: b[0], b_id: b[1] } })
  const make = async () => ({
    contact: (await must('/api/v1/contacts', { method: 'POST', body: { name: 'Ada' } })).id as string,
    company: (await must('/api/v1/companies', { method: 'POST', body: { name: 'Acme' } })).id as string,
    task: (await must('/api/v1/tasks', { method: 'POST', body: { title: 't' } })).id as string,
  })

  it('create and delete: hidden without associations:read, and when either endpoint type is unreadable, on each side', async () => {
    const m = await make()
    const edge = await link(['companies', m.company], ['contacts', m.contact])
    expect([edge.a_type, edge.b_type]).toEqual(['companies', 'contacts'])
    const toTask = await link(['contacts', m.contact], ['tasks', m.task])
    expect([toTask.a_type, toTask.b_type]).toEqual(['contacts', 'tasks'])
    await check('after create')
    expect(await edgeEvents(['events:read', 'associations:read', 'contacts:read', 'companies:read'])).toHaveLength(1)
    await must(`/api/v1/associations/${edge.id}`, { method: 'DELETE' })
    await check('after delete')
    // The delete's event is read from `before` (after is null): visible to the full reader only.
    const full = await edgeEvents(['events:read', 'associations:read', 'contacts:read', 'companies:read', 'tasks:read'])
    expect(full).toHaveLength(3)
    expect(await edgeEvents(['events:read', 'associations:read', 'contacts:read', 'tasks:read'])).toHaveLength(1)
  })

  it('edges deleted by a contact delete cascade follow the same rule', async () => {
    const m = await make()
    await link(['companies', m.company], ['contacts', m.contact])
    await link(['contacts', m.contact], ['tasks', m.task])
    await must(`/api/v1/contacts/${m.contact}`, { method: 'DELETE' })
    const cascaded = (await e.d1!.prepare("select count(*) as n from events where type = 'association.deleted'").first<{ n: number }>())!.n
    expect(cascaded, 'the cascade emitted association.deleted events').toBe(2)
    await check('after cascade')
    expect(await edgeEvents(['events:read', 'associations:read', 'contacts:read', 'companies:read'])).toHaveLength(3)
    expect(await edgeEvents(['events:read', 'associations:read', 'companies:read'])).toHaveLength(0)
  })

  it('edges moved or dropped by a contact merge follow the same rule', async () => {
    const m = await make()
    const survivor = (await must('/api/v1/contacts', { method: 'POST', body: { name: 'Ada 2' } })).id as string
    const other = (await must('/api/v1/companies', { method: 'POST', body: { name: 'Other' } })).id as string
    await link(['companies', m.company], ['contacts', m.contact])
    await link(['companies', m.company], ['contacts', survivor])
    await link(['companies', other], ['contacts', m.contact])
    await link(['contacts', m.contact], ['tasks', m.task])
    await must(`/api/v1/contacts/${survivor}/merge`, { method: 'POST', body: { source_id: m.contact } })
    const types = (await e.d1!.prepare("select distinct type from events where resource_type = 'association' order by type").all<{ type: string }>()).results.map((r) => r.type)
    expect(types, 'the merge emitted edge events beyond create').toEqual(expect.arrayContaining(['association.created', 'association.deleted', 'association.updated']))
    await check('after merge')
    expect((await edgeEvents(['events:read', 'associations:read', 'contacts:read', 'tasks:read'])).length).toBeGreaterThan(0)
  })

  it('an edge whose endpoint type is unknown, or whose record is not an edge, is invisible even to a reader of everything', async () => {
    await rawEvent('association.created', 'association', { after: { a_type: 'bogus', a_id: uuidv7(), b_type: 'contacts', b_id: uuidv7() } })
    await rawEvent('association.created', 'association', { after: { a_type: 'contacts', a_id: uuidv7() } })
    await rawEvent('association.created', 'association', {})
    expect(await edgeEvents(['events:read', ...READS])).toEqual([])
    const ok = await rawEvent('association.deleted', 'association', { before: { a_type: 'contacts', a_id: uuidv7(), b_type: 'tasks', b_id: uuidv7() } })
    expect(await edgeEvents(['events:read', ...READS])).toEqual([ok])
    expect((await call(['events:read', ...READS], `/api/v1/events/${ok}`)).status).toBe(200)
    expect((await call(['events:read', 'associations:read', 'contacts:read'], `/api/v1/events/${ok}`)).status).toBe(404)
  })
})
