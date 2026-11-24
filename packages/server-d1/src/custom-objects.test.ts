import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '@vibase/api/test/custom-objects'
import { bootstrapD1, NOW, openWorkerD1, type WorkerD1, composeD1Worker } from './test/kit.js'

// [[CORE315]] D23, D24: the Worker's composition takes the custom definitions as ONE dependency and hands them to every registry it builds: the app's (REST, the declared scopes an agent may hold, the approval of a
// proposal) and the rail's (the per-minute tick: webhook dispatch reads its event types). Nothing in production passes one yet (T4, #543): this is the composition seam.
let w: WorkerD1
let key: string
let weakKey: string
const BASE = 'https://w.test'
const CRED = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const FULL = [
  `${PROJECTS_KEY}:read`,
  `${PROJECTS_KEY}:write`,
  `${PROJECTS_KEY}:request_approval`,
  'action_requests:read',
  'events:read',
  'webhooks:read',
  'webhooks:write',
]
const receiver: typeof fetch = async () => new Response(null, { status: 503 })
const worker = (withDefinitions = true) =>
  composeD1Worker(
    { DB: w.d1, AUTH_PROVIDER: '', CREDENTIALS_KEY: CRED },
    {
      fetch: receiver,
      clock: () => NOW,
      newId: () => uuidv7(NOW),
      ...(withDefinitions ? { definitions: [projectsDefinition()] } : {}),
    },
  )
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown, as = key) => {
  const res = await wk.fetch(
    new Request(BASE + path, {
      method,
      headers: { authorization: `Bearer ${as}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const rows = async (sqlText: string) =>
  ((await (/\bwebhook_/.test(sqlText) ? w.control : w.d1).prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>

beforeAll(async () => {
  w = await openWorkerD1()
  await createCustomTables(w.d1)
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  key = (
    await bootstrapD1(
      w.d1,
      { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: FULL },
      { now: NOW, newId: () => uuidv7(NOW) },
    )
  ).key!
})
afterEach(() => vi.restoreAllMocks())

describe('the app serves the definitions it was given', () => {
  it('REST: create, get and list; the agent holds the declared scopes it was granted', async () => {
    const wk = worker()
    const made = await call(wk, 'POST', `/api/v1/${PROJECTS_KEY}`, { name: 'Site rebuild' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect((await call(wk, 'GET', `/api/v1/${PROJECTS_KEY}/${made.body.id}`)).body.name).toBe('Site rebuild')
    expect((await call(wk, 'GET', `/api/v1/${PROJECTS_KEY}`)).body.data).toHaveLength(1)
  })
  it('without definitions the Worker has no such route', async () => {
    expect((await call(worker(false), 'GET', `/api/v1/${PROJECTS_KEY}`)).status).toBe(404)
  })
  it('an agent whose stored grant predates the object holds none of its scopes', async () => {
    weakKey = (
      await bootstrapD1(
        w.d1,
        { organizationName: 'Acme', agentName: 'weak', authOrgId: 'org_acme', scopes: ['tasks:read'] },
        { now: NOW, newId: () => uuidv7(NOW) },
      )
    ).key!
    const refused = await call(worker(), 'GET', `/api/v1/${PROJECTS_KEY}`, undefined, weakKey)
    expect(refused.status).toBe(403)
  })
})

describe('a proposal for a custom object is approved and executed', () => {
  it('proposes <key>__c.create, approves it, and the row and its event exist', async () => {
    const wk = worker()
    const listed = await call(wk, 'GET', '/api/v1/action-requests')
    expect(listed.status).toBe(200)
    const proposed = await call(wk, 'POST', '/api/v1/action-requests', {
      operation: `${PROJECTS_KEY}.create`,
      arguments: { name: 'Proposed' },
      reason: 'a client asked',
    })
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
    const approved = await call(wk, 'POST', `/api/v1/action-requests/${proposed.body.id}/approve`)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect((await call(wk, 'GET', `/api/v1/action-requests/${proposed.body.id}`)).body.status).toBe('executed')
    expect(await rows(`select name from "${PROJECTS_KEY}"`)).toEqual([{ name: 'Proposed' }])
    expect(await rows(`select type from events where type like '${PROJECTS_KEY}.%'`)).toEqual([
      { type: `${PROJECTS_KEY}.created` },
    ])
  })
})

describe('the rail registry knows the definitions too', () => {
  it('the per-minute tick dispatches a webhook for a custom object event', async () => {
    const wk = worker()
    const sub = await call(wk, 'POST', '/meta/v1/webhooks', {
      url: 'https://example.com/hook',
      event_types: [`${PROJECTS_KEY}.created`],
    })
    expect(sub.status, JSON.stringify(sub.body)).toBe(201)
    expect((await call(wk, 'POST', `/api/v1/${PROJECTS_KEY}`, { name: 'Hooked' })).status).toBe(201)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '* * * * *' })
    expect(await rows('select event_type from webhook_deliveries')).toEqual([{ event_type: `${PROJECTS_KEY}.created` }])
  })
})
