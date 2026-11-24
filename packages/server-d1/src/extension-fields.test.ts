import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { seedAgent } from '@vibase/storage-d1/test/seed'
import { fakeR2Bucket } from '@vibase/api/test/objects'
import { nodeStreams } from '@vibase/api/test/streams'
import { readDeployment } from './init-deployment.js'
import { applyExtensions, type ExtendDeclarations, type Registry } from '@vibase/api'
import { bootstrapD1, NOW, openWorkerD1, type WorkerD1, composeD1Worker } from './test/kit.js'

// [[CORE559]] P1: the Worker's composition takes the validated `extend` as ONE dependency and hands it to every registry it builds (the app's and the rail's); with it the app serves the extension fields. The entry passes the attached file's `extend` ([[CORE561]]); these tests pass it directly.
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

// [[CORE559]] P2: the capture paths take the composed set from the composition, not a default: a form submission through the Worker (the mail-sync pipeline is in compose-sync.test.ts).
describe('a form submission through the composed Worker', () => {
  const DEFAULTED: ExtendDeclarations = {
    contacts: { lvl__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' } },
  }
  const ORIGIN = 'https://site.test'
  const submit = async (extend?: ExtendDeclarations) => {
    const r = await applyExtensions(w.d1, {}, DEFAULTED)
    expect(r.refused).toEqual([])
    const org = (await readDeployment(w.d1))!.organizationId
    const at = NOW.toISOString()
    const id = '0190b2c4-0000-7000-8000-0000000f0001'
    await seedAgent(w.d1, { id, organizationId: org, createdBy: id, name: 'Form' })
    await w.d1
      .prepare(
        `insert into forms (id, created_at, updated_at, organization_id, created_by, name, public_id, enabled, email_field, name_field) values (?, ?, ?, ?, ?, 'Site', 'frm_aaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'email', 'name')`,
      )
      .bind(id, at, at, org, id)
      .run()
    await w.d1
      .prepare(
        'insert into form_allowed_origins (id, organization_id, form_id, origin, created_at) values (?, ?, ?, ?, ?)',
      )
      .bind('0190b2c4-0000-7000-8000-0000000e0001', org, id, ORIGIN, at)
      .run()
    const wk = composeD1Worker(
      {
        DB: w.d1,
        AUTH_PROVIDER: '',
        CREDENTIALS_KEY: CRED,
        BODIES: fakeR2Bucket(),
        TURNSTILE_SECRET_KEY: 'secret',
      } as never,
      {
        fetch: (async () => Response.json({ success: true, hostname: 'site.test' })) as unknown as typeof fetch,
        clock: () => NOW,
        newId: () => uuidv7(NOW),
        streams: nodeStreams(),
        ...(extend ? { extend } : {}),
      },
    )
    const res = await wk.fetch(
      new Request(`${BASE}/f/frm_aaaaaaaaaaaaaaaaaaaaaaaaaa`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': '198.51.100.9',
        },
        body: new URLSearchParams({ email: 'ada@example.com', name: 'Ada', 'cf-turnstile-response': 'tok' }).toString(),
      }),
    )
    expect(res.status, await res.clone().text()).toBe(202)
    const ev = (await w.d1.prepare(`select after from events where type = 'contact.created'`).all()).results as Array<{
      after: string
    }>
    return JSON.parse(ev[0]!.after)
  }
  it('with an extend, contact.created carries the defaulted extension field', async () => {
    expect(await submit(DEFAULTED)).toMatchObject({ name: 'Ada', lvl__c: 'a' })
  })
  it('with no extend it is the core record', async () => {
    expect(await submit()).not.toHaveProperty('lvl__c')
  })
})
