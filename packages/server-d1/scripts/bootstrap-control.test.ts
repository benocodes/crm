// OPS279: `bootstrap --remote` writes the control marker after the CRM row when the env binds `CONTROL_DB` ([[CORE259]] D7, P1), refuses a marker for
// another organisation before any write; an env with no `CONTROL_DB` is refused (CORE326 P4, in runRemoteGuards). Local bootstrap pairs in every mode (CORE326 P6).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execute } from '@vibase/storage'
import { d1Binding, openControlDb, readControlMarker, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { initDeploymentOperation, readDeployment } from '../src/init-deployment.js'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { runBootstrap, type BootstrapIo } from './bootstrap.js'
import type { Target } from './remote.js'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
afterEach(async () => {
  await pair.reset()
})

const OTHER = '0192f0a0-0000-7000-8000-0000000000aa'
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const CTL_UUID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const withControl: Target = {
  env: 'demo',
  workerName: 'vb-demo',
  databaseName: 'vb-crm-demo',
  databaseId: UUID,
  control: { databaseName: 'vb-control-demo', databaseId: CTL_UUID },
}

function io(): BootstrapIo & { logs: string[]; errors: string[]; env: { text: string } } {
  const state = { text: '' }
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    env: state,
    log: (l) => void logs.push(l),
    error: (l) => void errors.push(l),
    readEnvText: () => state.text,
    writeEnvText: (t) => void (state.text = t),
  }
}
const values = { org: 'demo', agent: 'op', email: 'owner@example.com', 'auth-provider': 'none', 'auth-org-id': 'demo' }
const remote = (target: Target, extra: Partial<typeof values> = {}) => ({
  mode: 'remote' as const,
  keyEnv: 'OP_KEY',
  values: { ...values, ...extra },
  authOrgId: 'demo',
  target,
})
const controlRows = async () =>
  JSON.stringify((await pair.control.prepare('select * from control_deployment').all()).results)

describe('bootstrap --remote with CONTROL_DB bound', () => {
  it('writes the control marker after the CRM row, naming the same organisation', async () => {
    const order: string[] = []
    const spy: D1Like = {
      prepare: (q) => {
        if (/insert into control_deployment/i.test(q)) order.push('marker')
        return pair.control.prepare(q)
      },
      batch: (s) => pair.control.batch(s),
    }
    const crm: D1Like = {
      prepare: (q) => pair.d1.prepare(q),
      batch: async (s) => {
        const r = await pair.d1.batch(s)
        if (s.length > 1) order.push('crm')
        return r
      },
    }
    const i = io()
    expect(await runBootstrap(remote(withControl), { env: { DB: crm, CONTROL_DB: spy } }, i)).toBe(0)
    expect(await readControlMarker(openControlDb(pair.control))).toEqual({
      organizationId: (await readDeployment(pair.d1))!.organizationId,
    })
    expect(order.lastIndexOf('marker')).toBeGreaterThan(order.indexOf('crm'))
    expect(i.logs.join('\n')).not.toContain('control plane: not configured')
    expect(i.env.text).toMatch(/^OP_KEY=/m)
  })

  it('is idempotent for the marker: a CRM row without a control marker gets one, and a second run changes nothing in the control database', async () => {
    const link = { organizationId: '0192f0a0-0000-7000-8000-000000000001', authProvider: 'none', authOrgId: 'demo' }
    await execute(
      d1Binding(pair.d1, link),
      { kind: 'internal', organizationId: link.organizationId },
      initDeploymentOperation(link),
    )
    const first = io()
    await runBootstrap(remote(withControl), { env: { DB: pair.d1, CONTROL_DB: pair.control } }, first)
    expect(await readControlMarker(openControlDb(pair.control))).toEqual({ organizationId: link.organizationId })
    const before = await controlRows()
    const second = io()
    await runBootstrap(remote(withControl), { env: { DB: pair.d1, CONTROL_DB: pair.control } }, second)
    expect(await controlRows()).toBe(before)
  })

  it('a control marker for another organisation is refused before any write: no CRM row, no key, exit 1', async () => {
    await writeControlMarker(openControlDb(pair.control), OTHER)
    const i = io()
    expect(await runBootstrap(remote(withControl), { env: { DB: pair.d1, CONTROL_DB: pair.control } }, i)).toBe(1)
    expect(i.errors.join('\n')).toContain(OTHER)
    expect(await readDeployment(pair.d1)).toBeNull()
    expect(i.env.text).toBe('')
  })
})

