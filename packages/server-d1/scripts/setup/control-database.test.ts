// OPS279 (`setup:remote`): the control database `vb-control-<env>` is derived, created, recorded, migrated before the CRM database and paired by the control
// marker ([[CORE259]] D7, D9, D14, D16; [[OPS276]] P3 extended, P4). The same obligations for `vibase-server setup` are in instance/setup-control.test.ts.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { readDeployment } from '../../src/init-deployment.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { openControlDb, readControlMarker, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { runSetup, type SetupOutcome } from './run.js'
import { CONTROL_EXPECTED, EXPECTED_MIGRATIONS, FIXTURE_CONFIG_PATH, makeWorld, memoryControl, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const ACME = ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai']
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const OTHER = '0192f0a0-0000-7000-8000-0000000000aa'
const CRM_ID = '00000000-1111-4222-8333-000000000001'
const CTL_ID = '00000000-1111-4222-8333-000000000002'

let db: WorkerD1
beforeAll(async () => {
  db = await openWorkerD1()
})
afterAll(async () => {
  await db.dispose()
})
beforeEach(async () => {
  await db.reset()
})

const world = (o: Partial<WorldOptions> = {}): World => makeWorld({ d1: db.d1, ...o })
const run = (w: World, argv: string[] = ACME) => runSetup(argv, CONFIRM, w.deps)
const calls = (w: World) => w.argv.map((c) => c.slice(2).join(' '))
const creates = (w: World) => w.argv.filter((c) => c.includes('d1') && c.includes('create')).map((c) => c[c.indexOf('create') + 1]!)
const block = (text: string, env = 'acme') => (parse(text) as { env: Record<string, any> }).env[env]
const bindingOf = (text: string, binding: string, env = 'acme') => block(text, env).d1_databases.find((d: { binding: string }) => d.binding === binding)
const rowOf = (o: SetupOutcome, step: string) => o.results.find((r) => r.step === step)!

/** The first run of a new instance: it creates the resources, writes the env block and stops ([[OPS65]] D10). */
async function firstRun(w: World, argv: string[] = ACME): Promise<void> {
  const o = await run(w, argv)
  expect(o.stoppedAfterConfigWrite).toBe(true)
}

describe('derive, create, record (matrix: no D1 of that name, D1 of that name exists, recorded)', () => {
  it('no D1 of that name: vb-control-<env> is created after the CRM database, its id is read from d1 list and recorded as CONTROL_DB', async () => {
    const w = world()
    await firstRun(w)
    expect(creates(w)).toEqual(['vb-crm-acme', 'vb-control-acme'])
    const control = bindingOf(w.state.configText, 'CONTROL_DB')
    expect(control).toMatchObject({ database_name: 'vb-control-acme', database_id: CTL_ID, migrations_dir: '../storage-d1/control-migrations', remote: true })
    expect(bindingOf(w.state.configText, 'DB')).toMatchObject({ database_name: 'vb-crm-acme', database_id: CRM_ID })
  })

  it('a D1 of that name on the account is adopted: no create, its id from d1 list', async () => {
    const w = world({ d1s: [{ uuid: CRM_ID, name: 'vb-crm-acme' }, { uuid: CTL_ID, name: 'vb-control-acme' }], r2s: ['vb-bodies-acme'] })
    await firstRun(w)
    expect(creates(w)).toEqual([])
    expect(bindingOf(w.state.configText, 'CONTROL_DB')).toMatchObject({ database_name: 'vb-control-acme', database_id: CTL_ID })
  })

  it('recorded: a re-run creates nothing and changes no record', async () => {
    const w = world()
    await firstRun(w)
    const recorded = w.state.configText
    const writes = w.state.configWrites
    w.argv.length = 0
    const o = await run(w)
    expect(o.stoppedAfterConfigWrite).toBe(false)
    expect(creates(w)).toEqual([])
    expect(w.state.configText).toBe(recorded)
    expect(w.state.configWrites).toBe(writes)
    expect(rowOf(o, 'config:write').status).toBe('ok')
  })

  it('--control-d1-name wins on a new instance', async () => {
    const w = world()
    await firstRun(w, [...ACME, '--control-d1-name', 'ctl-x'])
    expect(creates(w)).toEqual(['vb-crm-acme', 'ctl-x'])
    expect(bindingOf(w.state.configText, 'CONTROL_DB')).toMatchObject({ database_name: 'ctl-x', database_id: CTL_ID })
  })

  it.each([
    ['a control name over 63 characters', [...ACME, '--control-d1-name', 'a'.repeat(64)], /63/],
    ['a derived control name over 63 characters', ['--env', 'a'.repeat(52), '--auth', 'none', '--api-host', 'api.acme.vibase.ai'], /63/],
    ['a control name equal to the derived CRM name', [...ACME, '--control-d1-name', 'vb-crm-acme'], /own database|differ/],
    ['both D1 names given and equal', [...ACME, '--d1-name', 'same', '--control-d1-name', 'same'], /own database|differ/],
  ])('refuses %s before any call', async (_n, argv, message) => {
    const w = world()
    const o = await run(w, argv)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toMatch(message)
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })

  it('refuses a record whose CONTROL_DB has the CRM database\'s id, before any call', async () => {
    const w = world()
    await firstRun(w)
    let text = w.state.configText
    text = applyEdits(text, modify(text, ['env', 'acme', 'd1_databases', 1, 'database_id'], CRM_ID, {}))
    const w2 = world({ configText: text })
    const o = await run(w2)
    expect(o.exitCode).toBe(1)
    expect(w2.logs.join('\n')).toMatch(/own database|differ/)
    expect(w2.argv).toEqual([])
  })
})

describe('the recorded control name wins, and a disagreeing flag is refused (P3 extended, P4)', () => {
  async function recorded(): Promise<string> {
    const w = world()
    await firstRun(w, [...ACME, '--control-d1-name', 'ctl-recorded'])
    return w.state.configText
  }

  it('a re-run with a recorded control database uses it with no --control-d1-name', async () => {
    const text = await recorded()
    const w = world({ configText: text, d1s: [{ uuid: CRM_ID, name: 'vb-crm-acme' }, { uuid: CTL_ID, name: 'ctl-recorded' }], r2s: ['vb-bodies-acme'] })
    const o = await run(w)
    expect(o.exitCode).toBe(0)
    expect(creates(w)).toEqual([])
    expect(w.state.configText).toBe(text)
  })

  it.each([[[]], [['--dry-run']]])('a disagreeing --control-d1-name %j is refused before any wrangler call, naming the recorded value', async (extra) => {
    const text = await recorded()
    const w = world({ configText: text })
    const o = await runSetup([...ACME, '--control-d1-name', 'another', ...extra], extra.length ? {} : CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toContain('ctl-recorded')
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })

  it('P4: a recorded vault-<env> CRM database and no control database gets vb-control-<env> created and recorded, every CRM name as recorded', async () => {
    let text = fixture
    const legacy = {
      name: 'vault-acme',
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'api.acme.vibase.ai', custom_domain: true }],
      observability: { enabled: true },
      d1_databases: [{ binding: 'DB', database_name: 'vault-acme', database_id: CRM_ID, migrations_dir: '../storage-d1/migrations', remote: true }],
      r2_buckets: [{ binding: 'BODIES', bucket_name: 'vault-acme-bodies' }],
      vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' },
    }
    text = applyEdits(text, modify(text, ['env', 'acme'], legacy, {}))
    const w = world({ configText: text, d1s: [{ uuid: CRM_ID, name: 'vault-acme' }], r2s: ['vault-acme-bodies'] })
    const o = await run(w)
    expect(o.stoppedAfterConfigWrite).toBe(true)
    expect(creates(w)).toEqual(['vb-control-acme'])
    expect(bindingOf(w.state.configText, 'DB')).toMatchObject({ database_name: 'vault-acme', database_id: CRM_ID })
    expect(bindingOf(w.state.configText, 'CONTROL_DB')).toMatchObject({ database_name: 'vb-control-acme', database_id: '00000000-1111-4222-8333-000000000002' })
    expect(block(w.state.configText).name).toBe('vault-acme')
    expect(block(w.state.configText).r2_buckets[0].bucket_name).toBe('vault-acme-bodies')
  })
})

