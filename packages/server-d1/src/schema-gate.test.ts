import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { MIGRATIONS } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// API63 under the CORE61 gate: GET /meta/v1/schema is an ordinary route, refused while the migrations are behind.
const NAMES = MIGRATIONS.map((m) => m.name)
let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
})
const boot = () => bootstrapD1(w.d1, { organizationName: 'Acme', email: 'owner@x.test', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
const schema = (key: string) => composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' }).fetch(new Request('https://w.test/meta/v1/schema', { headers: { authorization: `Bearer ${key}` } }))

describe('GET /meta/v1/schema in the Worker', () => {
  it('current: 200 with the default agent key (schema:read is agent-grantable, so bootstrap grants it)', async () => {
    const r = await boot()
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, NAMES)
    const res = await schema(r.key)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { engine: string }).engine).toBe('d1')
  })
  it('behind: 503 migrations_pending, before the operation runs', async () => {
    const r = await boot()
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, NAMES.slice(0, -1))
    const res = await schema(r.key)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'migrations_pending', message: 'apply the database migrations first' } })
  })
})