describe('bootstrap --remote without CONTROL_DB, and local bootstrap', () => {
  it('a remote env that binds CONTROL_DB but whose proxy has none is refused before any write', async () => {
    const i = io()
    expect(await runBootstrap(remote(withControl), { env: { DB: pair.d1 } }, i)).toBe(1)
    expect(await readDeployment(pair.d1)).toBeNull()
  })

  it('a local env with no control database is refused with neither database written ([[CORE326]] P6)', async () => {
    for (const provider of ['none', 'clerk']) {
      const i = io()
      const v = provider === 'none' ? values : { ...values, 'auth-provider': 'clerk' }
      expect(await runBootstrap({ mode: 'local', values: v, authOrgId: 'demo' }, { env: { DB: pair.d1 } }, i)).toBe(1)
      expect(i.errors.join('\n')).toMatch(/CONTROL_DB/)
      expect(await readDeployment(pair.d1)).toBeNull()
      expect(await controlRows()).toBe('[]')
    }
  })

  it('local bootstrap pairs the control marker in every mode: none and the Clerk issuer path, and a re-run leaves the control database unchanged ([[CORE326]] P6)', async () => {
    for (const provider of ['none', 'clerk'] as const) {
      await pair.reset()
      const v =
        provider === 'none'
          ? values
          : { org: 'demo', 'auth-provider': 'clerk', 'auth-org-id': 'https://clerk.example.com' }
      const run = { mode: 'local' as const, values: v as never, authOrgId: v['auth-org-id'] }
      expect(await runBootstrap(run, { env: { DB: pair.d1, CONTROL_DB: pair.control } }, io())).toBe(0)
      const marker = { organizationId: (await readDeployment(pair.d1))!.organizationId }
      expect(await readControlMarker(openControlDb(pair.control))).toEqual(marker)
      const before = await controlRows()
      // A second run is refused by the CRM side (already initialised) and leaves the control database as it was.
      await runBootstrap(run, { env: { DB: pair.d1, CONTROL_DB: pair.control } }, io())
      expect(await controlRows()).toBe(before)
    }
  })

  it('a marker for another organisation is refused locally with no CRM row written ([[CORE326]] P6)', async () => {
    await writeControlMarker(openControlDb(pair.control), OTHER)
    const i = io()
    expect(
      await runBootstrap(
        { mode: 'local', values: { ...values, 'auth-provider': 'clerk' } as never, authOrgId: 'demo' },
        { env: { DB: pair.d1, CONTROL_DB: pair.control } },
        i,
      ),
    ).toBe(1)
    expect(await readDeployment(pair.d1)).toBeNull()
  })

  it('local bootstrap is unchanged: the control marker is written when the local env binds CONTROL_DB, with no not-configured line', async () => {
    const i = io()
    expect(
      await runBootstrap(
        { mode: 'local', values, authOrgId: 'demo' },
        { env: { DB: pair.d1, CONTROL_DB: pair.control } },
        i,
      ),
    ).toBe(0)
    expect(await readControlMarker(openControlDb(pair.control))).toEqual({
      organizationId: (await readDeployment(pair.d1))!.organizationId,
    })
    expect(i.logs.join('\n')).not.toContain('control plane')
    expect(i.logs.join('\n')).toMatch(/api_key: +vk_/)
  })
})