describe('migrate control first, then CRM (D14)', () => {
  const applies = (w: World) => w.argv.filter((c) => c.includes('apply')).map((c) => c[c.indexOf('apply') + 1])

  it('the migration calls run control first, then CRM, and both databases end current', async () => {
    const w = world()
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(0)
    expect(applies(w)).toEqual(['CONTROL_DB', 'DB'])
    const lines = rowOf(o, 'migrate').lines ?? []
    expect(lines.findIndex((l) => l.startsWith('[control]'))).toBeGreaterThanOrEqual(0)
    expect(lines.findIndex((l) => l.startsWith('[control]'))).toBeLessThan(lines.findIndex((l) => l.startsWith('[crm]')))
    expect(w.state.appliedControl).toEqual(CONTROL_EXPECTED)
    expect(w.state.applied).toEqual(EXPECTED_MIGRATIONS)
  })

  it('a failing control migration leaves the CRM database unmigrated and nothing deployed', async () => {
    const w = world({ failControlApply: true })
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(rowOf(o, 'migrate').status).toBe('fail')
    expect(applies(w)).toEqual(['CONTROL_DB'])
    expect(w.state.applied).toBeNull()
    expect(w.state.deployedSha).toBeNull()
    expect(o.results.map((r) => r.step)).not.toContain('deploy')
  })

  it('a control database ahead of the build fails before any migration is applied or anything is deployed', async () => {
    const w = world({ appliedControl: [...CONTROL_EXPECTED, '9999_from_a_newer_build.sql'] })
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(rowOf(o, 'migrate').status).toBe('fail')
    expect(applies(w)).toEqual([])
    expect(w.state.applied).toBeNull()
    expect(w.state.deployedSha).toBeNull()
  })

  it('--dry-run lists both databases, control first, and applies nothing', async () => {
    const w = world()
    await firstRun(w)
    w.argv.length = 0
    const o = await runSetup([...ACME, '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(0)
    expect(w.writes()).toEqual([])
    const row = rowOf(o, 'migrate')
    expect(row.status).toBe('update')
    const lines = row.lines ?? []
    expect(lines.findIndex((l) => l.startsWith('[control]'))).toBeGreaterThanOrEqual(0)
    expect(lines.findIndex((l) => l.startsWith('[control]'))).toBeLessThan(lines.findIndex((l) => l.startsWith('[crm]')))
    const reads = calls(w).filter((c) => c.includes('d1_migrations'))
    expect(reads[0]).toContain('CONTROL_DB')
  })
})

describe('the control marker in the bootstrap step (D7, D9)', () => {
  const ready = (o: Partial<WorldOptions> = {}) => world({ applied: [...EXPECTED_MIGRATIONS], appliedControl: [...CONTROL_EXPECTED], ...o })
  const control = (w: World) => openControlDb(w.control)
  const crmOrg = async () => (await readDeployment(db.d1))?.organizationId

  it('fresh instance, marker only (--auth none without operator flags): the marker follows the CRM deployment row and names its organisation', async () => {
    const order: string[] = []
    const w = world({ control: memoryControl(async () => void order.push(`control, crm row ${(await readDeployment(db.d1)) ? 'present' : 'absent'}`)) })
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(0)
    expect(order).toEqual(['control, crm row present'])
    expect(await readControlMarker(control(w))).toEqual({ organizationId: await crmOrg() })
    expect(rowOf(o, 'bootstrap').status).toBe('create')
  })

  it('fresh instance with an operator agent: the control marker is written too', async () => {
    const w = world()
    const argv = [...ACME, '--operator-agent', 'op', '--key-env', 'OP_KEY', '--owner-email', 'owner@example.com']
    await firstRun(w, argv)
    const o = await run(w, argv)
    expect(o.exitCode).toBe(0)
    expect(await readControlMarker(control(w))).toEqual({ organizationId: await crmOrg() })
  })

  it('an instance bootstrapped before this cycle (CRM row present, control marker missing) gets the marker, and a second run is ok with no write', async () => {
    const w = ready()
    await firstRun(w)
    await bootstrapD1(db.d1, { organizationName: 'acme', authProvider: 'none', authOrgId: 'acme', email: 'owner@example.com', agentName: 'op' })
    expect(await readControlMarker(control(w))).toBeNull()
    const o = await run(w)
    expect(o.exitCode).toBe(0)
    expect(rowOf(o, 'bootstrap').status).toBe('create')
    expect(await readControlMarker(control(w))).toEqual({ organizationId: await crmOrg() })
    const inserts = (w.control as ReturnType<typeof memoryControl>).inserts.length
    const again = await run(w)
    expect(rowOf(again, 'bootstrap').status).toBe('ok')
    expect((w.control as ReturnType<typeof memoryControl>).inserts.length).toBe(inserts)
  })

  it('a failing CRM write leaves no control marker', async () => {
    const failing: D1Like = {
      prepare: (q) => {
        const p = db.d1.prepare(q)
        return /insert into deployment/i.test(q) ? { ...p, bind: () => failing.prepare(q), run: async () => Promise.reject(new Error('crm write failed')) } as ReturnType<D1Like['prepare']> : p
      },
      batch: async (s) => (s.length > 0 && (await db.d1.prepare('select 1 as x from deployment').first()) === null ? Promise.reject(new Error('crm write failed')) : db.d1.batch(s)),
    }
    const w = world({ d1: failing })
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(await readControlMarker(control(w))).toBeNull()
  })

  it('a control marker for another organisation is refused with neither database written', async () => {
    const w = world()
    await writeControlMarker(control(w), OTHER)
    await firstRun(w)
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(rowOf(o, 'bootstrap').status).toBe('fail')
    expect(rowOf(o, 'bootstrap').detail).toContain(OTHER)
    expect(await readDeployment(db.d1)).toBeNull()
    expect(await readControlMarker(control(w))).toEqual({ organizationId: OTHER })
  })

  it('a control marker naming another organisation than the CRM row is refused (CRM row present)', async () => {
    const w = ready()
    await firstRun(w)
    await bootstrapD1(db.d1, { organizationName: 'acme', authProvider: 'none', authOrgId: 'acme', email: 'owner@example.com', agentName: 'op' })
    await writeControlMarker(control(w), OTHER)
    const o = await run(w)
    expect(rowOf(o, 'bootstrap').status).toBe('fail')
    expect(await readControlMarker(control(w))).toEqual({ organizationId: OTHER })
  })

  it('--dry-run reports the control marker it would write and writes nothing', async () => {
    const w = ready()
    await firstRun(w)
    await bootstrapD1(db.d1, { organizationName: 'acme', authProvider: 'none', authOrgId: 'acme', email: 'owner@example.com', agentName: 'op' })
    const o = await runSetup([...ACME, '--dry-run'], {}, w.deps)
    expect(rowOf(o, 'bootstrap').status).toBe('create')
    expect(rowOf(o, 'bootstrap').detail).toMatch(/control/)
    expect(await readControlMarker(control(w))).toBeNull()
  })
})
