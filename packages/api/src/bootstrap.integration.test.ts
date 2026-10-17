import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { hashApiKey } from './auth/api-keys.js'
import { bootstrap } from './bootstrap.js'
import { createVaultRegistry } from './operations.js'
import { createApp } from './rest/app.js'

let db: Kysely<Database>
let owner: Kysely<Database>
const base = { organizationName: 'Acme', email: 'ori@example.test', agentName: 'dev' }

beforeAll(() => {
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
beforeEach(() => truncateAll(owner))

const app = () => createApp({ db: () => db })
const call = (key: string, method = 'GET', body?: unknown) =>
  app().request('/tasks', { method, headers: { authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined })

describe('bootstrap', () => {
  it('creates and authenticates', async () => {
    const r = await bootstrap(db, base)
    expect(r.key).toMatch(/^vk_/)
    const res = await call(r.key)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [], next_cursor: null })
    const m = await owner.selectFrom('memberships').selectAll().where('user_id', '=', r.userId).execute()
    expect(m).toMatchObject([{ organization_id: r.organizationId, role: 'owner' }])
    const agent = await owner.selectFrom('agents').selectAll().where('id', '=', r.agentId).executeTakeFirstOrThrow()
    expect(agent.scopes).toEqual(createVaultRegistry().declaredScopes())
    expect(agent.created_by).toBe(r.userId)
  })
  it('stores the key hashed', async () => {
    const r = await bootstrap(db, base)
    const row = await owner.selectFrom('api_keys').selectAll().where('id', '=', r.apiKeyId).executeTakeFirstOrThrow()
    expect(row.key_hash).toBe(await hashApiKey(r.key))
    expect(JSON.stringify(row)).not.toContain(r.key)
  })
  it('a re-run reuses the user', async () => {
    const r1 = await bootstrap(db, base)
    const r2 = await bootstrap(db, { ...base, organizationName: 'Beta' })
    expect(r2.userId).toBe(r1.userId)
    expect(r2.organizationId).not.toBe(r1.organizationId)
    expect(r2.key).not.toBe(r1.key)
    expect(await owner.selectFrom('users').selectAll().where('email', '=', base.email).execute()).toHaveLength(1)
  })
  it('honours explicit scopes', async () => {
    const r = await bootstrap(db, { ...base, scopes: ['tasks:read'] })
    expect((await call(r.key, 'POST', { title: 'x' })).status).toBe(403)
  })
  it('writes nothing on a bad scope', async () => {
    await expect(bootstrap(db, { ...base, scopes: ['tasks:delete'] })).rejects.toThrow('invalid scope')
    await expect(bootstrap(db, { ...base, scopes: ['widgets:read'] })).rejects.toThrow('unknown scope: widgets:read')
    expect(await owner.selectFrom('organizations').selectAll().execute()).toHaveLength(0)
  })
  it('emits no events', async () => {
    await bootstrap(db, base)
    expect(await owner.selectFrom('events').selectAll().execute()).toHaveLength(0)
  })
})
