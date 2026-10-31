import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ForeignOrganizationError, execute, uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { seedTenant } from '../test/tenant.js'
import { ApiError } from '../errors.js'
import { Registry } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { createOperation, getOperation, listOperation } from './crud.js'
import { openEngines, type Engine } from '../test/engines.js'

const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe('isolation on postgres: RLS and the vault_app role (invariants 1 and 2)', () => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === 'postgres')!
  })
  beforeEach(async () => {
    await e.reset()
  })

  it('an unwrapped vault_app query fails with 42501 and no preset role leaks in', async () => {
    const err = (await settle(e.app!.selectFrom('tasks').selectAll().execute())) as { code?: string }
    expect(err.code).toBe('42501')
    const settings = await sql<{ role: string; org: string | null }>`select current_user as role, nullif(current_setting('app.organization_id', true), '') as org`.execute(e.app!)
    expect(settings.rows[0]).toEqual({ role: 'vault_app', org: null })
  })

  it('another organisation sees nothing: wrong org with the right actor, and right org with the wrong actor', async () => {
    const created = (await e.run(createOperation(tasks, e.env(), { title: 'mine' }))).value
    const other = await seedTenant(e.app!, 'other')
    const foreignOrg = { kind: 'tenant' as const, actorId: e.userId, organizationId: other.organizationId }
    expect(await settle(execute(e.binding, foreignOrg, getOperation(tasks, { ...e.env(), organizationId: other.organizationId }, created.id)))).toMatchObject({ status: 404 })
    const list = await execute(e.binding, foreignOrg, listOperation(tasks, { ...e.env(), organizationId: other.organizationId }, {}))
    expect(list.value.data).toEqual([])
    // The caller's own org but another organisation's actor: RLS still scopes by the organisation.
    const wrongActor = await execute(e.binding, { kind: 'tenant', actorId: other.userId, organizationId: e.organizationId }, listOperation(tasks, e.env(), {}))
    expect(wrongActor.value.data.map((t) => t.id)).toEqual([created.id])
    // A principal of another organisation is not a valid assignee here (the reference is invisible).
    expect(await settle(e.run(createOperation(tasks, e.env(), { title: 'x', assignee_id: other.userId })))).toMatchObject({ code: 'invalid_reference' })
  })
})

describe('isolation on D1: one organisation per database (D18)', () => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === 'd1')!
  })
  beforeEach(async () => {
    await e.reset()
  })

  it('a binding for another organisation refuses before any SQL', async () => {
    const calls: string[] = []
    const spy: D1Like = {
      prepare: (q) => (calls.push(q), e.d1!.prepare(q)),
      batch: (s) => (calls.push('batch'), e.d1!.batch(s)),
    }
    const binding = d1Binding(spy, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId })
    const foreign = uuidv7()
    const err = await settle(execute(binding, { kind: 'tenant', actorId: e.userId, organizationId: foreign }, listOperation(tasks, { ...e.env(), organizationId: foreign }, {})))
    expect(err).toBeInstanceOf(ForeignOrganizationError)
    expect(calls).toEqual([])
  })

  it('through the app a token for another organisation is refused 403 and touches no data', async () => {
    const registry = new Registry().registerResource(tasks)
    const binding = d1Binding(e.d1!, { organizationId: e.organizationId, authProvider: e.authProvider, authOrgId: e.authOrgId })
    const app = createApp({ registry, userAuthenticator: fakeUserAuthenticator(), storage: () => binding })
    const token = mintTestUserToken({ userId: e.userId, organizationId: uuidv7(), scopes: ['tasks:read', 'tasks:write'] })
    const res = await app.request('/api/v1/tasks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('organization_forbidden')
  })

  it('the schema refuses a second organisation and any tenant row for it', async () => {
    const second = uuidv7()
    const fail = async (q: string, ...p: unknown[]) => String(((await settle(e.d1!.prepare(q).bind(...p).run())) as Error).message)
    expect(await fail("insert into organizations (id, created_at, updated_at, name) values (?, '2026-10-22T08:00:00.000Z', '2026-10-22T08:00:00.000Z', 'x')", second)).toMatch(/FOREIGN KEY/i)
    expect(
      await fail(
        "insert into tasks (id, organization_id, title, created_by, created_at, updated_at) values (?, ?, 't', ?, '2026-10-22T08:00:00.000Z', '2026-10-22T08:00:00.000Z')",
        uuidv7(),
        second,
        e.userId,
      ),
    ).toMatch(/FOREIGN KEY/i)
  })

  it('the storage identity comes only from the trusted context: a foreign ApiError is never produced by request input', async () => {
    const err = await settle(e.run(getOperation(tasks, e.env(), uuidv7())))
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
  })
})
