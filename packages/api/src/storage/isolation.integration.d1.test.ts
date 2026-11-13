import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'vitest'
import { ForeignOrganizationError, execute, uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like } from '@vibase/storage-d1'
import { ApiError } from '../errors.js'
import { Registry } from '../registry.js'
import { tasks } from '../resources/tasks.js'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { getOperation, listOperation } from './crud.js'
import { openEngines, type Engine } from '../test/engines.js'

const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines(['d1'])
})
afterAll(async () => {
  for (const e of engines) await e.close()
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
