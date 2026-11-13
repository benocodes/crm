import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openApiPath } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { CONTROL_MIGRATIONS, MIGRATIONS, openControlDb, readControlMarker, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { createMigrationTracker, openLocalD1, recordMigrations, type LocalD1 } from '@vibase/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, MIGRATIONS_PENDING, NOT_INITIALISED, type D1WorkerEnv } from './compose.js'
import { NOW, clerkKit, openWorkerPair, spyD1, type WorkerPair } from './test/kit.js'

// [[CORE259]] D6, D7: the Worker's fail-closed gate on the control-plane database. Provider x control state, every row asserted by status, exact envelope and, where the spec names it, the log line.
const BASE = 'http://localhost:8787'
const INTERNAL = { error: { code: 'internal', message: 'internal error' } }
const OTHER_ORG = '0190b2c4-0000-7000-8000-00000000a0aa'
const SECRET = 'test-auth-secret-0123456789-abcdefghij-klmnop'

let w: WorkerPair
let bare: LocalD1
let orgId: string
let errors: ReturnType<typeof vi.spyOn>
beforeAll(async () => {
  w = await openWorkerPair()
  bare = await openLocalD1(['U'], { migrate: false })
})
afterAll(async () => {
  await w.dispose()
  await bare.dispose()
})
beforeEach(async () => {
  await w.reset()
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  // The CRM database is migrated, tracked and bootstrapped in every row: only the control plane varies.
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', email: 'o@x.test', agentName: 'bot', authOrgId: 'org_acme', authProvider: 'none' }, { now: NOW, newId: () => uuidv7(NOW) })
  orgId = r.organizationId
})
afterEach(() => errors.mockRestore())

type Provider = 'better-auth' | 'clerk' | 'unset'
type Control = 'absent' | 'unmigrated' | 'no marker' | 'other organisation' | 'paired'
const PROVIDERS: Provider[] = ['better-auth', 'clerk', 'unset']
const CONTROLS: Control[] = ['absent', 'unmigrated', 'no marker', 'other organisation', 'paired']

async function envFor(provider: Provider, control: Control): Promise<D1WorkerEnv> {
  const env: D1WorkerEnv = { DB: w.d1 }
  if (provider === 'better-auth') Object.assign(env, { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE })
  else if (provider === 'clerk') Object.assign(env, (await clerkKit()).env)
  else env.AUTH_PROVIDER = ''
  if (control === 'absent') return env
  if (control === 'unmigrated') return { ...env, CONTROL_DB: bare.bindings.U! }
  if (control === 'other organisation') await writeControlMarker(openControlDb(w.control), OTHER_ORG)
  if (control === 'paired') await writeControlMarker(openControlDb(w.control), orgId)
  return { ...env, CONTROL_DB: w.control }
}

const call = (worker: { fetch(r: Request): Promise<Response> }, path: string) => worker.fetch(new Request(BASE + path))
const logged = () => errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')

describe('the control gate matrix (D6, D7)', () => {
  const refusal: Record<Exclude<Control, 'paired'>, { status: number; body: unknown; log: RegExp }> = {
    absent: { status: 500, body: INTERNAL, log: /CONTROL_DB/ },
    unmigrated: { status: 503, body: MIGRATIONS_PENDING, log: /^$/ },
    'no marker': { status: 500, body: INTERNAL, log: /control database not paired/ },
    'other organisation': { status: 500, body: INTERNAL, log: /control database not paired/ },
  }

  for (const control of CONTROLS) {
    it(`better-auth with the control database ${control}: ${control === 'paired' ? 'served' : `${refusal[control].status} on every non-health request`}, /health 200`, async () => {
      const worker = composeD1Worker(await envFor('better-auth', control))
      const health = await call(worker, '/health')
      expect(health.status).toBe(200)
      for (const path of ['/api/v1/contacts', '/auth/ok', '/meta/v1/schema']) {
        const res = await call(worker, path)
        if (control === 'paired') {
          expect(res.status, path).not.toBe(500)
          expect(res.status, path).not.toBe(503)
          continue
        }
        const want = refusal[control]
        expect(res.status, `${control} ${path}`).toBe(want.status)
        expect(await res.json(), `${control} ${path}`).toEqual(want.body)
      }
      expect(logged()).toMatch(control === 'paired' ? /^$/ : refusal[control].log)
      if (control === 'paired') {
        expect((await call(worker, '/auth/ok')).status).toBe(200)
        expect((await call(worker, '/api/v1/contacts')).status).toBe(401)
      }
    })
  }

  for (const provider of ['clerk', 'unset'] as const) {
    for (const control of CONTROLS) {
      it(`${provider} with the control database ${control}: served as without it (CONTROL_DB is never read)`, async () => {
        const env = await envFor(provider, control)
        // A control binding that throws on any touch: if the Worker read it, the request would not be served.
        const touched: string[] = []
        const trap = { prepare: (q: string) => (touched.push(q), (() => { throw new Error('CONTROL_DB was read') })()), batch: () => { throw new Error('CONTROL_DB was read') } } as unknown as D1Like
        const worker = composeD1Worker(env.CONTROL_DB ? { ...env, CONTROL_DB: trap } : env)
        expect((await call(worker, '/health')).status).toBe(200)
        const res = await call(worker, '/api/v1/contacts')
        expect(res.status).toBe(401)
        expect(touched).toEqual([])
        expect(logged()).not.toMatch(/CONTROL_DB|control database/)
      })
    }
  }

  it('the OpenAPI documents stay exempt from the control gate, as they are from the CRM migration and marker gates', async () => {
    const worker = composeD1Worker(await envFor('better-auth', 'no marker'))
    for (const path of [openApiPath('api'), openApiPath('meta')]) expect((await call(worker, path)).status, path).toBe(200)
  })

  it('CRM not initialised: 503 not_initialised (nothing to pair with yet), not the not-paired 500', async () => {
    const fresh = await openLocalD1(['F'])
    try {
      const env = { ...(await envFor('better-auth', 'no marker')), DB: fresh.bindings.F! }
      const worker = composeD1Worker(env)
      for (const path of ['/auth/ok', '/api/v1/contacts']) {
        const res = await call(worker, path)
        expect(res.status, path).toBe(503)
        expect(await res.json(), path).toEqual(NOT_INITIALISED)
      }
    } finally {
      await fresh.dispose()
    }
  })

  it('a pending control migration (tracker behind the shipped set) is 503 migrations_pending, and is re-read: applying it lets the next request through', async () => {
    await writeControlMarker(openControlDb(w.control), orgId)
    await w.control.prepare('delete from d1_migrations').run()
    let now = 1_000_000
    const worker = composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE }, { nowMs: () => now })
    const res = await call(worker, '/auth/ok')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(MIGRATIONS_PENDING)
    await recordMigrations(w.control, CONTROL_MIGRATIONS.map((m) => m.name))
    now += 6_000
    expect((await call(worker, '/auth/ok')).status).toBe(200)
  })

  it('a control tracker AHEAD of this build (a newer applied set) is served, as the CRM gate does', async () => {
    await writeControlMarker(openControlDb(w.control), orgId)
    await recordMigrations(w.control, ['9999_future.sql'])
    expect((await call(composeD1Worker(await envFor('better-auth', 'no marker')), '/auth/ok')).status).toBe(200)
  })
})

describe('the marker check and the per-isolate cache (D7, decision)', () => {
  it('a refusal is never cached: writing the marker lets the very next request through, without a new isolate', async () => {
    const worker = composeD1Worker(await envFor('better-auth', 'no marker'))
    expect((await call(worker, '/auth/ok')).status).toBe(500)
    await writeControlMarker(openControlDb(w.control), orgId)
    expect((await call(worker, '/auth/ok')).status).toBe(200)
  })

  it('a pairing that held is remembered for the isolate: the control marker is read once across requests', async () => {
    await writeControlMarker(openControlDb(w.control), orgId)
    const spy = spyD1(w.control)
    const worker = composeD1Worker({ DB: w.d1, CONTROL_DB: spy.d1, AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE })
    for (let i = 0; i < 3; i++) expect((await call(worker, '/auth/ok')).status).toBe(200)
    expect(spy.log.statements.filter((s) => /control_deployment/.test(s))).toHaveLength(1)
    expect(await readControlMarker(openControlDb(w.control))).toEqual({ organizationId: orgId })
  })
})
