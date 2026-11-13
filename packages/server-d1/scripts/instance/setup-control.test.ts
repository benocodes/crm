// OPS279 (`vibase-server setup`): the control database `vb-control-<env>` is derived, created, recorded as `control_d1`, migrated before the CRM database and
// paired by the control marker ([[CORE259]] D7, D9, D14, D16; [[OPS276]] P3 extended, P4). `setup:remote`'s side is scripts/setup/control-database.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openControlDb, readControlMarker, writeControlMarker } from '@vibase/storage-d1'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { readDeployment } from '../../src/init-deployment.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { ALL_MIGRATIONS, NONE_ARGS, readMarker, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_D1, CONTROL_UUID, UUID, cleanup, controlSettings, validSettings } from './test-kit.js'

let d1: WorkerD1
beforeAll(async () => { d1 = await openWorkerD1() }, 60_000)
afterAll(async () => { await d1.dispose() })
afterEach(async () => { cleanup(); await d1.reset() })

const OTHER = '0192f0a0-0000-7000-8000-0000000000aa'
const CRM_ID = '00000000-1111-4222-8333-000000000001'
const CTL_ID = '00000000-1111-4222-8333-000000000002'
const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld => setupWorld({ d1, ...o })
const run = (s: SetupWorld, argv: string[] = NONE_ARGS) => runSetup(argv, s.w.deps)
const creates = (s: SetupWorld) => s.writes().filter((a) => a[0] === 'd1' && a[1] === 'create').map((a) => a[2]!)
const applies = (s: SetupWorld) => s.writes().filter((a) => a[1] === 'migrations').map((a) => a[3])
const control = (s: SetupWorld) => openControlDb(s.control)
const MARKER = { organization_id: 'org-1', auth_provider: 'none', auth_org_id: 'demo', organizations: 1 }
const HEALTHY = { version: 'a'.repeat(40), commit: null }
const crmOnly = () => ({ d1s: [{ uuid: UUID, name: 'vault-demo' }], r2s: ['vault-demo-bodies'] })

describe('derive, create, record (matrix: no D1 of that name, D1 of that name exists, recorded)', () => {
  it('no D1 of that name: vb-control-<env> is created after the CRM database and recorded as control_d1 with the id from d1 list', async () => {
    const s = world()
    expect(await run(s)).toBe(0)
    expect(creates(s)).toEqual(['vb-crm-demo', 'vb-control-demo'])
    expect(JSON.parse(s.settings()!)).toMatchObject({ d1: { name: 'vb-crm-demo', id: CRM_ID }, control_d1: { name: 'vb-control-demo', id: CTL_ID } })
  })

  it('a D1 of that name on the account is adopted: no create, its id from d1 list', async () => {
    const s = world({ sim: { d1s: [{ uuid: CRM_ID, name: 'vb-crm-demo' }, { uuid: CTL_ID, name: 'vb-control-demo' }], r2s: ['vb-bodies-demo'] } })
    expect(await run(s)).toBe(0)
    expect(creates(s)).toEqual([])
    expect(JSON.parse(s.settings()!).control_d1).toEqual({ name: 'vb-control-demo', id: CTL_ID })
  })

  it('recorded: a re-run creates nothing and the settings file is untouched', async () => {
    const s = world({ settings: controlSettings(), sim: { d1s: [{ uuid: UUID, name: 'vault-demo' }, { uuid: CONTROL_UUID, name: CONTROL_D1.name }], r2s: ['vault-demo-bodies'], applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL], marker: MARKER, deployed: HEALTHY } })
    const before = s.settings()
    expect(await run(s)).toBe(0)
    expect(creates(s)).toEqual([])
    expect(s.settings()).toBe(before)
  })

  it('--control-d1-name wins on a new instance', async () => {
    const s = world()
    expect(await run(s, [...NONE_ARGS, '--control-d1-name', 'ctl-x'])).toBe(0)
    expect(creates(s)).toEqual(['vb-crm-demo', 'ctl-x'])
    expect(JSON.parse(s.settings()!).control_d1).toEqual({ name: 'ctl-x', id: CTL_ID })
  })

  it.each([
    ['a control name over 63 characters', [...NONE_ARGS, '--control-d1-name', 'a'.repeat(64)], /63/],
    ['a control name equal to the derived CRM name', [...NONE_ARGS, '--control-d1-name', 'vb-crm-demo'], /own database|differ/],
    ['both D1 names given and equal', [...NONE_ARGS, '--d1-name', 'same', '--control-d1-name', 'same'], /own database|differ/],
  ])('refuses %s before any call (exit 2)', async (_n, argv, message) => {
    const s = world()
    expect(await run(s, argv)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(message)
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.w.fetchUrls).toEqual([])
  })

  it('refuses a derived control name over 63 characters before any call', async () => {
    const s = world()
    expect(await run(s, ['--env', 'a'.repeat(52), '--api-host', 'api.demo.invalid', '--auth', 'none'])).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/63/)
    expect(s.w.wrangler).toHaveLength(0)
  })
})

