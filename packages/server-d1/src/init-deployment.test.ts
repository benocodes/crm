import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { UnitDriftError, execute } from '@vault/storage'
import { d1Binding } from '@vault/storage-d1'
import { initDeploymentOperation, readDeployment, type DeploymentLink } from './init-deployment.js'
import { openWorkerD1, spyD1, type WorkerD1 } from './test/kit.js'

const A: DeploymentLink = { organizationId: '0190b2c4-0000-7000-8000-00000000000a', authProvider: 'clerk', authOrgId: 'org_a' }
const B: DeploymentLink = { organizationId: '0190b2c4-0000-7000-8000-00000000000b', authProvider: 'clerk', authOrgId: 'org_b' }

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(() => w.reset())

const run = (d1: typeof w.d1, link: DeploymentLink) =>
  execute(d1Binding(d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
const markers = async () => (await w.d1.prepare('select singleton, organization_id, auth_provider, auth_org_id from deployment').all()).results as Array<Record<string, unknown>>

describe('initDeploymentOperation (P6)', () => {
  it('creates the marker', async () => {
    const r = await run(w.d1, A)
    expect(r.value).toBe('created')
    expect(await markers()).toEqual([{ singleton: 1, organization_id: A.organizationId, auth_provider: 'clerk', auth_org_id: 'org_a' }])
  })

  it('is idempotent: an equal marker is "existing" with zero statements', async () => {
    await run(w.d1, A)
    const r = await run(w.d1, A)
    expect(r.value).toBe('existing')
    expect(r.stats.writes).toBe(0)
    expect(await markers()).toHaveLength(1)
  })

  it.each([
    ['another organisation', B, 'organization_b'],
    ['the same id with another auth org', { ...A, authOrgId: 'org_other' }, 'same_id'],
  ])('refuses %s before any statement', async (_name, other) => {
    await run(w.d1, A)
    const spy = spyD1(w.d1)
    await expect(run(spy.d1, other)).rejects.toThrow(`deployment is already initialised for organization ${A.organizationId} (clerk:org_a)`)
    expect(spy.log.statements.filter((s) => /^\s*(insert|update|delete)/i.test(s))).toEqual([])
    expect(await markers()).toEqual([{ singleton: 1, organization_id: A.organizationId, auth_provider: 'clerk', auth_org_id: 'org_a' }])
  })

  it('a racing initialiser with other values drifts and the racer stands (D1)', async () => {
    const spy = spyD1(w.d1)
    spy.betweenPlanAndCommit(async () => {
      await w.d1.prepare('insert into deployment (singleton, organization_id, auth_provider, auth_org_id) values (1, ?, ?, ?)').bind(B.organizationId, B.authProvider, B.authOrgId).run()
    })
    await expect(run(spy.d1, A)).rejects.toBeInstanceOf(UnitDriftError)
    expect(await markers()).toEqual([{ singleton: 1, organization_id: B.organizationId, auth_provider: 'clerk', auth_org_id: 'org_b' }])
  })
})

describe('readDeployment', () => {
  it('is null when absent and the link when present', async () => {
    expect(await readDeployment(w.d1)).toBeNull()
    await run(w.d1, A)
    expect(await readDeployment(w.d1)).toEqual(A)
  })
})
