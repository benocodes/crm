import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ForeignOrganizationError, execute, uuidv7 } from '@vibase/storage'
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
  engines = await openEngines(['postgres'])
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
