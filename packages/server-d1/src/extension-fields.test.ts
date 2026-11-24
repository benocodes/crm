import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { applyExtensions, type ExtendDeclarations, type Registry } from '@vibase/api'
import { bootstrapD1, NOW, openWorkerD1, type WorkerD1, composeD1Worker } from './test/kit.js'

// [[CORE559]] P1: the Worker's composition takes the validated `extend` as ONE dependency and hands it to every registry it builds (the app's and the rail's); with it the app serves the extension fields. Dormant: the entry
// passes none (CORE561 fills it from the attached file).
const EXTEND: ExtendDeclarations = {
  contacts: { tier__c: { kind: 'enum', values: ['gold', 'silver'] }, seats__c: { kind: 'integer' } },
  tasks: { tier__c: { kind: 'enum', values: ['gold', 'silver'] } },
}
let w: WorkerD1
let key: string
const BASE = 'https://w.test'
const CRED = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const FULL = [
  'contacts:read',
  'contacts:write',
  'tasks:read',
  'tasks:write',
  'contacts:request_approval',
  'action_requests:read',
]

const worker = (extend?: ExtendDeclarations, seen: Registry[] = []) =>
  composeD1Worker(
    { DB: w.d1, AUTH_PROVIDER: '', CREDENTIALS_KEY: CRED },
    {
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
      clock: () => NOW,
      newId: () => uuidv7(NOW),
      operations: (r) => void seen.push(r),
      ...(extend ? { extend } : {}),
    },
  )
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown) => {
  const res = await wk.fetch(
    new Request(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  w = await openWorkerD1()
  const r = await applyExtensions(w.d1, {}, EXTEND)
  expect(r.refused).toEqual([])
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

const hasField = (r: Registry, op: string, field: string) =>
  field in
  ((r.get(op) as unknown as { request: { body: { shape: Record<string, unknown> } } }).request.body.shape ?? {})

describe('the app serves the extension fields it was given', () => {
  it('REST: create, get, update and list carry them; an undeclared enum value is refused', async () => {
    const wk = worker(EXTEND)
    const made = await call(wk, 'POST', '/api/v1/contacts', { name: 'Jo', tier__c: 'gold', seats__c: 4 })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect((await call(wk, 'GET', `/api/v1/contacts/${made.body.id}`)).body).toMatchObject({
      tier__c: 'gold',
      seats__c: 4,
    })
    expect((await call(wk, 'PATCH', `/api/v1/contacts/${made.body.id}`, { seats__c: 5 })).body.seats__c).toBe(5)
    expect((await call(wk, 'GET', '/api/v1/contacts')).body.data[0].tier__c).toBe('gold')
    expect((await call(wk, 'POST', '/api/v1/contacts', { name: 'x', tier__c: 'bronze' })).status).toBe(400)
  })
  it('without an extend the Worker does not serve them', async () => {
    const wk = worker()
    expect((await call(wk, 'POST', '/api/v1/contacts', { name: 'Jo', tier__c: 'gold' })).status).toBe(400)
  })
})

describe('every registry the composition builds carries the extend', () => {
  it('the app registry and the rail registry both take the fields on contacts.create and tasks.create', async () => {
    const seen: Registry[] = []
    const wk = worker(EXTEND, seen)
    await call(wk, 'GET', '/api/v1/contacts') // builds the app
    await wk.scheduled({ cron: '* * * * *' }) // builds the rail
    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const r of seen) {
      expect(hasField(r, 'contacts.create', 'tier__c')).toBe(true)
      expect(hasField(r, 'tasks.create', 'tier__c')).toBe(true)
      expect(hasField(r, 'companies.create', 'tier__c')).toBe(false)
    }
  })
  it('a registry built with no extend carries none of them', async () => {
    const seen: Registry[] = []
    const wk = worker(undefined, seen)
    await call(wk, 'GET', '/api/v1/contacts')
    await wk.scheduled({ cron: '* * * * *' })
    for (const r of seen) expect(hasField(r, 'contacts.create', 'tier__c')).toBe(false)
  })
})

describe('a proposal is approved and stores the value', () => {
  it('proposes contacts.update with an extension field, approves it, and the row holds it', async () => {
    const wk = worker(EXTEND)
    const made = await call(wk, 'POST', '/api/v1/contacts', { name: 'Jo' })
    const proposed = await call(wk, 'POST', '/api/v1/action-requests', {
      operation: 'contacts.update',
      arguments: { id: made.body.id, tier__c: 'silver' },
      reason: 'a client asked',
    })
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201)
    const approved = await call(wk, 'POST', `/api/v1/action-requests/${proposed.body.id}/approve`)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect((await call(wk, 'GET', `/api/v1/contacts/${made.body.id}`)).body.tier__c).toBe('silver')
  })
})