describe('the recorded control name wins, and a disagreeing flag is refused (P3 extended, P4)', () => {
  const recorded = () => world({ settings: controlSettings(), sim: { d1s: [{ uuid: UUID, name: 'vault-demo' }, { uuid: CONTROL_UUID, name: CONTROL_D1.name }], r2s: ['vault-demo-bodies'], applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL], marker: MARKER, deployed: HEALTHY } })

  it('a re-run with a recorded control database uses it with no --control-d1-name: every generated config binds the recorded name and id', async () => {
    const s = recorded()
    expect(await run(s)).toBe(0)
    const cfgs = s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
    expect(cfgs.length).toBeGreaterThan(0)
    for (const c of cfgs) expect(c.d1_databases.find((d: { binding: string }) => d.binding === 'CONTROL_DB')).toMatchObject({ database_name: CONTROL_D1.name, database_id: CONTROL_UUID })
  })

  it.each([[[]], [['--dry-run']]])('a disagreeing --control-d1-name %j exits 2 before any call, naming the recorded value', async (extra) => {
    const s = recorded()
    const before = s.settings()
    expect(await run(s, [...NONE_ARGS, '--control-d1-name', 'another', ...extra])).toBe(2)
    expect(s.w.err.join('\n')).toContain(CONTROL_D1.name)
    expect(s.w.err.join('\n')).toContain('--control-d1-name')
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.settings()).toBe(before)
  })

  it('a flag equal to the record runs', async () => {
    const s = recorded()
    expect(await run(s, [...NONE_ARGS, '--control-d1-name', CONTROL_D1.name])).toBe(0)
  })

  it('P4: a recorded vault-<env> CRM database and no control database gets vb-control-<env> created and recorded, every CRM name as recorded', async () => {
    const s = world({ settings: validSettings(), sim: { ...crmOnly(), applied: [...ALL_MIGRATIONS], marker: MARKER, deployed: HEALTHY } })
    expect(await run(s)).toBe(0)
    expect(creates(s)).toEqual(['vb-control-demo'])
    const saved = JSON.parse(s.settings()!)
    expect(saved).toMatchObject({ worker: 'vault-demo', d1: { name: 'vault-demo', id: UUID }, r2_bucket: 'vault-demo-bodies', workflow: { name: 'vault-demo-mail-sync' }, control_d1: { name: 'vb-control-demo', id: '00000000-1111-4222-8333-000000000002' } })
  })

  it('P4 --dry-run: nothing is created and the settings file is untouched', async () => {
    const s = world({ settings: validSettings(), sim: { ...crmOnly(), applied: [...ALL_MIGRATIONS], marker: MARKER, deployed: HEALTHY } })
    const before = s.settings()
    expect(await run(s, [...NONE_ARGS, '--dry-run'])).toBe(0)
    expect(s.writes()).toEqual([])
    expect(s.settings()).toBe(before)
  })
})

describe('migrate control first, then CRM (D14)', () => {
  it('the migration calls run control first, then CRM, and both databases end current', async () => {
    const s = world()
    expect(await run(s)).toBe(0)
    expect(applies(s)).toEqual(['CONTROL_DB', 'DB'])
    expect(s.sim.controlApplied).toEqual(CONTROL_ALL)
    expect(s.sim.applied).toEqual(ALL_MIGRATIONS)
    const out = s.w.out.join('\n')
    expect(out.indexOf('[control]')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('[control]')).toBeLessThan(out.indexOf('[crm]'))
  })

  it('a failing control migration leaves the CRM database unmigrated and nothing deployed (exit 3)', async () => {
    const s = world({ sim: { failControlApply: true } })
    expect(await run(s)).toBe(3)
    expect(applies(s)).toEqual(['CONTROL_DB'])
    expect(s.sim.applied).toBeNull()
    expect(s.sim.deployed).toBeNull()
    expect(s.rows().find((r) => r.step === 'migrate')!.status).toBe('fail')
  })

  it('a control database ahead of the build fails before any migration is applied or anything is deployed', async () => {
    const s = world({ sim: { controlApplied: [...CONTROL_ALL, '9999_from_a_newer_build.sql'] } })
    expect(await run(s)).toBe(3)
    expect(applies(s)).toEqual([])
    expect(s.sim.applied).toBeNull()
    expect(s.sim.deployed).toBeNull()
  })

  it('--dry-run lists both databases, control first, and applies nothing', async () => {
    const s = world({ settings: controlSettings(), sim: { d1s: [{ uuid: UUID, name: 'vault-demo' }, { uuid: CONTROL_UUID, name: CONTROL_D1.name }], r2s: ['vault-demo-bodies'] } })
    expect(await run(s, [...NONE_ARGS, '--dry-run'])).toBe(0)
    expect(s.writes()).toEqual([])
    const out = s.w.out.join('\n')
    expect(out.indexOf('[control]')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('[control]')).toBeLessThan(out.indexOf('[crm]'))
    const reads = s.w.wrangler.filter((c) => c.args.some((a) => a.includes('d1_migrations')))
    expect(reads[0]!.args).toContain('CONTROL_DB')
  })
})

describe('the control marker in the bootstrap step (D7, D9)', () => {
  const ready = async () => world({ settings: controlSettings(), sim: { d1s: [{ uuid: UUID, name: 'vault-demo' }, { uuid: CONTROL_UUID, name: CONTROL_D1.name }], r2s: ['vault-demo-bodies'], applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL], marker: await readMarker(d1.d1) } })
  const legacyBootstrap = () => bootstrapD1(d1.d1, { organizationName: 'demo', authProvider: 'none', authOrgId: 'demo', email: 'owner@example.com', agentName: 'op' })

  it('fresh instance, marker only: the control marker follows the CRM deployment row and names its organisation', async () => {
    const order: string[] = []
    const s = world({ onControlInsert: async () => void order.push((await readDeployment(d1.d1)) ? 'crm row present' : 'crm row absent') })
    expect(await run(s)).toBe(0)
    expect(order).toEqual(['crm row present'])
    expect(await readControlMarker(control(s))).toEqual({ organizationId: (await readDeployment(d1.d1))!.organizationId })
  })

  it('fresh instance with an operator agent: the control marker is written too', async () => {
    const s = world()
    expect(await run(s, [...NONE_ARGS, '--operator-agent', 'op', '--key-env', 'OP_KEY', '--owner-email', 'owner@example.com'])).toBe(0)
    expect(await readControlMarker(control(s))).toEqual({ organizationId: (await readDeployment(d1.d1))!.organizationId })
  })

  it('an instance bootstrapped before this cycle (CRM row present, control marker missing) gets the marker, and a second run is ok with no write', async () => {
    await legacyBootstrap()
    const s = await ready()
    expect(await run(s)).toBe(0)
    expect(s.rows().find((r) => r.step === 'bootstrap')!.status).toBe('create')
    expect(await readControlMarker(control(s))).toEqual({ organizationId: (await readDeployment(d1.d1))!.organizationId })
    const inserts = s.control.inserts.length
    s.w.out.length = 0
    expect(await run(s)).toBe(0)
    expect(s.rows().find((r) => r.step === 'bootstrap')!.status).toBe('ok')
    expect(s.control.inserts.length).toBe(inserts)
  })

  it('a failing CRM write leaves no control marker', async () => {
    const failing = { ...d1, d1: { prepare: (q: string) => d1.d1.prepare(q), batch: async () => Promise.reject(new Error('crm write failed')) } } as unknown as WorkerD1
    const s = world({ d1: failing })
    expect(await run(s)).toBe(3)
    expect(await readControlMarker(control(s))).toBeNull()
  })

  it('a control marker for another organisation is refused with neither database written', async () => {
    const s = world()
    await writeControlMarker(control(s), OTHER)
    expect(await run(s)).toBe(3)
    expect(s.rows().find((r) => r.step === 'bootstrap')!.status).toBe('fail')
    expect(s.w.err.join('\n')).toContain(OTHER)
    expect(await readDeployment(d1.d1)).toBeNull()
    expect(await readControlMarker(control(s))).toEqual({ organizationId: OTHER })
  })

  it('a control marker naming another organisation than the CRM row is refused (CRM row present)', async () => {
    await legacyBootstrap()
    const s = await ready()
    await writeControlMarker(control(s), OTHER)
    expect(await run(s)).toBe(3)
    expect(await readControlMarker(control(s))).toEqual({ organizationId: OTHER })
  })

  it('--dry-run reports the control marker it would write and writes nothing', async () => {
    await legacyBootstrap()
    const s = await ready()
    expect(await run(s, [...NONE_ARGS, '--dry-run'])).toBe(0)
    const row = s.rows().find((r) => r.step === 'bootstrap')!
    expect(row.status).toBe('create')
    expect(row.detail).toMatch(/control/)
    expect(await readControlMarker(control(s))).toBeNull()
  })
})
